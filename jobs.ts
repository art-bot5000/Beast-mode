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
import { stashJobBlob } from "./data-store.ts";

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

/** List a user's jobs, newest first. Drops expired done/failed records lazily. */
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
  return out;
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

/** Mark a claimed job done with its result. Worker has already settled tokens. */
export async function completeJob(job: JobRecord, result: JobRecord["result"]): Promise<void> {
  const now = Date.now();
  const done: JobRecord = { ...job, status: "done", result, updatedAt: now, finishedAt: now };
  await kv.set(["job", job.userHash, job.id], done);
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
  setTimeout(() => { kv.delete(["job", userHash, jobId]).catch(() => {}); }, 60_000);
  return true;
}

/** Let the user dismiss a failed/done job from their queue explicitly. */
export async function deleteJob(userHash: string, jobId: string): Promise<void> {
  await kv.delete(["job", userHash, jobId]);
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
