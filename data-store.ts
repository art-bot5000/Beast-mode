// data-store.ts — Per-user image bytes on the Fly /data volume.
//
// PURPOSE
//   Primary durable store for generated/upscaled image BYTES. Replaces the old
//   R2 newest-5 FIFO buffer (which silently emptied libraries). Images here are
//   server-written, server-readable, encrypted at rest by Fly's volume — NOT
//   zero-knowledge. Prompts/settings remain under the existing ZK envelope; the
//   image record stored here holds only a reference id, never prompt plaintext.
//
// LAYOUT
//   /data/img/<userHash>/<favId>.<ext>     image bytes
//   KV  ["imgmeta", userHash, favId]       { ext, bytes, mime, createdAt }
//   KV  ["imgusage", userHash]             running total bytes (fast quota check)
//
//   The on-disk bytes are the source of truth; KV meta is an index so we can
//   list/sum/FIFO-trim without statting the whole directory each write. If the
//   two ever disagree, disk wins for reads and a reconcile pass can rebuild KV.
//
// QUOTA
//   Per-user cap defaults to PER_USER_CAP_BYTES (500 MB). When a write would
//   exceed it, we FIFO-trim the OLDEST images for that user until the new one
//   fits (generous, user-scoped — never the silent global newest-5). A global
//   high-water guard (GLOBAL_HIGH_WATER_BYTES) 503s ALL writes before the
//   physical disk fills, independent of per-user quota.
//
//   The per-user cap is read via userCapBytes(userHash) so a future Stripe
//   "buy more storage" flow only has to stash a number on the user record —
//   no rewrite here.
//
// SOFT-DEGRADE (house pattern)
//   storeImage() THROWS on quota/disk failure so the caller can fall back to a
//   data URI for that one job rather than failing the generation. dataEnabled()
//   lets boot warn-not-block when /data isn't mounted (local dev).

const DATA_ROOT = Deno.env.get("DATA_ROOT") || "/data";
const IMG_ROOT = `${DATA_ROOT}/img`;

// 500 MB per user (default; overridable per-user later via the user record).
const PER_USER_CAP_BYTES = 500 * 1024 * 1024;
// 5 GB volume → start refusing new writes at 90% to leave headroom for KV,
// in-flight temp files, and FS overhead. Tune alongside `fly volumes extend`.
const GLOBAL_HIGH_WATER_BYTES = Math.floor(5 * 1024 * 1024 * 1024 * 0.9);

let _kv: Deno.Kv | null = null;
async function kv(): Promise<Deno.Kv> {
  if (!_kv) _kv = await Deno.openKv(Deno.env.get("DENO_KV_PATH") || undefined);
  return _kv;
}

interface ImgMeta {
  ext: string;
  bytes: number;
  mime: string;
  createdAt: number;
}

// ── boot probe ───────────────────────────────────────────────────────────────
// True when /data/img is writable. Optional integrations warn-not-block, so the
// caller decides whether a missing volume is fatal (it shouldn't be in dev).
export async function dataEnabled(): Promise<boolean> {
  try {
    await Deno.mkdir(IMG_ROOT, { recursive: true });
    return true;
  } catch (e) {
    console.warn("data-store: /data not writable, image persistence disabled:", (e as Error).message);
    return false;
  }
}

function userDir(userHash: string): string {
  // userHash is a SHA-256 hex digest from auth — no separators, safe as a path
  // segment. Defensive guard anyway so a malformed value can't escape IMG_ROOT.
  if (!/^[a-f0-9]{16,128}$/i.test(userHash)) throw new Error("bad userHash");
  return `${IMG_ROOT}/${userHash}`;
}

function favIdSafe(favId: string): string {
  // favId is a client-supplied Date.now() string. Allow digits only so it can
  // never traverse paths or collide with another user's namespace.
  if (!/^[0-9]{8,20}$/.test(favId)) throw new Error("bad favId");
  return favId;
}

function extSafe(ext: string): string {
  const e = (ext || "png").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4);
  return e || "png";
}

// ── usage accounting ─────────────────────────────────────────────────────────
async function readUsage(userHash: string): Promise<number> {
  const r = await (await kv()).get<number>(["imgusage", userHash]);
  return typeof r.value === "number" ? r.value : 0;
}

async function addUsage(userHash: string, delta: number): Promise<void> {
  // Best-effort CAS; usage is an optimisation, not a ledger. Reconcile can
  // rebuild it from KV meta if it drifts.
  const k = await kv();
  for (let i = 0; i < 5; i++) {
    const cur = await k.get<number>(["imgusage", userHash]);
    const next = Math.max(0, (cur.value ?? 0) + delta);
    const res = await k.atomic().check(cur).set(["imgusage", userHash], next).commit();
    if (res.ok) return;
  }
}

// Per-user cap. Hook point for Stripe "buy more storage": read an override off
// the user record here, default to PER_USER_CAP_BYTES.
export function userCapBytes(_userHash: string): number {
  return PER_USER_CAP_BYTES;
}

// ── listing / FIFO ───────────────────────────────────────────────────────────
async function listMeta(userHash: string): Promise<Array<{ favId: string; meta: ImgMeta }>> {
  const out: Array<{ favId: string; meta: ImgMeta }> = [];
  const it = (await kv()).list<ImgMeta>({ prefix: ["imgmeta", userHash] });
  for await (const e of it) {
    const favId = String(e.key[e.key.length - 1]);
    out.push({ favId, meta: e.value });
  }
  return out;
}

// FIFO-trim the OLDEST images for this user until `needBytes` of headroom
// exists under the cap. Returns bytes freed. Best-effort per file.
async function trimOldestUntilFits(userHash: string, needBytes: number, cap: number): Promise<number> {
  const items = (await listMeta(userHash)).sort((a, b) => a.meta.createdAt - b.meta.createdAt); // oldest first
  let usage = await readUsage(userHash);
  let freed = 0;
  for (const it of items) {
    if (usage + needBytes <= cap) break;
    try { await deleteImage(userHash, it.favId); } catch { /* best-effort */ }
    usage -= it.meta.bytes;
    freed += it.meta.bytes;
  }
  return freed;
}

// ── write ────────────────────────────────────────────────────────────────────
// Persist image bytes for a user. THROWS on global-full or unrecoverable disk
// error so the caller can soft-degrade to a data URI for this one image.
// Returns the stable read path the client should store: /api/img/<favId>.
export async function storeImage(
  userHash: string,
  favId: string,
  bytes: Uint8Array,
  mime: string,
): Promise<string> {
  const id = favIdSafe(favId);
  const ext = extSafe(mime.split("/")[1]);
  const cap = userCapBytes(userHash);

  // Global high-water guard — refuse before the physical disk fills, regardless
  // of any individual user's remaining per-user quota.
  const globalUsage = await globalUsageBytes();
  if (globalUsage + bytes.length > GLOBAL_HIGH_WATER_BYTES) {
    throw new Error("storage_full_global");
  }

  // Per-user quota: FIFO-trim oldest to make room, then re-check.
  let usage = await readUsage(userHash);
  if (usage + bytes.length > cap) {
    await trimOldestUntilFits(userHash, bytes.length, cap);
    usage = await readUsage(userHash);
    if (usage + bytes.length > cap) {
      // A single image larger than the whole cap, or trim couldn't free enough.
      throw new Error("storage_full_user");
    }
  }

  const dir = userDir(userHash);
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/${id}.${ext}`;

  // Write to a temp file then rename — a crash mid-write never leaves a
  // half-image that reads as corrupt bytes.
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await Deno.writeFile(tmp, bytes);
    await Deno.rename(tmp, path);
  } catch (e) {
    try { await Deno.remove(tmp); } catch { /* ignore */ }
    throw e;
  }

  const meta: ImgMeta = { ext, bytes: bytes.length, mime, createdAt: Date.now() };
  await (await kv()).set(["imgmeta", userHash, id], meta);
  await addUsage(userHash, bytes.length);

  return `/api/img/${id}`;
}

// ── read ─────────────────────────────────────────────────────────────────────
// Read image bytes for a user's favId. Returns null if absent. The caller is
// responsible for having already verified the SESSION — userHash MUST come from
// verifySessionToken, never from the client, or one user reads another's images.
export async function readImage(
  userHash: string,
  favId: string,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const id = favIdSafe(favId);
  const metaRes = await (await kv()).get<ImgMeta>(["imgmeta", userHash, id]);
  if (!metaRes.value) return null;
  const meta = metaRes.value;
  const path = `${userDir(userHash)}/${id}.${meta.ext}`;
  try {
    const bytes = await Deno.readFile(path);
    return { bytes, mime: meta.mime };
  } catch {
    // KV says it exists but disk doesn't — treat as gone (don't 500).
    return null;
  }
}

// ── delete ───────────────────────────────────────────────────────────────────
export async function deleteImage(userHash: string, favId: string): Promise<void> {
  const id = favIdSafe(favId);
  const metaRes = await (await kv()).get<ImgMeta>(["imgmeta", userHash, id]);
  if (metaRes.value) {
    const path = `${userDir(userHash)}/${id}.${metaRes.value.ext}`;
    try { await Deno.remove(path); } catch { /* already gone */ }
    await (await kv()).delete(["imgmeta", userHash, id]);
    await addUsage(userHash, -metaRes.value.bytes);
  }
}

// ── usage reporting (for the client's storage meter + global guard) ──────────
export async function userUsage(userHash: string): Promise<{ usedBytes: number; capBytes: number }> {
  return { usedBytes: await readUsage(userHash), capBytes: userCapBytes(userHash) };
}

async function globalUsageBytes(): Promise<number> {
  // Sum of per-user usage counters. Cheap relative to statting the tree, and
  // accurate enough for a high-water *guard* (we only need "are we near full").
  let total = 0;
  const it = (await kv()).list<number>({ prefix: ["imgusage"] });
  for await (const e of it) total += (typeof e.value === "number" ? e.value : 0);
  return total;
}

// ── manifest for login re-hydration ──────────────────────────────────────────
// Returns the lightweight index the client uses to rebuild its library on
// login: favId + metadata, NO bytes. The client lazy-loads bytes via /api/img.
export async function listManifest(userHash: string): Promise<Array<{ favId: string; ext: string; bytes: number; mime: string; createdAt: number }>> {
  const items = await listMeta(userHash);
  return items
    .map((x) => ({ favId: x.favId, ext: x.meta.ext, bytes: x.meta.bytes, mime: x.meta.mime, createdAt: x.meta.createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt); // newest first, matches library order
}

// ── job input blobs ───────────────────────────────────────────────────────────
// Deno KV caps a value at 64KB. Job records (jobs.ts) store the request body,
// and image inputs (upscale `inputImage`, generate `referenceImages`) arrive as
// multi-MB data URIs — far over the cap, so committing the job throws
// "Value too large". We keep those bytes OFF KV: stash each on the /data volume
// under the job id, store only a marker in the record, and rehydrate in the
// worker before the job runs. Cleaned up when the job finishes.
const JOBTMP_ROOT = `${DATA_ROOT}/jobtmp`;

function jobTmpPath(jobId: string, field: string): string {
  if (!/^[a-f0-9-]{8,64}$/i.test(jobId)) throw new Error("bad jobId");
  if (!/^[a-z0-9_]{1,32}$/i.test(field)) throw new Error("bad field");
  return `${JOBTMP_ROOT}/${jobId}.${field}`;
}

// Persist a data URI (or raw string) for a job field. Returns the marker string
// the job record should carry in place of the bytes.
export async function stashJobBlob(jobId: string, field: string, dataUri: string): Promise<string> {
  await Deno.mkdir(JOBTMP_ROOT, { recursive: true });
  const path = jobTmpPath(jobId, field);
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.writeFile(tmp, new TextEncoder().encode(dataUri));
  await Deno.rename(tmp, path);
  return `jobblob:${field}`;
}

// Read a previously stashed job field back as its original string (data URI).
export async function fetchJobBlob(jobId: string, field: string): Promise<string | null> {
  try {
    const bytes = await Deno.readFile(jobTmpPath(jobId, field));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

// Remove all stashed blobs for a job (best-effort; called when a job finishes).
export async function clearJobBlobs(jobId: string, fields: string[]): Promise<void> {
  for (const field of fields) {
    try { await Deno.remove(jobTmpPath(jobId, field)); } catch { /* already gone */ }
  }
}

// True when a job-record value is a stash marker rather than inline bytes.
export function isJobBlobMarker(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("jobblob:");
}
