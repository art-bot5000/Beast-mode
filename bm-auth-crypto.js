// bm-auth-crypto.js
//
// Browser-side zero-knowledge crypto for Beast Mode accounts. THIS is what makes
// the server's zero-knowledge guarantee real: the passphrase and the DATA KEY
// never leave this file's scope unencrypted. The server only ever receives the
// emailHash, the verifier (a hash), the kdfSalt, and wrapped envelopes.
//
// Must match auth.ts exactly:
//   emailHash = SHA-256(lowercased email) -> first 32 hex chars
//   verifier  = SHA-256(passphrase + ":" + emailHash)            (full hex)
//   wrapKey   = PBKDF2(passphrase + ":" + emailHash, salt, 600k, SHA-256) -> AES-KW
//   DATA KEY  = random 256-bit AES-GCM key, wrapped by wrapKey (+ recovery keys)
//
// All crypto via WebCrypto (SubtleCrypto). No external deps.

const PBKDF2_ITERS = 600_000;           // stckrm parity
const te = new TextEncoder();

// ── hashing / hex helpers ─────────────────────────────────────────────────────
function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBuf(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}
function bufToB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b64ToBuf(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function sha256Hex(str) {
  return bufToHex(await crypto.subtle.digest("SHA-256", te.encode(str)));
}

// ── identity values the server sees ───────────────────────────────────────────
export async function computeEmailHash(email) {
  const full = await sha256Hex(email.trim().toLowerCase());
  return full.slice(0, 32); // first 32 hex chars, matching auth.ts
}
export async function computeVerifier(passphrase, emailHash) {
  return sha256Hex(passphrase + ":" + emailHash);
}

// ── KDF: passphrase -> AES-KW wrapping key ────────────────────────────────────
async function deriveWrapKey(passphrase, emailHash, saltBuf) {
  const base = await crypto.subtle.importKey(
    "raw", te.encode(passphrase + ":" + emailHash), "PBKDF2", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBuf, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    base,
    { name: "AES-KW", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

// Derive an AES-KW key from a recovery code (no per-user salt needed; the code
// itself is high-entropy. We still bind it to emailHash to prevent cross-account
// reuse, and use a fixed lower iteration count since recovery codes are random).
async function deriveRecoveryKey(code, emailHash) {
  const base = await crypto.subtle.importKey(
    "raw", te.encode(code + ":" + emailHash), "PBKDF2", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: te.encode("bm-recovery:" + emailHash), iterations: 200_000, hash: "SHA-256" },
    base,
    { name: "AES-KW", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

// ── DATA KEY generation + wrapping ────────────────────────────────────────────
async function generateDataKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

async function wrapDataKey(dataKey, wrapKey) {
  const wrapped = await crypto.subtle.wrapKey("raw", dataKey, wrapKey, "AES-KW");
  return bufToB64(wrapped);
}
async function unwrapDataKey(wrappedB64, wrapKey) {
  return crypto.subtle.unwrapKey(
    "raw", b64ToBuf(wrappedB64), wrapKey, "AES-KW",
    { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"],
  );
}

// ── recovery codes ────────────────────────────────────────────────────────────
// 10 human-friendly codes, e.g. "BM4K-9XQ2-7HPN". Shown ONCE at registration.
export function generateRecoveryCodes(n = 10) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I ambiguity
  const codes = [];
  for (let i = 0; i < n; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    let s = "";
    for (let j = 0; j < 12; j++) {
      s += alphabet[bytes[j] % alphabet.length];
      if (j === 3 || j === 7) s += "-";
    }
    codes.push("BM" + s.slice(2)); // light branding prefix
  }
  return codes;
}

// ── public API: build a full registration payload ─────────────────────────────
// Returns the values the server stores + the recovery codes to SHOW the user.
export async function buildRegistration(email, passphrase) {
  const emailHash = await computeEmailHash(email);
  const verifier = await computeVerifier(passphrase, emailHash);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kdfSalt = bufToB64(salt);

  const dataKey = await generateDataKey();

  // Passphrase envelope
  const wrapKey = await deriveWrapKey(passphrase, emailHash, salt);
  const passphraseEnvelope = { wrapped: await wrapDataKey(dataKey, wrapKey), salt: kdfSalt };

  // Recovery envelopes (10)
  const recoveryCodes = generateRecoveryCodes(10);
  const recoveryEnvelopes = [];
  for (const code of recoveryCodes) {
    const rk = await deriveRecoveryKey(code, emailHash);
    recoveryEnvelopes.push({ wrapped: await wrapDataKey(dataKey, rk) });
  }

  return {
    serverPayload: { emailHash, email, verifier, kdfSalt, passphraseEnvelope, recoveryEnvelopes },
    recoveryCodes, // SHOW ONCE, never sent in raw form
    dataKey,       // keep in memory for this session
  };
}

// ── public API: unlock the DATA KEY after login ───────────────────────────────
// Given the passphrase + the envelope/salt the server returned, recover the key.
export async function unlockWithPassphrase(passphrase, emailHash, kdfSalt, passphraseEnvelope) {
  const salt = b64ToBuf(kdfSalt);
  const wrapKey = await deriveWrapKey(passphrase, emailHash, salt);
  return unwrapDataKey(passphraseEnvelope.wrapped, wrapKey); // throws if wrong passphrase
}

// ── public API: unlock via a recovery code (account recovery) ─────────────────
// Tries the code against each recovery envelope until one unwraps.
export async function unlockWithRecoveryCode(code, emailHash, recoveryEnvelopes) {
  const rk = await deriveRecoveryKey(code.trim().toUpperCase(), emailHash);
  for (const env of recoveryEnvelopes) {
    try {
      return await unwrapDataKey(env.wrapped, rk); // success
    } catch { /* try next envelope */ }
  }
  throw new Error("Recovery code did not match any envelope");
}

// ── public API: re-wrap after recovery (set a new passphrase) ─────────────────
// After recovery unlocks the DATA KEY, the user sets a new passphrase; we build
// fresh envelopes + verifier to send to /recovery/reset.
export async function buildPassphraseReset(email, newPassphrase, dataKey, recoveryCodes) {
  const emailHash = await computeEmailHash(email);
  const verifier = await computeVerifier(newPassphrase, emailHash);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kdfSalt = bufToB64(salt);
  const wrapKey = await deriveWrapKey(newPassphrase, emailHash, salt);
  const passphraseEnvelope = { wrapped: await wrapDataKey(dataKey, wrapKey), salt: kdfSalt };

  // Re-wrap recovery envelopes too (so old codes are invalidated and new ones issued)
  const newCodes = recoveryCodes || generateRecoveryCodes(10);
  const recoveryEnvelopes = [];
  for (const code of newCodes) {
    const rk = await deriveRecoveryKey(code, emailHash);
    recoveryEnvelopes.push({ wrapped: await wrapDataKey(dataKey, rk) });
  }
  return {
    serverPayload: { emailHash, verifier, kdfSalt, passphraseEnvelope, recoveryEnvelopes },
    recoveryCodes: newCodes,
  };
}

// ── Passkeys (WebAuthn PRF) ───────────────────────────────────────────────────
// PRF-only design (no device fallback): a passkey is a FOURTH way to unwrap the
// SAME DATA KEY, exactly like a recovery code. The authenticator's PRF extension
// returns 32 bytes of high-entropy secret bound to (credential, prfSalt). We
// HKDF that into an AES-KW key and wrap the DATA KEY with it. The server stores
// only { credentialId, prfSalt, wrapped } — never the PRF output, never the key.
// If the authenticator doesn't support PRF, enrolment is refused (see HTML).
//
// rpId is the registrable domain; we use location.hostname so staging/prod each
// scope their own credentials. The PRF salt is per-credential random, stored
// server-side and replayed at assertion time so the SAME secret re-derives.

const PRF_INFO = te.encode("bm-passkey-prf-v1");

// HKDF-SHA256(prfOutput) -> AES-KW key. prfOutput is already uniform 32 bytes,
// so HKDF (not PBKDF2) is correct: no stretching needed, just domain separation.
async function derivePrfWrapKey(prfOutput, emailHash) {
  const base = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: te.encode("bm-passkey:" + emailHash), info: PRF_INFO },
    base,
    { name: "AES-KW", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

// Feature-detect: PRF requires WebAuthn + a platform that surfaces the extension.
// We can't fully know until enrolment returns results.prf, but we can gate on the
// API existing at all so the UI hides the button on unsupported browsers.
export function passkeySupported() {
  return typeof PublicKeyCredential !== "undefined" &&
    typeof navigator !== "undefined" && !!navigator.credentials;
}

// ── public API: enrol a passkey (called when already unlocked, dataKey in hand) ─
// Creates a credential WITH the prf extension, evaluates it against the account's
// salt (shared across the account's passkeys — caller passes the existing salt,
// or null to mint one for the first passkey), derives the wrap key, and wraps the
// in-memory DATA KEY. Returns the envelope + credential metadata + the salt for
// the server. THROWS code "PRF_UNSUPPORTED" if the authenticator didn't honour
// the extension — caller surfaces a clear message.
export async function enrollPasskey(email, emailHash, dataKey, existingPrfSalt) {
  const prfSaltBuf = existingPrfSalt
    ? b64ToBuf(existingPrfSalt)
    : crypto.getRandomValues(new Uint8Array(32));
  const userId = hexToBuf(emailHash); // 16 bytes, stable per account

  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { id: location.hostname, name: "Beast Mode" },
      user: { id: userId, name: email, displayName: email },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },   // ES256
        { type: "public-key", alg: -257 }, // RS256
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: { prf: { eval: { first: prfSaltBuf } } },
    },
  });
  if (!cred) throw new Error("Passkey creation cancelled");

  const ext = cred.getClientExtensionResults();
  const prf = ext && ext.prf && ext.prf.results && ext.prf.results.first;
  if (!prf) {
    const e = new Error("Authenticator does not support PRF");
    e.code = "PRF_UNSUPPORTED";
    throw e;
  }

  const wrapKey = await derivePrfWrapKey(new Uint8Array(prf), emailHash);
  const wrapped = await wrapDataKey(dataKey, wrapKey);

  return {
    credentialId: bufToB64(cred.rawId),
    prfSalt: bufToB64(prfSaltBuf),
    passkeyEnvelope: { wrapped },
  };
}

// ── public API: unlock the DATA KEY via passkey (login) ───────────────────────
// Given the credentialId + prfSalt + envelope the server returned for this
// account, run an assertion, re-derive the PRF secret, and unwrap the DATA KEY.
// allowCredentials may be empty for a discoverable-credential (usernameless)
// flow, but we pass the known id so the right passkey is selected directly.
export async function unlockWithPasskey(emailHash, prfSalt, passkeyCreds) {
  // prfSalt: per-account base64 salt (same for all of this account's passkeys —
  //   the PRF output is already credential-bound, so one salt is safe and lets a
  //   single assertion derive the right key regardless of which passkey responds).
  // passkeyCreds: [{ credentialId, passkeyEnvelope:{wrapped} }]
  const allow = passkeyCreds.map((c) => ({ type: "public-key", id: b64ToBuf(c.credentialId) }));
  const saltBuf = b64ToBuf(prfSalt);

  const assertion = await navigator.credentials.get({
    publicKey: {
      rpId: location.hostname,
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: allow,
      userVerification: "required",
      extensions: { prf: { eval: { first: saltBuf } } },
    },
  });
  if (!assertion) throw new Error("Passkey assertion cancelled");

  const ext = assertion.getClientExtensionResults();
  const prf = ext && ext.prf && ext.prf.results && ext.prf.results.first;
  if (!prf) {
    const e = new Error("Authenticator did not return PRF output");
    e.code = "PRF_UNSUPPORTED";
    throw e;
  }

  // Identify which enrolled credential responded, so we unwrap its envelope.
  const usedId = bufToB64(assertion.rawId);
  const match = passkeyCreds.find((c) => c.credentialId === usedId) || passkeyCreds[0];

  const wrapKey = await derivePrfWrapKey(new Uint8Array(prf), emailHash);
  return unwrapDataKey(match.passkeyEnvelope.wrapped, wrapKey);
}
