// admin.ts — Beast Mode admin spine (stckrm pattern)
//
// Independent protection layer, deliberately separate from user auth:
//   1. Handshake: master ADMIN_SECRET + emailed OTP. After that, requests
//      carry only a short-lived ADMIN TOKEN, never the master secret again.
//   2. Admin tokens are IP-BOUND and expire after 15 minutes (KV expireIn).
//   3. Every state-changing action lands in a 90-day AUDIT LOG.
//   4. Body convention (matches the stckrm admin page): handshake endpoints
//      take { adminSecret, ... }; everything else takes { adminToken, ... }.
//
// Soft-degrade (house pattern): ADMIN_SECRET unset → every /admin endpoint
// returns 503. ADMIN_EMAIL unset → the OTP is console-logged (fly logs),
// same fallback as user verification. Set with:
//   fly secrets set ADMIN_SECRET=<long-random> ADMIN_EMAIL=you@example.com --app beast-mode
// Do NOT add either to REQUIRED_SECRETS until set in prod.
//
// DELETE vs PURGE:
//   delete  = soft: stamps deletedAt on the UserRecord. Sign-in is blocked
//             (generic auth error — deletion is not revealed) and existing
//             session tokens stop validating. Fully reversible via restore.
//   restore = clears deletedAt.
//   purge   = hard: removes the user record, OTPs, cooldowns, rate-limit
//             counters, and sweeps their session tokens. Requires the
//             literal confirm string "PURGE". Irreversible. (R2 gen-cache
//             images age out on their own via the FIFO trim; durable copies
//             live in the user's own Drive/Dropbox which we never touch.)

import { kv, type UserRecord } from "./auth.ts";
import { emailEnabled, sendEmail } from "./email.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const ADMIN_TOKEN_TTL_MS = 15 * 60_000; // matches the stckrm page's 15-min timer
const ADMIN_OTP_TTL_MS = 10 * 60_000;

function adminEnabled(): boolean {
  return !!Deno.env.get("ADMIN_SECRET");
}

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  return xff ? xff.split(",")[0].trim() : "unknown";
}

// Constant-time-ish secret comparison: compare SHA-256 digests byte-wise so
// length and prefix information never shapes the timing profile.
async function secretMatches(candidate: unknown): Promise<boolean> {
  const real = Deno.env.get("ADMIN_SECRET");
  if (!real || typeof candidate !== "string" || !candidate) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(candidate)),
    crypto.subtle.digest("SHA-256", enc.encode(real)),
  ]);
  const av = new Uint8Array(a), bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

// ── Handshake rate limit: 5 attempts / 15 min per IP ─────────────────────────
async function adminRateLimited(ip: string): Promise<boolean> {
  const key = ["adminhits", ip];
  const now = Date.now();
  const rec = await kv.get<number[]>(key);
  const hits = (rec.value ?? []).filter((t) => now - t < 15 * 60_000);
  if (hits.length >= 5) return true;
  hits.push(now);
  await kv.set(key, hits, { expireIn: 15 * 60_000 });
  return false;
}

// ── Audit log: 90-day retention via KV expiry ────────────────────────────────
async function audit(action: string, target: string, ip: string, detail = ""): Promise<void> {
  await kv.set(
    ["audit", Date.now(), crypto.randomUUID()],
    { at: new Date().toISOString(), action, target, ip, detail },
    { expireIn: 90 * 24 * 60 * 60_000 },
  );
}

// ── Token issue / verify (IP-bound) ──────────────────────────────────────────
async function issueAdminToken(ip: string): Promise<string> {
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  await kv.set(["admintoken", token], { ip, issued: Date.now() }, { expireIn: ADMIN_TOKEN_TTL_MS });
  return token;
}

// Returns null when the token is valid for this IP; otherwise the 401 Response.
async function requireAdmin(req: Request, body: Record<string, unknown>): Promise<Response | null> {
  const token = body.adminToken;
  if (typeof token !== "string" || !token) {
    return json({ error: "Admin session required", code: "auth" }, 401);
  }
  const rec = await kv.get<{ ip: string }>(["admintoken", token]);
  if (!rec.value) return json({ error: "Session expired — sign in again", code: "auth" }, 401);
  if (rec.value.ip !== clientIp(req)) {
    // IP changed mid-session: kill the token outright (stckrm's binding rule).
    await kv.delete(["admintoken", token]);
    return json({ error: "Session invalidated", code: "auth" }, 401);
  }
  return null;
}

// ── Handshake step 1: secret → OTP to the admin inbox ────────────────────────
async function otpSendHandler(req: Request, body: Record<string, unknown>): Promise<Response> {
  const ip = clientIp(req);
  if (await adminRateLimited(ip)) {
    return json({ error: "Too many attempts. Try again in 15 minutes.", code: "rate_limit" }, 429);
  }
  if (!(await secretMatches(body.adminSecret))) {
    await audit("admin.login.fail", "-", ip);
    return json({ error: "Invalid admin secret", code: "auth" }, 401);
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await kv.set(["adminotp"], { code }, { expireIn: ADMIN_OTP_TTL_MS });

  const adminEmail = Deno.env.get("ADMIN_EMAIL");
  if (adminEmail && emailEnabled()) {
    const ok = await sendEmail({
      to: adminEmail,
      subject: `${code} — Beast Mode ADMIN sign-in`,
      text: `Beast Mode admin sign-in code: ${code}\n\nExpires in 10 minutes. Request came from IP ${ip}.\nIf this wasn't you, rotate ADMIN_SECRET immediately.`,
      html: `<p>Beast Mode <strong>admin</strong> sign-in code:</p>
<p style="font-size:28px;font-weight:800;letter-spacing:8px;">${code}</p>
<p>Expires in 10 minutes. Request came from IP <code>${ip}</code>.<br>
If this wasn't you, rotate ADMIN_SECRET immediately.</p>`,
    });
    if (!ok) console.error("Admin OTP email delivery failed — code is in this log line fallback below.");
    if (!ok) console.log(`[ADMIN OTP fallback] ${code}`);
  } else {
    console.log(`[ADMIN OTP] ${code} (set ADMIN_EMAIL + Resend secrets for email delivery)`);
  }
  await audit("admin.otp.sent", "-", ip);
  return json({ ok: true });
}

// ── Handshake step 2: secret + OTP → token ───────────────────────────────────
async function otpVerifyHandler(req: Request, body: Record<string, unknown>): Promise<Response> {
  const ip = clientIp(req);
  if (await adminRateLimited(ip)) {
    return json({ error: "Too many attempts. Try again in 15 minutes.", code: "rate_limit" }, 429);
  }
  if (!(await secretMatches(body.adminSecret))) {
    return json({ error: "Invalid admin secret", code: "auth" }, 401);
  }
  const otp = await kv.get<{ code: string }>(["adminotp"]);
  if (!otp.value || typeof body.otp !== "string" || otp.value.code !== body.otp) {
    await audit("admin.otp.fail", "-", ip);
    return json({ error: "Invalid or expired code", code: "bad_otp" }, 401);
  }
  await kv.delete(["adminotp"]); // single-use
  const token = await issueAdminToken(ip);
  await audit("admin.login", "-", ip);
  return json({ ok: true, adminToken: token, expiresInMs: ADMIN_TOKEN_TTL_MS });
}

// ── Account management ────────────────────────────────────────────────────────
async function listAccounts(): Promise<Response> {
  const accounts: Record<string, unknown>[] = [];
  for await (const entry of kv.list<UserRecord>({ prefix: ["user"] }, { limit: 1000 })) {
    const u = entry.value;
    accounts.push({
      emailHash: u.emailHash,
      email: u.email,
      emailVerified: !!u.emailVerified,
      createdAt: u.createdAt,
      deletedAt: u.deletedAt ?? null,
      recoveryEnvelopes: u.recoveryEnvelopes?.length ?? 0,
    });
  }
  accounts.sort((a, b) => (b.createdAt as number) - (a.createdAt as number));
  return json({ ok: true, accounts });
}

async function softDelete(body: Record<string, unknown>, ip: string): Promise<Response> {
  const emailHash = body.emailHash;
  if (typeof emailHash !== "string") return json({ error: "emailHash required", code: "bad_request" }, 400);
  const rec = await kv.get<UserRecord>(["user", emailHash]);
  if (!rec.value) return json({ error: "Account not found", code: "not_found" }, 404);
  if (rec.value.deletedAt) return json({ ok: true, alreadyDeleted: true });
  await kv.set(["user", emailHash], { ...rec.value, deletedAt: Date.now() });
  await audit("account.delete", emailHash, ip);
  return json({ ok: true });
}

async function restoreAccount(body: Record<string, unknown>, ip: string): Promise<Response> {
  const emailHash = body.emailHash;
  if (typeof emailHash !== "string") return json({ error: "emailHash required", code: "bad_request" }, 400);
  const rec = await kv.get<UserRecord>(["user", emailHash]);
  if (!rec.value) return json({ error: "Account not found", code: "not_found" }, 404);
  if (!rec.value.deletedAt) return json({ ok: true, notDeleted: true });
  const { deletedAt: _drop, ...rest } = rec.value as UserRecord & { deletedAt?: number };
  await kv.set(["user", emailHash], rest);
  await audit("account.restore", emailHash, ip);
  return json({ ok: true });
}

async function purgeAccount(body: Record<string, unknown>, ip: string): Promise<Response> {
  const emailHash = body.emailHash;
  if (typeof emailHash !== "string") return json({ error: "emailHash required", code: "bad_request" }, 400);
  if (body.confirm !== "PURGE") {
    return json({ error: 'Confirmation required: pass confirm:"PURGE"', code: "confirm" }, 400);
  }
  const rec = await kv.get<UserRecord>(["user", emailHash]);
  if (!rec.value) return json({ error: "Account not found", code: "not_found" }, 404);

  await kv.delete(["user", emailHash]);
  await kv.delete(["otp", emailHash]);
  await kv.delete(["otpcool", emailHash]);
  await kv.delete(["loginhits", emailHash]);
  // Sweep this user's session tokens (sessions are keyed by token, so scan).
  let sessions = 0;
  for await (const s of kv.list<{ emailHash: string }>({ prefix: ["session"] })) {
    if (s.value?.emailHash === emailHash) {
      await kv.delete(s.key);
      sessions++;
    }
  }
  await audit("account.purge", emailHash, ip, `sessions swept: ${sessions}`);
  return json({ ok: true, sessionsSwept: sessions });
}

async function auditLog(body: Record<string, unknown>): Promise<Response> {
  const limit = Math.min(500, Math.max(1, Number(body.limit) || 100));
  const entries: unknown[] = [];
  // Newest first: audit keys are ["audit", timestamp, uuid].
  for await (const e of kv.list({ prefix: ["audit"] }, { reverse: true, limit })) {
    entries.push(e.value);
  }
  return json({ ok: true, entries });
}

// ── Router: main.ts delegates every /admin/* request here ────────────────────
export async function handleAdmin(req: Request, path: string): Promise<Response> {
  if (!adminEnabled()) {
    return json({ error: "Admin is not configured on this deployment", code: "unavailable" }, 503);
  }
  if (req.method !== "POST") return json({ error: "POST only", code: "bad_request" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body", code: "bad_request" }, 400);
  }

  // Handshake endpoints (master secret, no token yet)
  if (path === "/admin/otp/send") return otpSendHandler(req, body);
  if (path === "/admin/otp/verify") return otpVerifyHandler(req, body);

  // Everything below requires a live, IP-matched admin token.
  const denied = await requireAdmin(req, body);
  if (denied) return denied;
  const ip = clientIp(req);

  switch (path) {
    case "/admin/list-accounts":
      return listAccounts();
    case "/admin/delete-account":
      return softDelete(body, ip);
    case "/admin/restore-account":
      return restoreAccount(body, ip);
    case "/admin/purge-account":
      return purgeAccount(body, ip);
    case "/admin/audit-log":
      return auditLog(body);
    case "/admin/sign-out": {
      await kv.delete(["admintoken", body.adminToken as string]);
      return json({ ok: true });
    }
    default:
      return json({ error: "Unknown admin endpoint", code: "not_found" }, 404);
  }
}
