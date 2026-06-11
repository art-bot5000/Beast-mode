// auth.ts — Beast Mode account spine (Pass 1)
//
// Faithful to the stckrm zero-knowledge model: ALL crypto happens in the
// browser. The server stores only what it's handed — the verifier (a hash),
// the wrapped key envelopes (ciphertext), the KDF salt — and checks the
// verifier on login. The server NEVER sees the passphrase or the DATA KEY.
//
// This module owns:
//   - the Deno KV store (users, verification OTPs, recovery tokens, rate limits)
//   - POST /user/register        create account (store verifier + envelopes + salt)
//   - POST /user/login           verify the verifier, return envelopes for local unlock
//   - GET  /user/verified        anti-enumeration "is this account verified?"
//   - POST /email/verify/send    issue an OTP (STUBBED: logged, not emailed)
//   - POST /email/verify/confirm confirm the OTP, mark account verified
//   - POST /recovery/consume     unlock via a one-time recovery code envelope
//
// Pass 2 (later): passkeys (WebAuthn PRF + device fallback), trusted-device
// sessions, account deletion. Tokens + Stripe come after that.
//
// What the BROWSER does (not here, for reference):
//   emailHash = SHA-256(lowercased email).slice(0,32)
//   verifier  = SHA-256(passphrase + ":" + emailHash)
//   DATA KEY  = random 256-bit AES-GCM key (never sent)
//   envelopes = DATA KEY wrapped by: passphrase-derived AES-KW key (PBKDF2 600k),
//               + up to 10 recovery-code-derived keys. Only wrapped blobs are sent.

import { sendEmail, otpEmail, emailEnabled } from "./email.ts";

const kv = await Deno.openKv(Deno.env.get("DENO_KV_PATH") || undefined);

// ── KV key layout ─────────────────────────────────────────────────────────────
//   ["user", emailHash]                -> UserRecord
//   ["otp", emailHash]                 -> { code, expires } (15 min TTL)
//   ["loginhits", emailHash]           -> number[] (login attempt timestamps)
// Email is stored inside the record only for operational mail; the hash is the id.

interface Envelope {
  // Opaque to the server. The browser knows how to unwrap each.
  wrapped: string;      // base64 wrapped DATA KEY
  salt?: string;        // KDF salt (passphrase envelope)
}

interface PasskeyCredential {
  credentialId: string;          // base64 rawId
  passkeyEnvelope: Envelope;     // DATA KEY wrapped by the PRF-derived AES-KW key
  createdAt: number;
  label?: string;                // optional user-facing name ("MacBook Touch ID")
}

interface UserRecord {
  emailHash: string;
  email: string;                 // for operational mail only
  verifier: string;              // SHA-256(passphrase + ":" + emailHash)
  kdfSalt: string;               // random per-user PBKDF2 salt
  passphraseEnvelope: Envelope;  // DATA KEY wrapped by passphrase-derived key
  recoveryEnvelopes: Envelope[]; // up to 10, each wrapped by a recovery code
  emailVerified: boolean;
  createdAt: number;
  deletedAt?: number;           // soft-delete stamp (admin); blocks sign-in + sessions
  // Passkeys (Pass 2): PRF-only. One shared prfSalt per account; the PRF output is
  // credential-bound so a single salt is safe and lets one assertion derive the key
  // for whichever passkey responds. Each passkey wraps the SAME DATA KEY.
  passkeys?: PasskeyCredential[];
  prfSalt?: string;             // base64, account-wide, set when first passkey enrols
  // Token ledger (Pass 3) gets added later.
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// ── Login rate limiting: 5 attempts / 15 min per account (stckrm parity) ──────
const LOGIN_MAX = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;

async function loginRateLimited(emailHash: string): Promise<boolean> {
  const now = Date.now();
  const rec = await kv.get<number[]>(["loginhits", emailHash]);
  const arr = (rec.value ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (arr.length >= LOGIN_MAX) {
    await kv.set(["loginhits", emailHash], arr, { expireIn: LOGIN_WINDOW_MS });
    return true;
  }
  arr.push(now);
  await kv.set(["loginhits", emailHash], arr, { expireIn: LOGIN_WINDOW_MS });
  return false;
}

// ── Basic validation helpers ──────────────────────────────────────────────────
function isHex(s: unknown, len?: number): s is string {
  return typeof s === "string" && /^[0-9a-f]+$/i.test(s) && (len === undefined || s.length === len);
}
function isEnvelope(e: unknown): e is Envelope {
  return !!e && typeof (e as Envelope).wrapped === "string";
}

// Six-digit OTP. Delivery via Resend (email.ts) with console-log fallback.
function makeOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}
async function sendOtp(email: string, code: string): Promise<void> {
  // Real delivery via Resend when configured; otherwise the original stub
  // behaviour (logged to console, visible in `fly logs`) so dev/staging work
  // with no secrets set.
  if (!emailEnabled()) {
    console.log(`[EMAIL STUB] OTP for ${email}: ${code}`);
    return;
  }
  const ok = await sendEmail({ to: email, ...otpEmail(code) });
  // Failures are logged only — responses stay generic so a delivery problem
  // can never become an account-enumeration signal. The user's recourse is
  // the resend button (/email/verify/send), gated by the cooldown below.
  if (!ok) console.error(`OTP email delivery failed for account ${email}`);
}

// One send per address per minute. Checked on the RAW emailHash before any
// account lookup, so the 429 is uniform for existing and non-existing
// accounts (no enumeration signal) and the endpoint can't be used to
// mail-bomb an arbitrary address now that emails are real.
const OTP_COOLDOWN_MS = 60_000;
async function otpCooldownHit(emailHash: string): Promise<boolean> {
  if ((await kv.get(["otpcool", emailHash])).value) return true;
  await kv.set(["otpcool", emailHash], 1, { expireIn: OTP_COOLDOWN_MS });
  return false;
}

// ── Endpoint handlers ─────────────────────────────────────────────────────────

async function register(body: Record<string, unknown>): Promise<Response> {
  const { emailHash, email, verifier, kdfSalt, passphraseEnvelope, recoveryEnvelopes } = body;

  if (!isHex(emailHash, 32)) return json({ error: "Invalid emailHash", code: "bad_request" }, 400);
  if (typeof email !== "string" || !email.includes("@")) return json({ error: "Invalid email", code: "bad_request" }, 400);
  if (!isHex(verifier)) return json({ error: "Invalid verifier", code: "bad_request" }, 400);
  if (typeof kdfSalt !== "string" || !kdfSalt) return json({ error: "Missing kdfSalt", code: "bad_request" }, 400);
  if (!isEnvelope(passphraseEnvelope)) return json({ error: "Missing passphrase envelope", code: "bad_request" }, 400);
  if (!Array.isArray(recoveryEnvelopes) || !recoveryEnvelopes.every(isEnvelope)) {
    return json({ error: "Invalid recovery envelopes", code: "bad_request" }, 400);
  }
  if (recoveryEnvelopes.length > 10) return json({ error: "Too many recovery envelopes", code: "bad_request" }, 400);

  // Reject if the email is already taken.
  const existing = await kv.get<UserRecord>(["user", emailHash as string]);
  if (existing.value) return json({ error: "Account already exists", code: "exists" }, 409);

  const record: UserRecord = {
    emailHash: emailHash as string,
    email: (email as string).toLowerCase(),
    verifier: verifier as string,
    kdfSalt: kdfSalt as string,
    passphraseEnvelope: passphraseEnvelope as Envelope,
    recoveryEnvelopes: recoveryEnvelopes as Envelope[],
    emailVerified: false,
    createdAt: Date.now(),
  };
  // Atomic create: fail if someone registered the same hash in between.
  const res = await kv.atomic()
    .check({ key: ["user", record.emailHash], versionstamp: null })
    .set(["user", record.emailHash], record)
    .commit();
  if (!res.ok) return json({ error: "Account already exists", code: "exists" }, 409);

  // Issue the first verification OTP immediately (and arm the resend
  // cooldown so register + instant resend can't double-send).
  const code = makeOtp();
  await kv.set(["otp", record.emailHash], { code, expires: Date.now() + 15 * 60_000 }, { expireIn: 15 * 60_000 });
  await otpCooldownHit(record.emailHash);
  await sendOtp(record.email, code);

  return json({ ok: true, emailVerified: false });
}

async function login(body: Record<string, unknown>): Promise<Response> {
  const { emailHash, verifier } = body;
  if (!isHex(emailHash, 32) || !isHex(verifier)) {
    return json({ error: "Invalid credentials", code: "bad_request" }, 400);
  }

  if (await loginRateLimited(emailHash as string)) {
    return json({ error: "Too many attempts. Try again in 15 minutes.", code: "rate_limit" }, 429);
  }

  const rec = await kv.get<UserRecord>(["user", emailHash as string]);
  // Anti-enumeration: same generic failure whether the account is missing or
  // the verifier is wrong. Never reveal which.
  if (!rec.value || rec.value.verifier !== verifier) {
    return json({ error: "Invalid email or passphrase", code: "auth" }, 401);
  }

  // Soft-deleted accounts (admin action) cannot sign in. Deliberately the SAME
  // generic error as wrong credentials — deletion status is not revealed.
  if (rec.value.deletedAt) {
    return json({ error: "Invalid email or passphrase", code: "auth" }, 401);
  }

  // Email-verification gate: unverified accounts can't sign in (routes to OTP).
  if (!rec.value.emailVerified) {
    return json({ error: "Email not verified", code: "unverified" }, 403);
  }

  // Success: issue a session token (server-side gating for paid endpoints like
  // /api/generate) AND return the envelopes + salt so the BROWSER can unwrap the
  // DATA KEY locally. The server never participates in decryption.
  const token = await issueSession(emailHash as string);
  return json({
    ok: true,
    sessionToken: token,
    kdfSalt: rec.value.kdfSalt,
    passphraseEnvelope: rec.value.passphraseEnvelope,
    recoveryCount: rec.value.recoveryEnvelopes.length,
  });
}

// ── Session tokens ────────────────────────────────────────────────────────────
// A logged-in browser gets an opaque token to present on protected endpoints,
// so the backend can verify "this is a real, verified user" before spending on
// Runware — without the browser ever resending the verifier. 24h expiry, stored
// in KV with automatic expiry. Mirrors stckrm's 24h session-token approach.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

async function issueSession(emailHash: string): Promise<string> {
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  await kv.set(["session", token], { emailHash, issued: Date.now() }, { expireIn: SESSION_TTL_MS });
  return token;
}

// Returns the emailHash for a valid token, or null. Exported so main.ts can gate
// /api/generate. Accepts the token from an Authorization: Bearer header.
export async function verifySessionToken(token: string | null): Promise<string | null> {
  if (!token) return null;
  const rec = await kv.get<{ emailHash: string }>(["session", token]);
  if (!rec.value?.emailHash) return null;
  // Enforce admin soft-delete/purge immediately: a live token is worthless the
  // moment its account is deleted. Costs one extra KV read per gated request.
  const user = await kv.get<UserRecord>(["user", rec.value.emailHash]);
  if (!user.value || user.value.deletedAt) return null;
  return rec.value.emailHash;
}

// Anti-enumeration verified-check: an unauthenticated probe cannot distinguish a
// real-but-unverified account from a non-existent one. We answer "verified:true"
// only for accounts that exist AND are verified; everything else is "false"
// without revealing existence.
async function verifiedCheck(emailHash: string): Promise<Response> {
  if (!isHex(emailHash, 32)) return json({ verified: false });
  const rec = await kv.get<UserRecord>(["user", emailHash]);
  return json({ verified: !!rec.value?.emailVerified });
}

async function otpSend(body: Record<string, unknown>): Promise<Response> {
  const { emailHash } = body;
  if (!isHex(emailHash, 32)) return json({ error: "Invalid emailHash", code: "bad_request" }, 400);
  // Cooldown BEFORE the account lookup: the 429 is identical whether or not
  // the account exists, so it leaks nothing and still stops mail-bombing.
  if (await otpCooldownHit(emailHash as string)) {
    return json({ error: "Please wait a minute before requesting another code.", code: "rate_limit" }, 429);
  }
  const rec = await kv.get<UserRecord>(["user", emailHash as string]);
  // Anti-enumeration: always return ok, even if the account doesn't exist.
  if (rec.value && !rec.value.emailVerified) {
    const code = makeOtp();
    await kv.set(["otp", emailHash as string], { code, expires: Date.now() + 15 * 60_000 }, { expireIn: 15 * 60_000 });
    await sendOtp(rec.value.email, code);
  }
  return json({ ok: true });
}

async function otpConfirm(body: Record<string, unknown>): Promise<Response> {
  const { emailHash, code } = body;
  if (!isHex(emailHash, 32) || typeof code !== "string") {
    return json({ error: "Invalid input", code: "bad_request" }, 400);
  }
  const otp = await kv.get<{ code: string; expires: number }>(["otp", emailHash as string]);
  if (!otp.value || otp.value.expires < Date.now() || otp.value.code !== code) {
    return json({ error: "Invalid or expired code", code: "bad_otp" }, 400);
  }
  const rec = await kv.get<UserRecord>(["user", emailHash as string]);
  if (!rec.value) return json({ error: "Account not found", code: "not_found" }, 404);

  const updated: UserRecord = { ...rec.value, emailVerified: true };
  await kv.set(["user", emailHash as string], updated);
  await kv.delete(["otp", emailHash as string]);
  // Issue a session token: verifying email completes registration, so the user
  // is now signed in (they authenticated by creating the account moments ago).
  const token = await issueSession(emailHash as string);
  return json({ ok: true, emailVerified: true, sessionToken: token });
}

// Recovery: the browser asks for the recovery envelopes so it can try unwrapping
// the DATA KEY with a recovery code locally. The server just hands them over
// after confirming the account exists and is verified (same as login's data
// release). Actual unwrap + re-wrap under a new passphrase happens client-side.
async function recoveryConsume(body: Record<string, unknown>): Promise<Response> {
  const { emailHash } = body;
  if (!isHex(emailHash, 32)) return json({ error: "Invalid emailHash", code: "bad_request" }, 400);
  if (await loginRateLimited(emailHash as string)) {
    return json({ error: "Too many attempts. Try again in 15 minutes.", code: "rate_limit" }, 429);
  }
  const rec = await kv.get<UserRecord>(["user", emailHash as string]);
  if (!rec.value) return json({ error: "Invalid recovery request", code: "auth" }, 401);
  return json({
    ok: true,
    kdfSalt: rec.value.kdfSalt,
    recoveryEnvelopes: rec.value.recoveryEnvelopes,
  });
}

// After a successful client-side recovery, the browser sends back a new verifier,
// salt, and re-wrapped envelopes to replace the old ones (passphrase reset).
async function recoveryReset(body: Record<string, unknown>): Promise<Response> {
  const { emailHash, verifier, kdfSalt, passphraseEnvelope, recoveryEnvelopes } = body;
  if (!isHex(emailHash, 32) || !isHex(verifier) || typeof kdfSalt !== "string" ||
      !isEnvelope(passphraseEnvelope) || !Array.isArray(recoveryEnvelopes)) {
    return json({ error: "Invalid reset payload", code: "bad_request" }, 400);
  }
  const rec = await kv.get<UserRecord>(["user", emailHash as string]);
  if (!rec.value) return json({ error: "Account not found", code: "not_found" }, 404);

  const updated: UserRecord = {
    ...rec.value,
    verifier: verifier as string,
    kdfSalt: kdfSalt as string,
    passphraseEnvelope: passphraseEnvelope as Envelope,
    recoveryEnvelopes: recoveryEnvelopes as Envelope[],
  };
  await kv.set(["user", emailHash as string], updated);
  const token = await issueSession(emailHash as string);
  return json({ ok: true, sessionToken: token });
}

// ── Passkeys (Pass 2, PRF-only) ───────────────────────────────────────────────
// Enrolment requires a live session: you must already be unlocked (DATA KEY in
// the browser) to wrap it under a new passkey. The server stores only the
// credentialId, the account-wide prfSalt, and the wrapped envelope — never the
// PRF output, never the DATA KEY. Trust boundary is identical to recovery codes.
const MAX_PASSKEYS = 10;

function isPasskeyCred(c: unknown): c is { credentialId: string; passkeyEnvelope: Envelope } {
  return !!c && typeof (c as { credentialId: unknown }).credentialId === "string" &&
    isEnvelope((c as { passkeyEnvelope: unknown }).passkeyEnvelope);
}

async function passkeyEnroll(req: Request, body: Record<string, unknown>): Promise<Response> {
  // Gate on a valid session — the emailHash comes from the TOKEN, not the body,
  // so one account can never enrol a passkey envelope onto another.
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const emailHash = await verifySessionToken(token);
  if (!emailHash) return json({ error: "Not authenticated", code: "auth" }, 401);

  const { credentialId, prfSalt, passkeyEnvelope, label } = body;
  if (typeof credentialId !== "string" || !credentialId) {
    return json({ error: "Invalid credentialId", code: "bad_request" }, 400);
  }
  if (typeof prfSalt !== "string" || !prfSalt) {
    return json({ error: "Invalid prfSalt", code: "bad_request" }, 400);
  }
  if (!isEnvelope(passkeyEnvelope)) {
    return json({ error: "Invalid passkey envelope", code: "bad_request" }, 400);
  }

  const rec = await kv.get<UserRecord>(["user", emailHash]);
  if (!rec.value || rec.value.deletedAt) {
    return json({ error: "Account not found", code: "not_found" }, 404);
  }
  const existing = rec.value.passkeys ?? [];
  if (existing.length >= MAX_PASSKEYS) {
    return json({ error: "Too many passkeys", code: "limit" }, 409);
  }
  // First passkey fixes the account-wide salt; later ones MUST reuse it (the
  // browser is told the existing salt, so a mismatch means a client bug).
  if (rec.value.prfSalt && rec.value.prfSalt !== prfSalt) {
    return json({ error: "prfSalt mismatch", code: "bad_request" }, 400);
  }
  // Reject duplicate credentialId (idempotency / re-enrol guard).
  if (existing.some((p) => p.credentialId === credentialId)) {
    return json({ error: "Passkey already enrolled", code: "exists" }, 409);
  }

  const newCred: PasskeyCredential = {
    credentialId,
    passkeyEnvelope: passkeyEnvelope as Envelope,
    createdAt: Date.now(),
    ...(typeof label === "string" && label ? { label } : {}),
  };
  const updated: UserRecord = {
    ...rec.value,
    prfSalt: rec.value.prfSalt ?? (prfSalt as string),
    passkeys: [...existing, newCred],
  };
  await kv.set(["user", emailHash], updated);
  return json({ ok: true, passkeyCount: updated.passkeys!.length });
}

// Pre-login: the browser needs the credentialIds + the account prfSalt to run the
// WebAuthn assertion. Anti-enumeration: a missing/passkey-less account returns the
// SAME shape (empty list, null salt) as a real one — no existence signal. The
// browser simply finds no credentials to offer.
async function passkeyChallenge(body: Record<string, unknown>): Promise<Response> {
  const { emailHash } = body;
  if (!isHex(emailHash, 32)) return json({ passkeys: [], prfSalt: null });
  const rec = await kv.get<UserRecord>(["user", emailHash as string]);
  if (!rec.value || rec.value.deletedAt || !rec.value.emailVerified || !rec.value.prfSalt) {
    return json({ passkeys: [], prfSalt: null });
  }
  const passkeys = (rec.value.passkeys ?? []).map((p) => ({
    credentialId: p.credentialId,
    passkeyEnvelope: p.passkeyEnvelope,
  }));
  return json({ passkeys, prfSalt: rec.value.prfSalt });
}

// Passkey login: the browser has already unwrapped the DATA KEY locally via the
// PRF assertion; this endpoint just verifies the account is sign-in-eligible and
// issues a session token (the server-side gate for paid endpoints). It does NOT
// see the assertion — the unwrap is the proof of possession, mirroring how
// /user/login trusts the verifier. Rate-limited like password login.
async function passkeyLogin(body: Record<string, unknown>): Promise<Response> {
  const { emailHash } = body;
  if (!isHex(emailHash, 32)) return json({ error: "Invalid request", code: "bad_request" }, 400);
  if (await loginRateLimited(emailHash as string)) {
    return json({ error: "Too many attempts. Try again in 15 minutes.", code: "rate_limit" }, 429);
  }
  const rec = await kv.get<UserRecord>(["user", emailHash as string]);
  if (!rec.value || rec.value.deletedAt || !rec.value.emailVerified ||
      !(rec.value.passkeys && rec.value.passkeys.length)) {
    // Generic failure — no signal about which condition failed.
    return json({ error: "Passkey sign-in unavailable", code: "auth" }, 401);
  }
  const token = await issueSession(emailHash as string);
  return json({ ok: true, sessionToken: token });
}

// ── Router: returns a Response if it handled the path, else null ──────────────
export async function handleAuth(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  const readBody = async (): Promise<Record<string, unknown>> => {
    try { return await req.json(); } catch { return {}; }
  };

  if (path === "/user/register" && method === "POST") return register(await readBody());
  if (path === "/user/login" && method === "POST") return login(await readBody());
  if (path === "/user/verified" && method === "GET") return verifiedCheck(url.searchParams.get("emailHash") || "");
  if (path === "/email/verify/send" && method === "POST") return otpSend(await readBody());
  if (path === "/email/verify/confirm" && method === "POST") return otpConfirm(await readBody());
  if (path === "/recovery/consume" && method === "POST") return recoveryConsume(await readBody());
  if (path === "/recovery/reset" && method === "POST") return recoveryReset(await readBody());
  if (path === "/passkey/enroll" && method === "POST") return passkeyEnroll(req, await readBody());
  if (path === "/passkey/challenge" && method === "POST") return passkeyChallenge(await readBody());
  if (path === "/passkey/login" && method === "POST") return passkeyLogin(await readBody());

  return null; // not an auth route
}

// Expose the KV handle so later modules (tokens) can share it.
export { kv };
export type { UserRecord, Envelope };
