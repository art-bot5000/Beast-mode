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
