// webauthn-verify.ts — hand-rolled WebAuthn assertion verification (ES256 only).
//
// No external deps: pure WebCrypto (SubtleCrypto), available in Deno and Node.
// Used by the SESSION-ONLY passkey path, where there is no DATA-KEY unwrap to act
// as implicit proof. Here the server MUST verify the assertion signature against
// the credential's stored P-256 public key before issuing a session.
//
// Scope is deliberately narrow: ES256 (ECDSA P-256, SHA-256) only, because the
// browser enrols with pubKeyCredParams [{alg:-7}] exclusively. The stored public
// key is the raw 65-byte uncompressed point (0x04|x|y) the browser extracted from
// SPKI, so there is NO ASN.1/COSE parsing here — only the signature is DER.

const te = new TextEncoder();

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── ASN.1 DER ECDSA signature → raw r||s (64 bytes) for WebCrypto ──────────────
// WebAuthn signatures are DER: SEQUENCE { INTEGER r, INTEGER s }. WebCrypto's
// ECDSA verify wants the fixed 64-byte r||s form. DER integers may carry a leading
// 0x00 (to keep them positive) or be short; normalise each to exactly 32 bytes.
function derToRawSignature(der: Uint8Array): Uint8Array {
  let off = 0;
  if (der[off++] !== 0x30) throw new Error("Bad DER: no SEQUENCE");
  // Length (assume short form — ECDSA P-256 sigs are well under 128 bytes).
  let seqLen = der[off++];
  if (seqLen & 0x80) {
    // Long form (rare for P-256, but handle 1-byte length).
    const n = seqLen & 0x7f;
    seqLen = 0;
    for (let i = 0; i < n; i++) seqLen = (seqLen << 8) | der[off++];
  }
  const readInt = (): Uint8Array => {
    if (der[off++] !== 0x02) throw new Error("Bad DER: no INTEGER");
    let len = der[off++];
    let val = der.slice(off, off + len);
    off += len;
    // Strip leading zero padding.
    while (val.length > 1 && val[0] === 0x00) val = val.slice(1);
    // Left-pad to 32 bytes.
    if (val.length > 32) throw new Error("DER integer too long");
    const out = new Uint8Array(32);
    out.set(val, 32 - val.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

// Import a raw P-256 public point (0x04|x|y) as an ECDSA verify key.
async function importP256(rawPoint: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    rawPoint,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

export interface AssertionInput {
  authenticatorData: string; // base64
  clientDataJSON: string;    // base64
  signature: string;         // base64 (DER)
}

export interface VerifyParams {
  expectedChallenge: string; // base64url, as issued
  expectedOrigin: string;    // e.g. "https://beast-mode.fly.dev"
  expectedRpId: string;      // e.g. "beast-mode.fly.dev"
  publicKey: string;         // base64 raw P-256 point (stored at enrolment)
  storedSignCount: number;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  newSignCount?: number;
  clonedWarning?: boolean;
}

// Verify a WebAuthn assertion end-to-end. Returns ok:false with a reason on any
// failure (caller maps all failures to a single generic 401 — no oracle).
export async function verifyAssertion(
  assertion: AssertionInput,
  p: VerifyParams,
): Promise<VerifyResult> {
  let clientData: { type?: string; challenge?: string; origin?: string };
  try {
    const cdjBytes = b64ToBytes(assertion.clientDataJSON);
    clientData = JSON.parse(new TextDecoder().decode(cdjBytes));
  } catch {
    return { ok: false, reason: "clientDataJSON parse" };
  }

  if (clientData.type !== "webauthn.get") return { ok: false, reason: "type" };
  if (clientData.challenge !== p.expectedChallenge) return { ok: false, reason: "challenge" };
  if (clientData.origin !== p.expectedOrigin) return { ok: false, reason: "origin" };

  const authData = b64ToBytes(assertion.authenticatorData);
  if (authData.length < 37) return { ok: false, reason: "authData length" };

  // rpIdHash = first 32 bytes; must equal SHA-256(rpId).
  const rpIdHash = authData.slice(0, 32);
  const expectedRpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(p.expectedRpId)));
  for (let i = 0; i < 32; i++) {
    if (rpIdHash[i] !== expectedRpHash[i]) return { ok: false, reason: "rpIdHash" };
  }

  // Flags byte (index 32): bit0 UP (user present), bit2 UV (user verified).
  const flags = authData[32];
  if (!(flags & 0x01)) return { ok: false, reason: "UP not set" };
  if (!(flags & 0x04)) return { ok: false, reason: "UV not set" };

  // signCount = bytes 33..36, big-endian.
  const signCount = (authData[33] << 24) | (authData[34] << 16) | (authData[35] << 8) | authData[36];
  const newSignCount = signCount >>> 0;

  // Signature is over authenticatorData || SHA-256(clientDataJSON).
  const cdjHash = new Uint8Array(await crypto.subtle.digest("SHA-256", b64ToBytes(assertion.clientDataJSON)));
  const signedData = new Uint8Array(authData.length + cdjHash.length);
  signedData.set(authData, 0);
  signedData.set(cdjHash, authData.length);

  let rawSig: Uint8Array;
  try {
    rawSig = derToRawSignature(b64ToBytes(assertion.signature));
  } catch {
    return { ok: false, reason: "signature decode" };
  }

  let key: CryptoKey;
  try {
    key = await importP256(b64ToBytes(p.publicKey));
  } catch {
    return { ok: false, reason: "public key import" };
  }

  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    rawSig,
    signedData,
  );
  if (!valid) return { ok: false, reason: "signature" };

  // signCount cloning detection: a non-zero counter must strictly increase.
  // Some platform authenticators always report 0 — that's spec-permitted, so
  // 0/0 is fine; only flag when a previously-nonzero counter fails to advance.
  let clonedWarning = false;
  if (newSignCount !== 0 || p.storedSignCount !== 0) {
    if (newSignCount <= p.storedSignCount) clonedWarning = true;
  }

  return { ok: true, newSignCount, clonedWarning };
}

// Helper for issuing challenges (random 32 bytes → base64url).
export function newChallenge(): string {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
}
