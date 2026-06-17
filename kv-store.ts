// kv-store.ts — Per-user, zero-knowledge document store on the Fly /data volume.
//
// PURPOSE
//   Primary durable store for the app's NON-IMAGE data classes: prompts,
//   particles, settings, styles, recent prompts, folders, models, formula
//   presets, fav-particles. Replaces Google Drive as the source of truth for
//   these; Drive is demoted to an optional mirror written client-side only when
//   connected.
//
//   Each doc is AES-GCM-encrypted IN THE BROWSER with the account DATA KEY
//   before it ever reaches this module (same primitive as the encrypted
//   thumbnails). The server stores OPAQUE CIPHERTEXT + the IV — it cannot read
//   the content and holds no decryption secret. The zero-knowledge boundary is
//   preserved: locked sessions (no DATA KEY) simply can't decrypt, exactly like
//   thumbnails today.
//
// LAYOUT (decision 1b — ciphertext on disk, KV holds only the small header)
//   /data/userdoc/<userHash>/<docKey>.enc        ciphertext bytes
//   KV  ["userdoc", userHash, docKey]            { iv, ver, bytes, updatedAt }
//
//   Why disk-not-KV for the bytes: Deno KV caps a value at 64KB. The bundled
//   `prompts` doc can exceed that with hundreds of prompts (data-store.ts hits
//   the same wall for image inputs). Keeping ciphertext on /data sidesteps the
//   cap entirely; KV holds only a fixed-size header so list/version checks stay
//   cheap. Disk is the source of truth for bytes; KV is the index. If they
//   disagree, a read that finds a header but no file returns null (treated as
//   "gone"), never a 500.
//
// R2 SNAPSHOT (decision 2 — periodic, all-docs, NOT write-through)
//   R2 key: userdoc/<userHash>/<docKey>.enc      same ciphertext bytes
//   Driven by an explicit snapshot call (client schedules it debounced + on
//   logout), never on every PUT. R2 is the offsite backup; /data is primary.
//
// SOFT-DEGRADE (house pattern)
//   putDoc() THROWS on disk failure so the route can surface a clean 5xx and the
//   client can keep its localStorage copy. dataDocsEnabled() lets boot
//   warn-not-block when /data isn't mounted (local dev). R2 snapshot failures
//   are swallowed (backup is best-effort; primary already succeeded).

import { rehostBytesToR2, getFromR2, r2Enabled } from "./r2.js";

const DATA_ROOT = Deno.env.get("DATA_ROOT") || "/data";
const DOC_ROOT = `${DATA_ROOT}/userdoc`;

// Fixed allowlist of doc keys. Anything off this list is rejected so a client
// can't create arbitrary server-side keys. Mirrors the Drive file constants in
// the frontend (prompts collapses the old per-prompt files into one doc).
const ALLOWED_DOC_KEYS = new Set<string>([
  "prompts",          // the library (was beast-mode-prompt-*.json, one per fav)
  "settings",         // current settings (beast-mode-current-settings.json)
  "custom-presets",   // beast-mode-custom-presets.json
  "prompt-history",   // last-N recent prompts (beast-mode-prompt-history.json)
  "folders",          // beast-mode-folders.json
  "models",           // beast-mode-models.json
  "personal-particles", // beast-mode-personal-categories.json
  "particle-libraries", // beast-mode-particle-libraries.json
  "fav-particles",    // beast-mode-fav-particles.json
  "formula-presets",  // beast-mode-formula-presets.json
  "styles",           // customised styles
]);

let _kv: Deno.Kv | null = null;
async function kv(): Promise<Deno.Kv> {
  if (!_kv) _kv = await Deno.openKv(Deno.env.get("DENO_KV_PATH") || undefined);
  return _kv;
}

interface DocHeader {
  iv: string;        // base64 12-byte AES-GCM IV (client-supplied, opaque here)
  ver: number;       // monotonic version, bumped each write (optimistic concurrency)
  bytes: number;     // ciphertext length on disk
  updatedAt: number; // ms epoch
}

// ── boot probe ───────────────────────────────────────────────────────────────
export async function dataDocsEnabled(): Promise<boolean> {
  try {
    await Deno.mkdir(DOC_ROOT, { recursive: true });
    return true;
  } catch (e) {
    console.warn("kv-store: /data not writable, doc store disabled:", (e as Error).message);
    return false;
  }
}

// ── validation ───────────────────────────────────────────────────────────────
function userDir(userHash: string): string {
  if (!/^[a-f0-9]{16,128}$/i.test(userHash)) throw new Error("bad userHash");
  return `${DOC_ROOT}/${userHash}`;
}

export function isAllowedDocKey(docKey: string): boolean {
  return ALLOWED_DOC_KEYS.has(docKey);
}

function docKeySafe(docKey: string): string {
  if (!ALLOWED_DOC_KEYS.has(docKey)) throw new Error("bad docKey");
  return docKey;
}

function ivSafe(iv: string): string {
  // base64 of a 12-byte IV is 16 chars. Be permissive on length (future-proof)
  // but reject anything that isn't plausibly base64 so it can't smuggle paths.
  if (typeof iv !== "string" || iv.length < 8 || iv.length > 64 || !/^[A-Za-z0-9+/=]+$/.test(iv)) {
    throw new Error("bad iv");
  }
  return iv;
}

function docPath(userHash: string, docKey: string): string {
  return `${userDir(userHash)}/${docKeySafe(docKey)}.enc`;
}

function r2Key(userHash: string, docKey: string): string {
  return `userdoc/${userHash}/${docKey}.enc`;
}

// ── write ────────────────────────────────────────────────────────────────────
// Persist one encrypted doc. `ct` is opaque ciphertext bytes; `iv` is the
// client's base64 IV. THROWS on disk failure so the route returns 5xx and the
// client keeps its local copy. Does NOT snapshot to R2 (see snapshotToR2).
export async function putDoc(
  userHash: string,
  docKey: string,
  iv: string,
  ct: Uint8Array,
): Promise<{ ver: number; updatedAt: number }> {
  docKeySafe(docKey);
  ivSafe(iv);

  const dir = userDir(userHash);
  await Deno.mkdir(dir, { recursive: true });
  const path = docPath(userHash, docKey);

  // temp-file-then-rename: a crash mid-write never leaves half a ciphertext
  // (which would fail to decrypt and look like corruption).
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await Deno.writeFile(tmp, ct);
    await Deno.rename(tmp, path);
  } catch (e) {
    try { await Deno.remove(tmp); } catch { /* ignore */ }
    throw e;
  }

  const k = await kv();
  const prev = await k.get<DocHeader>(["userdoc", userHash, docKey]);
  const ver = (prev.value?.ver ?? 0) + 1;
  const header: DocHeader = { iv, ver, bytes: ct.length, updatedAt: Date.now() };
  await k.set(["userdoc", userHash, docKey], header);
  return { ver, updatedAt: header.updatedAt };
}

// ── read ─────────────────────────────────────────────────────────────────────
// Returns the ciphertext + header for a doc, or null if absent. The caller must
// have verified the SESSION — userHash MUST come from verifySessionToken.
export async function getDoc(
  userHash: string,
  docKey: string,
): Promise<{ iv: string; ct: Uint8Array; ver: number; updatedAt: number } | null> {
  docKeySafe(docKey);
  const headerRes = await (await kv()).get<DocHeader>(["userdoc", userHash, docKey]);
  if (!headerRes.value) return null;
  const h = headerRes.value;
  try {
    const ct = await Deno.readFile(docPath(userHash, docKey));
    return { iv: h.iv, ct, ver: h.ver, updatedAt: h.updatedAt };
  } catch {
    // KV header exists but disk file is gone — treat as absent (don't 500).
    return null;
  }
}

// ── delete ───────────────────────────────────────────────────────────────────
export async function deleteDoc(userHash: string, docKey: string): Promise<void> {
  docKeySafe(docKey);
  try { await Deno.remove(docPath(userHash, docKey)); } catch { /* already gone */ }
  await (await kv()).delete(["userdoc", userHash, docKey]);
}

// ── list (login rehydration index) ───────────────────────────────────────────
// Lightweight index: docKey + header, NO ciphertext. The client decides which
// docs to pull and decrypt. Sorted by docKey for stable output.
export async function listDocs(
  userHash: string,
): Promise<Array<{ docKey: string; ver: number; bytes: number; updatedAt: number }>> {
  const out: Array<{ docKey: string; ver: number; bytes: number; updatedAt: number }> = [];
  const it = (await kv()).list<DocHeader>({ prefix: ["userdoc", userHash] });
  for await (const e of it) {
    const docKey = String(e.key[e.key.length - 1]);
    out.push({ docKey, ver: e.value.ver, bytes: e.value.bytes, updatedAt: e.value.updatedAt });
  }
  out.sort((a, b) => (a.docKey < b.docKey ? -1 : 1));
  return out;
}

// ── R2 snapshot (offsite backup) ─────────────────────────────────────────────
// Copy the current ciphertext for one doc to R2. Best-effort: never throws, so a
// backup failure can't break the primary write path. No-op when R2 is disabled.
export async function snapshotDocToR2(userHash: string, docKey: string): Promise<boolean> {
  try {
    if (!r2Enabled()) return false;
    const doc = await getDoc(userHash, docKey);
    if (!doc) return false;
    await rehostBytesToR2(doc.ct, "application/octet-stream", r2Key(userHash, docKey));
    return true;
  } catch (e) {
    console.warn("kv-store: R2 snapshot failed", docKey, (e as Error).message);
    return false;
  }
}

// Snapshot ALL of a user's docs in one pass (decision 2: all-docs, debounced +
// on logout, driven by the client). Returns how many were backed up.
export async function snapshotAllToR2(userHash: string): Promise<number> {
  if (!r2Enabled()) return 0;
  let n = 0;
  for (const { docKey } of await listDocs(userHash)) {
    if (await snapshotDocToR2(userHash, docKey)) n++;
  }
  return n;
}

// ── R2 restore (recovery) ────────────────────────────────────────────────────
// Pull a doc's ciphertext back from the R2 snapshot into /data + KV. Used when
// the volume is lost/reset. Returns true if a snapshot existed and was restored.
// The IV lives in the ciphertext's KV header, which is ALSO gone if the volume
// was wiped — so restore can only recover bytes if the header survived (KV is
// separate from the volume) OR the caller supplies the IV. We restore bytes and
// keep any existing header; a fuller cross-host recovery is a Phase 3 concern.
export async function restoreDocFromR2(
  userHash: string,
  docKey: string,
): Promise<boolean> {
  docKeySafe(docKey);
  if (!r2Enabled()) return false;
  const bytes = await getFromR2(r2Key(userHash, docKey));
  if (!bytes) return false;

  const dir = userDir(userHash);
  await Deno.mkdir(dir, { recursive: true });
  const path = docPath(userHash, docKey);
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await Deno.writeFile(tmp, bytes);
    await Deno.rename(tmp, path);
  } catch (e) {
    try { await Deno.remove(tmp); } catch { /* ignore */ }
    throw e;
  }

  // Preserve the existing header if present (keeps the IV); otherwise write a
  // header WITHOUT an iv is useless for decryption, so we only update byte count
  // and bump ver when a header already exists.
  const k = await kv();
  const prev = await k.get<DocHeader>(["userdoc", userHash, docKey]);
  if (prev.value) {
    await k.set(["userdoc", userHash, docKey], {
      ...prev.value, bytes: bytes.length, updatedAt: Date.now(), ver: prev.value.ver + 1,
    });
  }
  return true;
}
