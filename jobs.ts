// jobs.ts — Beast Mode background job queue (durable, KV-backed)
//
// WHY THIS EXISTS
//   Generation/upscaling were synchronous foreground fetches: the browser held
//   the HTTP request open for the whole Runware call and saved the result
//   client-side. A refresh, a dropped connection, or a logout mid-flight lost
//   the image even though Runware had already done (and the user had paid for)
//   the work. This module makes the WORK and the RESULT durable:
//
//     1. POST /api/jobs enqueues a job (token HOLD happens there) and returns a
//        jobId immediately — the browser can close.
//     2. An in-process worker loop (started in main.ts) claims queued jobs and
//        runs the existing generate()/upscale() provider path, R2 rehost, and
//        settle — regardless of whether any browser is connected.
//     3. GET /api/jobs lists the user's jobs; the queue UI renders from it, so
//        it reappears intact after logout/login.
//     4. The finished image is RETAINED on the job record. The next browser of
//        that user to poll drains it into the library via the existing
//        client-side save path (Drive/Dropbox stay zero-knowledge — the server
//        never holds OAuth tokens, so it can't push to the user's cloud).
//
// DURABILITY MODEL
//   Records:
//     ["job", userHash, jobId]      → the full job record (source of truth)
//     ["job_queue", seq, jobId]     → FIFO index of PENDING work for the worker
//   Claiming is an atomic CAS (queued → running) so two worker ticks — or two
//   machines — can't run the same job twice. On boot, reclaimOrphans() flips any
//   "running" job left behind by a crash/restart back to "queued" so it resumes.
//
//   The token HOLD ref is carried on the record. Settle/refund are done by the
//   worker exactly as the old synchronous routes did, so the ledger semantics
//   (hold → settle delivered, refund the rest / refund all on failure) are
//   unchanged — they just happen in the worker instead of the request handler.

import { kv } from "./auth.ts";
import { stashJobBlob, clearJobBlobs } from "./data-store.ts";

// Result-image stash fields completeJob() may create (mirrors input fields).
// Cleared when a job is delivered or dismissed so /data/jobtmp doesn't leak.
const RESULT_BLOB_FIELDS = [
  "result_image",
  ...Array.from({ length: 8 }, (_, i) => `result_img_${i}`),
];

export type JobKind = "generate" | "upscale";
export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobRecord {
  id: string;
  userHash: string;
  kind: JobKind;
  status: JobStatus;
  // The original request body from the client (minus auth). The worker feeds
  // this straight into generate()/upscale(), so the provider call is identical
  // to the old synchronous path.
  request: Record<string, unknown>;
  // Token ledger correlation: the hold taken at enqueue time, and the quoted
  // total so the worker can settle/refund precisely.
  holdRef: string;
  quotedTotal: number;
  perImage: number;
  model: string;
  // A short label for the queue UI (prompt snippet or "Upscale · <model>").
  label: string;
  // Populated when status === "done". For generate: images[]. For upscale: one
  // image. Shape mirrors what the old routes returned so the frontend save path
  // is unchanged.
  result?: {
    provider?: string;
    model?: string;
    images?: Array<{ url?: string }>;
    image?: { url?: string };
    tokens?: { charged: number; perImage: number; balance: number; ref: string };
  };
  // Populated when status === "failed".
  error?: { message: string; code?: string };
  // Set true once a browser has drained the result into the library, so we
  // don't double-save across tabs. The record is removed shortly after.
  delivered?: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  attempts: number;
}

// Monotonic-ish sequence for the FIFO queue index. Time-based with a random
// suffix to avoid collisions when two jobs enqueue in the same millisecond.
function queueSeq(): string {
  return `${Date.now().toString().padStart(15, "0")}-${crypto.randomUUID().slice(0, 8)}`;
}

const JOB_TTL_MS = 24 * 60 * 60 * 1000; // keep done/failed records 24h for the UI

/** Enqueue a new job. The token HOLD must already have been taken by the caller
 *  (the route does the quote+hold so it can return 402 synchronously). */
export async function enqueueJob(args: {
  userHash: string;
  kind: JobKind;
  request: Record<string, unknown>;
  holdRef: string;
  quotedTotal: number;
  perImage: number;
  model: string;
  label: string;
}): Promise<JobRecord> {
  const now = Date.now();
  const jobId = crypto.randomUUID();
  // Deno KV caps values at 64KB. Image inputs arrive as multi-MB data URIs, so
  // we move them OFF the record: stash each oversized data: field on /data and
  // leave a "jobblob:<field>" marker. runJob() rehydrates them before running.
  // Only data: URIs are stashed — http(s)/UUID refs are small and stay inline.
  const request: Record<string, unknown> = { ...args.request };
  const STASH_FIELDS = ["inputImage"];
  for (const field of STASH_FIELDS) {
    const v = request[field];
    if (typeof v === "string" && v.startsWith("data:") && v.length > 8192) {
      request[field] = await stashJobBlob(jobId, field, v);
    }
  }
  // referenceImages is an array of data URIs; stash each element that's large.
  if (Array.isArray(request.referenceImages)) {
    const refs = request.referenceImages as unknown[];
    const out: string[] = [];
    for (let i = 0; i < refs.length; i++) {
      const r = refs[i];
      if (typeof r === "string" && r.startsWith("data:") && r.length > 8192) {
        out.push(await stashJobBlob(jobId, `referenceImages_${i}`, r));
      } else {
        out.push(typeof r === "string" ? r : "");
      }
    }
    request.referenceImages = out;
  }
  const job: JobRecord = {
    id: jobId,
    userHash: args.userHash,
    kind: args.kind,
    status: "queued",
    request,
    holdRef: args.holdRef,
    quotedTotal: args.quotedTotal,
    perImage: args.perImage,
    model: args.model,
    label: args.label,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  };
  const seq = queueSeq();
  await kv.atomic()
    .set(["job", job.userHash, job.id], job)
    .set(["job_queue", seq, job.id], { userHash: job.userHash, jobId: job.id })
    .commit();
  return job;
}

/** List a user's jobs, newest first. Drops expired done/failed records lazily,
 *  and caps retained terminal (done/failed) history at the newest HISTORY_CAP
 *  so the queue can't grow without bound. In-flight jobs are never capped. */
const HISTORY_CAP = 50;
export async function listJobs(userHash: string): Promise<JobRecord[]> {
  const out: JobRecord[] = [];
  const now = Date.now();
  for await (const e of kv.list<JobRecord>({ prefix: ["job", userHash] })) {
    const j = e.value;
    if ((j.status === "done" || j.status === "failed") && j.finishedAt &&
        (now - j.finishedAt) > JOB_TTL_MS) {
      // Best-effort GC of stale records; don't block the listing on it.
      kv.delete(["job", userHash, j.id]).catch(() => {});
      continue;
    }
    out.push(j);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  // Enforce the history cap: keep all in-flight jobs, but trim terminal jobs
  // beyond the newest HISTORY_CAP (GC the overflow). Sorted newest-first, so we
  // count terminal records as we go and drop the tail.
  let terminalSeen = 0;
  const kept: JobRecord[] = [];
  for (const j of out) {
    const terminal = (j.status === "done" || j.status === "failed");
    if (terminal) {
      terminalSeen++;
      if (terminalSeen > HISTORY_CAP) {
        kv.delete(["job", userHash, j.id]).catch(() => {});
        continue;
      }
    }
    kept.push(j);
  }
  return kept;
}

export async function getJob(userHash: string, jobId: string): Promise<JobRecord | null> {
  const r = await kv.get<JobRecord>(["job", userHash, jobId]);
  return r.value ?? null;
}

/** Atomically claim the oldest queued job (queued → running). Returns null when
 *  the queue is empty. Safe against concurrent workers via versionstamp CAS. */
export async function claimNextJob(): Promise<JobRecord | null> {
  for await (const e of kv.list<{ userHash: string; jobId: string }>({ prefix: ["job_queue"] })) {
    const { userHash, jobId } = e.value;
    const jobRes = await kv.get<JobRecord>(["job", userHash, jobId]);
    const job = jobRes.value;
    // Stale queue pointer (job deleted) — clean it up and keep scanning.
    if (!job) { await kv.delete(e.key); continue; }
    if (job.status !== "queued") { await kv.delete(e.key); continue; }

    const now = Date.now();
    const running: JobRecord = {
      ...job, status: "running", startedAt: now, updatedAt: now,
      attempts: job.attempts + 1,
    };
    // CAS: only claim if the record hasn't changed since we read it, AND remove
    // the queue pointer in the same transaction so no other tick re-claims it.
    const ok = await kv.atomic()
      .check(jobRes)
      .check(e)
      .set(["job", userHash, jobId], running)
      .delete(e.key)
      .commit();
    if (ok.ok) return running;
    // Lost the race — another worker took it; keep scanning.
  }
  return null;
}

/** Mark a claimed job done with its result. Worker has already settled tokens.
 *
 *  KV caps a value at 64KB. The happy path swaps each image URL to a tiny
 *  /api/img/<id> ref, so the record is small. But the rehost SOFT-DEGRADE leaves
 *  a multi-MB `data:` URI on img.url when /data is unwritable — and on the WORKER
 *  path that URI gets persisted here, blowing the 64KB cap. The set() then throws,
 *  the lane catch swallows it, and the job is stranded in "running": the image was
 *  generated (and paid for) but never delivered. To stay symmetric with the input
 *  stashing in enqueueJob(), we move any oversized data: URI in the result OFF the
 *  record onto /data and leave a `jobblob:<field>` marker. The GET /api/jobs drain
 *  rehydrates it so the client still receives the image this session. */
export async function completeJob(job: JobRecord, result: JobRecord["result"]): Promise<void> {
  const now = Date.now();
  const safeResult = result ? await stashResultBlobs(job.id, result) : result;
  const done: JobRecord = { ...job, status: "done", result: safeResult, updatedAt: now, finishedAt: now };
  // DIAGNOSTIC + SAFETY: KV caps a value at 64KB. If the assembled record is
  // still oversized after stashing (a field we didn't anticipate carrying bytes,
  // e.g. a base64 echo on an image item, or a bloated request), log WHICH part
  // is large and which image urls look like inline data — then drop the request
  // payload (the client doesn't read it back from a done job) as a last resort
  // so the job can still settle instead of stranding in "running".
  try {
    const size = new TextEncoder().encode(JSON.stringify(done)).length;
    if (size > 60_000) {
      const imgs = Array.isArray(safeResult?.images) ? safeResult!.images : [];
      console.error(
        `completeJob oversized: job=${job.id} bytes=${size}` +
        ` imgUrls=${JSON.stringify(imgs.map((x) => (typeof x?.url === "string" ? x.url.slice(0, 24) : typeof x?.url)))}` +
        ` imgKeys=${JSON.stringify(imgs.map((x) => Object.keys(x || {})))}` +
        ` reqKeys=${JSON.stringify(Object.keys(job.request || {}))}`,
      );
      // Strip the request (not needed once done) and retry size.
      const slimDone: JobRecord = { ...done, request: {} as Record<string, unknown> };
      const size2 = new TextEncoder().encode(JSON.stringify(slimDone)).length;
      if (size2 <= 64_000) {
        await kv.set(["job", job.userHash, job.id], slimDone);
        return;
      }
      console.error(`completeJob STILL oversized after stripping request: bytes=${size2}`);
    }
  } catch (_) { /* probe must never block the write */ }
  await kv.set(["job", job.userHash, job.id], done);
}

// Move any large data: URI in a result off-KV (mirrors enqueueJob input stashing).
// Returns a shallow-cloned result with `jobblob:<field>` markers in place of bytes.
async function stashResultBlobs(jobId: string, result: NonNullable<JobRecord["result"]>): Promise<JobRecord["result"]> {
  const BIG = 8192; // only data: URIs over this are worth stashing
  const out = { ...result };
  if (Array.isArray(out.images)) {
    out.images = await Promise.all(out.images.map(async (img, i) => {
      const u = img?.url;
      if (typeof u === "string" && u.startsWith("data:") && u.length > BIG) {
        const marker = await stashJobBlob(jobId, `result_img_${i}`, u);
        return { ...img, url: marker };
      }
      return img;
    }));
  }
  if (out.image && typeof out.image.url === "string" && out.image.url.startsWith("data:") && out.image.url.length > BIG) {
    const marker = await stashJobBlob(jobId, "result_image", out.image.url);
    out.image = { ...out.image, url: marker };
  }
  return out;
}

/** Mark a claimed job failed. Worker has already refunded the hold. */
export async function failJob(job: JobRecord, message: string, code?: string): Promise<void> {
  const now = Date.now();
  const failed: JobRecord = {
    ...job, status: "failed", error: { message, code }, updatedAt: now, finishedAt: now,
  };
  await kv.set(["job", job.userHash, job.id], failed);
}

/** Mark a done job as drained into the user's library (so other tabs skip it),
 *  then schedule the record for removal. Returns false if already delivered. */
export async function markDelivered(userHash: string, jobId: string): Promise<boolean> {
  const res = await kv.get<JobRecord>(["job", userHash, jobId]);
  const job = res.value;
  if (!job || job.status !== "done") return false;
  if (job.delivered) return false;
  const updated: JobRecord = { ...job, delivered: true, updatedAt: Date.now() };
  const ok = await kv.atomic().check(res).set(["job", userHash, jobId], updated).commit();
  if (!ok.ok) return false; // another tab won the race
  // Remove shortly after so the UI can show the "delivered" state briefly.
  setTimeout(() => {
    kv.delete(["job", userHash, jobId]).catch(() => {});
    clearJobBlobs(jobId, RESULT_BLOB_FIELDS).catch(() => {});
  }, 60_000);
  return true;
}

/** Let the user dismiss a failed/done job from their queue explicitly. */
export async function deleteJob(userHash: string, jobId: string): Promise<void> {
  await kv.delete(["job", userHash, jobId]);
  clearJobBlobs(jobId, RESULT_BLOB_FIELDS).catch(() => {});
}

/** Cancel a QUEUED job before a worker lane claims it. Flips it to "failed"
 *  (code: "cancelled") and drops its queue pointer so no lane runs it. The
 *  token hold is refunded by the caller (main.ts) — jobs.ts deliberately
 *  doesn't import the ledger. Returns false if the job isn't queued (e.g. a
 *  lane already claimed it; the running-job path in main.ts handles that). */
export async function cancelQueuedJob(userHash: string, jobId: string): Promise<boolean> {
  const res = await kv.get<JobRecord>(["job", userHash, jobId]);
  const job = res.value;
  if (!job || job.status !== "queued") return false;
  const now = Date.now();
  const failed: JobRecord = {
    ...job, status: "failed", updatedAt: now, finishedAt: now,
    error: { message: "Cancelled before it started.", code: "cancelled" },
  };
  // CAS so we don't clobber a claim that lands in the same instant.
  const ok = await kv.atomic().check(res).set(["job", userHash, jobId], failed).commit();
  if (!ok.ok) return false;
  // Best-effort: remove the FIFO pointer so claimNextJob() doesn't waste a scan.
  // claimNextJob() also self-heals (it skips non-queued jobs), so a miss is fine.
  for await (const e of kv.list<{ userHash: string; jobId: string }>({ prefix: ["job_queue"] })) {
    if (e.value && e.value.jobId === jobId) { await kv.delete(e.key); break; }
  }
  return true;
}

/** Mark a RUNNING job as failed/cancelled once its provider call has been
 *  aborted (the abort itself happens in main.ts via the AbortController
 *  registry; runJob's own catch will also failJob it, so this is the explicit
 *  path for when the abort needs the record updated immediately). */
export async function markCancelled(userHash: string, jobId: string): Promise<boolean> {
  const res = await kv.get<JobRecord>(["job", userHash, jobId]);
  const job = res.value;
  if (!job || (job.status !== "running" && job.status !== "queued")) return false;
  const now = Date.now();
  const failed: JobRecord = {
    ...job, status: "failed", updatedAt: now, finishedAt: now,
    error: { message: "Cancelled.", code: "cancelled" },
  };
  await kv.set(["job", userHash, jobId], failed);
  return true;
}

/** Remove ALL terminal (done/failed) jobs for a user — the "Clear" button.
 *  In-flight jobs (queued/running) are left untouched. Returns the count
 *  removed. */
export async function clearTerminalJobs(userHash: string): Promise<number> {
  let removed = 0;
  for await (const e of kv.list<JobRecord>({ prefix: ["job", userHash] })) {
    const j = e.value;
    if (j && (j.status === "done" || j.status === "failed")) {
      await kv.delete(e.key);
      removed++;
    }
  }
  return removed;
}

/** Boot recovery: any job left "running" by a crash/restart is flipped back to
 *  "queued" with a fresh queue pointer so the worker resumes it. The token hold
 *  is still in place (it was never settled), so re-running is correct.
 *
 *  `onGiveUp` is called for jobs that have already been restarted too many times
 *  so the caller (main.ts) can refund the still-open hold before they're marked
 *  failed — jobs.ts deliberately doesn't import the token ledger. */
export async function reclaimOrphans(
  onGiveUp?: (job: JobRecord) => Promise<void>,
): Promise<number> {
  let reclaimed = 0;
  for await (const e of kv.list<JobRecord>({ prefix: ["job"] })) {
    // prefix ["job"] also matches ["job_queue", ...] — skip those (value shape
    // differs: queue pointers have no .status).
    const j = e.value as JobRecord;
    if (!j || typeof j !== "object" || !("status" in j)) continue;
    if (j.status !== "running") continue;
    // Guard against a runaway job: after too many attempts, fail it so the hold
    // is returned rather than looping forever.
    if (j.attempts >= 3) {
      if (onGiveUp) { try { await onGiveUp(j); } catch { /* refund best-effort */ } }
      const now = Date.now();
      const failed: JobRecord = {
        ...j, status: "failed", updatedAt: now, finishedAt: now,
        error: { message: "Job abandoned after repeated restarts.", code: "orphan_giveup" },
      };
      await kv.set(["job", j.userHash, j.id], failed);
      reclaimed++;
      continue;
    }
    const requeued: JobRecord = { ...j, status: "queued", updatedAt: Date.now() };
    const seq = queueSeq();
    await kv.atomic()
      .set(["job", j.userHash, j.id], requeued)
      .set(["job_queue", seq, j.id], { userHash: j.userHash, jobId: j.id })
      .commit();
    reclaimed++;
  }
  return reclaimed;
}
