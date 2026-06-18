// main.ts — Beast Mode backend
//
// The keystone. Responsibilities, in order of importance:
//   1. Read RUNWARE_API_KEY server-side and proxy generation, so the key NEVER
//      reaches the browser. This is what actually hides the key — not login.
//   2. Refuse to boot if a security-critical secret is missing (stckrm pattern):
//      "silently broken in prod" becomes "deploy fails immediately".
//   3. Rate-limit /api/generate per IP, so an open endpoint can't run up the
//      Runware bill before the full account system exists.
//   4. Serve /ping for the start.sh readiness probe (Caddy waits on it).
//
// The provider modules (providers/index.js etc.) read process.env.RUNWARE_API_KEY
// and use node:crypto. Deno 2.x supports node: imports; we bridge Deno.env into
// process.env at startup so those modules run UNCHANGED.
//
// Account/auth endpoints (/user, /key, /passkey, /mfa, /recovery, /email,
// /admin, /settings) are STUBBED below — they return 501 so the Caddyfile routes
// resolve, but they are NOT built yet. Building them (stckrm-style envelopes,
// recovery codes, MFA) is the next phase after a safe-to-launch generation proxy.

import process from "node:process";

// ── Bridge Deno.env -> process.env so the node-style provider modules work ───
for (const [k, v] of Object.entries(Deno.env.toObject())) {
  process.env[k] = v;
}

// ── Boot-time secret validation (hard-fail, like stckrm) ─────────────────────
const REQUIRED_SECRETS = ["RUNWARE_API_KEY"];
// Add as features land: "ADMIN_SECRET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "RESEND_API_KEY"
const missing = REQUIRED_SECRETS.filter((k) => !process.env[k]);
// Soft requirement: Google OAuth works only with the client secret set. Warn
// loudly rather than hard-fail so a missing secret degrades (Drive connect
// returns 503) instead of bricking the whole deploy.
if (!Deno.env.get("GOOGLE_CLIENT_SECRET")) {
  console.warn("WARN: GOOGLE_CLIENT_SECRET not set — Google Drive connect will be unavailable.");
}
// Soft requirement: direct Gemini ("Nano Banana") models need this key. The
// google.js adapter returns a clean 503 if it's missing, so generation via
// Runware keeps working either way.
if (!Deno.env.get("GEMINI_API_KEY")) {
  console.warn("WARN: GEMINI_API_KEY not set — direct Gemini (Nano Banana) models will be unavailable.");
}
// Soft requirement: verification emails need both. Without them, OTPs fall
// back to console logging (visible in `fly logs`) — fine for dev/staging,
// NOT fine for prod with real users. Set with:
//   fly secrets set RESEND_API_KEY=re_... MAIL_FROM='Beast Mode <verify@DOMAIN>' --app beast-mode
if (!Deno.env.get("RESEND_API_KEY") || !Deno.env.get("MAIL_FROM")) {
  console.warn("WARN: RESEND_API_KEY / MAIL_FROM not set — verification emails fall back to console logging.");
}
// Soft requirement: admin panel. Without ADMIN_SECRET every /admin endpoint
// returns 503; without ADMIN_EMAIL the admin OTP is console-logged.
//   fly secrets set ADMIN_SECRET=<long-random> ADMIN_EMAIL=you@example.com --app beast-mode
if (!Deno.env.get("ADMIN_SECRET")) {
  console.warn("WARN: ADMIN_SECRET not set — admin panel unavailable (503).");
}
if (missing.length) {
  console.error(`FATAL: missing required secret(s): ${missing.join(", ")}`);
  console.error("Set them with: fly secrets set KEY=value --app beast-mode");
  Deno.exit(1);
}

// Provider abstraction (the modules we built). Note: import as .js — Deno runs
// them directly. generate() picks the provider from the model-id prefix.
import { generate, searchModels, upscale, UPSCALERS, findUpscaler, ProviderError } from "./index.js";
import { catalogByFamily, findInCatalog, defaultsFor } from "./catalog.js";
import { pricingTable, quote, estimatedCostUsd, geminiUsageCostUsd, quoteUpscale, tokensPerUpscale, estimatedUpscaleCostUsd } from "./pricing.js";
import { getBalance, holdTokens, settleHold, refundHold, listLedger } from "./tokens.ts";
import { r2Enabled, trimR2ToNewest, presignR2Put, presignR2Get } from "./r2.js";
import { storeImage, readImage, userUsage, listManifest, patchImageMeta, fetchJobBlob, clearJobBlobs, isJobBlobMarker } from "./data-store.ts";
import {
  putDoc, getDoc, deleteDoc, listDocs, isAllowedDocKey,
  snapshotAllToR2, snapshotDocToR2, restoreDocFromR2, dataDocsEnabled,
} from "./kv-store.ts";
import { handleAuth, verifySessionToken } from "./auth.ts";
import { handleAdmin } from "./admin.ts";
import { handleOAuth } from "./oauth.ts";
import {
  enqueueJob, listJobs, getJob, claimNextJob, completeJob, failJob,
  markDelivered, deleteJob, reclaimOrphans, type JobRecord,
} from "./jobs.ts";

const PORT = 8000; // Caddy reverse-proxies to this; start.sh probes /ping here.

// ── Minimal per-IP rate limiter for /api/generate ────────────────────────────
// In-memory token bucket. Good enough to stop casual abuse of an open endpoint.
// NOT a substitute for real accounts/quotas — it resets on restart and is
// per-machine. Replace with KV-backed per-user quotas once accounts exist.
const RATE_MAX = 10;            // requests
const RATE_WINDOW_MS = 60_000;  // per minute, per IP
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
    hits.set(ip, arr);
    return true;
  }
  arr.push(now);
  hits.set(ip, arr);
  return false;
}
// Periodic cleanup so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const live = arr.filter((t) => now - t < RATE_WINDOW_MS);
    if (live.length) hits.set(ip, live);
    else hits.delete(ip);
  }
}, 5 * 60_000);

function clientIp(req: Request): string {
  // Caddy sits in front; trust its forwarded header, fall back to a constant.
  const xff = req.headers.get("x-forwarded-for");
  return xff ? xff.split(",")[0].trim() : "unknown";
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

// Decode a base64 string to bytes WITHOUT an intermediate data: URI. atob gives
// a binary string; we copy it to a Uint8Array. Used for inline provider images
// (direct Gemini) so we never hold the data URI + re-decoded copy at once.
function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  // Chunk to avoid blowing the argument limit on String.fromCharCode for large
  // ciphertexts (the bundled prompts doc can be hundreds of KB).
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ── Shared provider execution ────────────────────────────────────────────────
// The provider call + R2 rehost + ledger settle/refund, factored out of the
// request handlers so the SAME code runs whether a job is executed
// synchronously (legacy /api/generate, /api/upscale) or by the background
// worker (jobs.ts). The hold is taken by the caller; these settle or refund it.
//
// Returns the same payload the old synchronous routes returned on success, or
// throws (ProviderError or generic) after refunding — the caller decides how to
// surface that (HTTP error vs. failed job record).

interface RunGenResult {
  model: string; provider: string;
  images: Array<{ url?: string }>;
  tokens: { charged: number; perImage: number; balance: number; ref: string };
}

async function runGenerateHeld(
  userHash: string,
  body: Record<string, unknown>,
  q: { totalTokens: number; perImage: number },
  holdRef: string,
  genCount: number,
  genOpts: Record<string, unknown>,
): Promise<RunGenResult> {
  try {
    const entry = findInCatalog(body.model as string);
    const snapDims = entry ? entry.snap !== false : true;
    const result = await generate({
      prompt: body.prompt as string,
      negativePrompt: body.negativePrompt as string | undefined,
      model: body.model as string,
      width: body.width as number | undefined,
      height: body.height as number | undefined,
      steps: body.steps as number | undefined,
      cfgScale: body.cfgScale as number | undefined,
      count: genCount,
      seed: body.seed as number | undefined,
      referenceImages: body.referenceImages as string[] | undefined,
      resolution: body.resolution as string | undefined,
      aspectRatio: body.aspectRatio as string | undefined,
      quality: body.quality as string | undefined,
      renderingSpeed: body.renderingSpeed as string | undefined,
      snapDims,
    });

    // PRIMARY IMAGE STORE — write bytes to the per-user /data volume and hand
    // the client a STABLE /api/img/<favId> URL. This replaces the old R2
    // newest-5 buffer (r2.js trimR2ToNewest), which silently emptied libraries.
    // R2 is no longer in the image path at all.
    //
    // Memory: still SEQUENTIAL, one image at a time — bounds peak resident bytes
    // at ~1× a single image regardless of batch size (the OOM class fly.toml
    // documents). Still AWAITED, not backgrounded: completeJob() snapshots the
    // result into KV right after this returns, so a backgrounded swap of img.url
    // would never reach the persisted job record.
    //
    // favId: the client mirrors this id onto the library favourite (it uses
    // Date.now() too), so /api/img/<favId> resolves to the same image the
    // library card references. We mint it here and return it on the img object.
    for (const img of result.images as Array<{ url?: string; b64?: string; mimeType?: string; favId?: string }>) {
      const favId = String(Date.now()) + String(Math.floor(Math.random() * 1000)).padStart(3, "0");
      try {
        let bytes: Uint8Array;
        let mime: string;
        if (img.b64) {
          mime = img.mimeType || "image/png";
          bytes = decodeBase64(img.b64);
        } else if (img.url) {
          // Provider returned only a hosted URL — fetch the pristine bytes once.
          const res = await fetch(img.url);
          if (!res.ok) throw new Error(`fetch provider image: HTTP ${res.status}`);
          mime = res.headers.get("content-type") || "image/jpeg";
          bytes = new Uint8Array(await res.arrayBuffer());
        } else {
          continue; // nothing to store
        }
        img.url = await storeImage(userHash, favId, bytes, mime);
        img.favId = favId;
        delete img.b64; delete img.mimeType;
      } catch (e) {
        // SOFT-DEGRADE (house pattern): on quota/disk failure keep the image
        // viewable this session as a data URI rather than failing the whole
        // generation. The library just won't have a durable server copy for it.
        if (img.b64) {
          img.url = `data:${img.mimeType || "image/png"};base64,${img.b64}`;
          delete img.b64; delete img.mimeType;
        }
        console.warn("/data store failed, serving inline (no durable copy):", (e as Error).message);
      }
    }

    const delivered = result.images.length;
    const charged = Math.min(q.totalTokens, q.perImage * delivered);
    const rawUsage = (result.raw && typeof result.raw === "object")
      ? (result.raw as Record<string, unknown>).usageMetadata
      : undefined;
    const actualCostUsd = (typeof result.costUsd === "number" ? result.costUsd : null)
      ?? geminiUsageCostUsd(body.model as string, rawUsage)
      ?? estimatedCostUsd(body.model as string, genOpts);
    const settled = await settleHold(userHash, holdRef, {
      chargedTokens: charged,
      refundTokens: q.totalTokens - charged,
      model: body.model as string,
      images: delivered,
      actualCostUsd,
    });

    return {
      model: result.model,
      provider: result.provider,
      images: result.images,
      tokens: { charged, perImage: q.perImage, balance: settled.balance, ref: holdRef },
    };
  } catch (e) {
    await refundHold(userHash, holdRef, q.totalTokens,
      e instanceof ProviderError ? `provider:${e.code}` : "internal_error",
    ).catch((re) => console.error("CRITICAL: refund failed after generate error:", (re as Error).message));
    throw e;
  }
}

interface RunUpResult {
  model: string; provider: string;
  image: { url?: string };
  tokens: { charged: number; perImage: number; balance: number; ref: string };
}

async function runUpscaleHeld(
  userHash: string,
  body: Record<string, unknown>,
  q: { totalTokens: number; perImage: number },
  holdRef: string,
  upModel: string,
  upOpts: { targetMegapixels?: number },
): Promise<RunUpResult> {
  try {
    const result = await upscale({
      model: upModel,
      inputImage: body.inputImage as string,
      outputFormat: body.outputFormat as string | undefined,
      outputQuality: body.outputQuality as number | undefined,
      targetMegapixels: body.targetMegapixels as number | undefined,
      enhanceDetails: body.enhanceDetails as boolean | undefined,
      realism: body.realism as boolean | undefined,
      upscaleFactor: body.upscaleFactor as number | undefined,
      positivePrompt: body.positivePrompt as string | undefined,
      negativePrompt: body.negativePrompt as string | undefined,
      steps: body.steps as number | undefined,
      CFGScale: body.CFGScale as number | undefined,
      strength: body.strength as number | undefined,
      seed: body.seed as number | undefined,
    });

    const out = result.image as { url?: string; b64?: string; favId?: string };
    if (out && (out.url || out.b64)) {
      const favId = String(Date.now()) + String(Math.floor(Math.random() * 1000)).padStart(3, "0");
      try {
        let bytes: Uint8Array;
        let mime: string;
        if (out.b64) {
          mime = "image/png";
          bytes = decodeBase64(out.b64);
        } else {
          const res = await fetch(out.url as string);
          if (!res.ok) throw new Error(`fetch upscale image: HTTP ${res.status}`);
          mime = res.headers.get("content-type") || "image/jpeg";
          bytes = new Uint8Array(await res.arrayBuffer());
        }
        out.url = await storeImage(userHash, favId, bytes, mime);
        out.favId = favId;
        delete out.b64;
      } catch (e) {
        if (out.b64) { out.url = `data:image/png;base64,${out.b64}`; delete out.b64; }
        console.warn("/data store failed (upscale), serving inline:", (e as Error).message);
      }
    }

    const delivered = out?.url ? 1 : 0;
    const charged = delivered ? q.totalTokens : 0;
    const actualCostUsd = (typeof result.costUsd === "number" ? result.costUsd : null)
      ?? estimatedUpscaleCostUsd(upModel, upOpts);
    const settled = await settleHold(userHash, holdRef, {
      chargedTokens: charged,
      refundTokens: q.totalTokens - charged,
      model: upModel,
      images: delivered,
      actualCostUsd,
    });

    if (!delivered) {
      // Treat "no image" as a provider failure so the job/route surfaces it.
      // The hold was already settled to charge 0 + full refund above.
      throw new ProviderError("Upscaler returned no image.", "upstream", 502);
    }
    return {
      model: result.model,
      provider: result.provider,
      image: out,
      tokens: { charged, perImage: q.perImage, balance: settled.balance, ref: holdRef },
    };
  } catch (e) {
    // If we already settled (the no-image case), a refund here is a harmless
    // no-op against a spent ref? No — settle consumed the ref. Only refund when
    // the provider call itself threw before settling. Distinguish by code.
    if (!(e instanceof ProviderError && e.code === "upstream")) {
      await refundHold(userHash, holdRef, q.totalTokens,
        e instanceof ProviderError ? `provider:${e.code}` : "internal_error",
      ).catch((re) => console.error("CRITICAL: refund failed after upscale error:", (re as Error).message));
    }
    throw e;
  }
}

// ── Background worker ─────────────────────────────────────────────────────────
// A single in-process loop claims queued jobs and runs them via the shared
// functions above. The hold is already taken (at enqueue); the worker settles
// or refunds it, then records the result on the job. Because the work lives in
// KV, a refresh/disconnect/logout in the browser cannot interrupt it.
let workerRunning = false;

async function runJob(job: JobRecord): Promise<void> {
  const body = { ...job.request } as Record<string, unknown>;
  // Rehydrate any image inputs stashed off-KV at enqueue (see jobs.ts). A
  // "jobblob:<field>" marker means the bytes live on /data; read them back into
  // the body so the run functions see the original data URI. Track what we
  // rehydrated so we can clean the temp files after the job settles.
  const stashedFields: string[] = [];
  if (isJobBlobMarker(body.inputImage)) {
    const v = await fetchJobBlob(job.id, "inputImage");
    if (v) { body.inputImage = v; stashedFields.push("inputImage"); }
  }
  if (Array.isArray(body.referenceImages)) {
    const refs = body.referenceImages as unknown[];
    for (let i = 0; i < refs.length; i++) {
      if (isJobBlobMarker(refs[i])) {
        const v = await fetchJobBlob(job.id, `referenceImages_${i}`);
        if (v) { refs[i] = v; stashedFields.push(`referenceImages_${i}`); }
      }
    }
    body.referenceImages = refs;
  }
  const q = { totalTokens: job.quotedTotal, perImage: job.perImage };
  try {
    if (job.kind === "generate") {
      const genCount = Math.max(1, Math.min(4, Number(body.count) || 1));
      const genOpts = {
        resolution: body.resolution as string | undefined,
        width: body.width as number | undefined,
        height: body.height as number | undefined,
        quality: body.quality as string | undefined,
        renderingSpeed: body.renderingSpeed as string | undefined,
      };
      const res = await runGenerateHeld(job.userHash, body, q, job.holdRef, genCount, genOpts);
      await completeJob(job, { provider: res.provider, model: res.model, images: res.images, tokens: res.tokens });
    } else {
      const upModel = body.model as string;
      const upOpts = { targetMegapixels: Number(body.targetMegapixels) || undefined };
      const res = await runUpscaleHeld(job.userHash, body, q, job.holdRef, upModel, upOpts);
      await completeJob(job, { provider: res.provider, model: res.model, image: res.image, tokens: res.tokens });
    }
  } catch (e) {
    const msg = e instanceof ProviderError ? e.message : "Generation failed — please try again.";
    const code = e instanceof ProviderError ? e.code : "internal_error";
    await failJob(job, msg, code);
    console.error(`job ${job.id} (${job.kind}) failed:`, (e as Error).message);
  } finally {
    if (stashedFields.length) clearJobBlobs(job.id, stashedFields).catch(() => {});
  }
}

// Max jobs running concurrently in this process. Each job is I/O-bound (it
// spends almost all its time awaiting Runware/Gemini, not on CPU), so the
// shared-cpu-1x core is not the limit — peak RESIDENT MEMORY is. With lever 2
// capping each job's rehost at ~1× a single image, a handful of concurrent
// jobs stays well within 512MB. Tune via WORKER_CONCURRENCY; default 4.
const WORKER_CONCURRENCY = Math.max(
  1,
  Math.min(16, Number(process.env.WORKER_CONCURRENCY) || 4),
);

function startWorker(): void {
  if (workerRunning) return;
  workerRunning = true;

  // Bounded-concurrency dispatcher. We run WORKER_CONCURRENCY independent
  // claim→run lanes. Each lane loops: claim the oldest queued job and run it;
  // if the queue is empty, idle briefly then retry. claimNextJob()'s KV CAS
  // (queued→running, atomic with removing the queue pointer) guarantees no two
  // lanes — or two machines — ever run the same job, so this is safe to fan out.
  const lane = async (laneId: number) => {
    while (workerRunning) {
      try {
        const job = await claimNextJob();
        if (!job) {
          // Queue empty for this lane — idle, then re-check. Jitter the delay a
          // little per lane so the lanes don't all wake and hammer KV in phase.
          await new Promise((r) => setTimeout(r, 1500 + laneId * 120));
          continue;
        }
        await runJob(job);
        // No idle delay after real work: immediately try to claim the next job
        // so a backlog drains at full concurrency.
      } catch (e) {
        console.error("worker lane error:", (e as Error).message);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  };

  for (let i = 0; i < WORKER_CONCURRENCY; i++) lane(i);
  console.log(`Background job worker started (concurrency=${WORKER_CONCURRENCY}).`);
}

// ── Router ───────────────────────────────────────────────────────────────────
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Readiness probe — start.sh waits for this before launching Caddy.
  if (path === "/ping") return new Response("ok");

  // Deploy marker — bump this string on each test push to confirm GitHub
  // Actions actually shipped the latest code. (Lives INSIDE handler() so the
  // return is legal — a top-level return crashes Deno with "Illegal return".)
  if (path === "/version") {
    return new Response(
      JSON.stringify({ version: "deploy-test-1", builtFrom: "github-actions" }),
      { headers: { "content-type": "application/json" } },
    );
  }

  // ── Generation proxy: the key is attached HERE, server-side, never sent down.
  if (path === "/api/generate" && req.method === "POST") {
    // ── GATE: require a valid session token. This is what actually protects the
    // Runware spend — only signed-in, verified users can reach generation.
    // The browser sends it as `Authorization: Bearer <token>`.
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const userHash = await verifySessionToken(token);
    if (!userHash) {
      return json({ error: "Sign in to generate images.", code: "auth_required" }, 401);
    }

    const ip = clientIp(req);
    if (rateLimited(ip)) {
      return json({ error: "Rate limit exceeded. Try again shortly.", code: "rate_limit" }, 429);
    }
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body", code: "bad_request" }, 400);
    }

    // ── TOKEN QUOTE + HOLD (Pass 3 ledger). The price is the fixed table
    // price from pricing.js — known before the provider call. We hold the full
    // requested batch up front (atomic CAS: concurrent tabs cannot overdraft),
    // settle for what actually comes back, refund the rest.
    const genCount = Math.max(1, Math.min(4, Number(body.count) || 1));
    const genOpts = {
      resolution: body.resolution as string | undefined,
      width: body.width as number | undefined,
      height: body.height as number | undefined,
      quality: body.quality as string | undefined,
      renderingSpeed: body.renderingSpeed as string | undefined,
    };
    const q = quote(body.model as string, genOpts, genCount);
    const hold = await holdTokens(userHash, q.totalTokens, { model: body.model as string });
    if (!hold.ok) {
      return json({
        error: `Not enough tokens — this needs ${q.totalTokens}, you have ${Number.isFinite(hold.balance) ? hold.balance : 0}.`,
        code: "insufficient_tokens",
        needed: q.totalTokens,
        balance: Number.isFinite(hold.balance) ? hold.balance : 0,
      }, 402);
    }

    try {
      const res = await runGenerateHeld(userHash, body, q, hold.ref, genCount, genOpts);
      return json(res);
    } catch (e) {
      // Hold already refunded inside runGenerateHeld on failure.
      if (e instanceof ProviderError) return json({ error: e.message, code: e.code }, e.status);
      console.error("generate failed", e);
      return json({ error: "Internal error" }, 500);
    }
  }

  // ── Image upscaling. Mirrors /api/generate's protections exactly: session
  // gate → IP rate-limit → token HOLD → provider call → R2 rehost → SETTLE,
  // with a full REFUND on any failure. Upscalers are a separate task family
  // with their own (cheaper) pricing table, and always produce ONE image.
  if (path === "/api/upscale" && req.method === "POST") {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const userHash = await verifySessionToken(token);
    if (!userHash) {
      return json({ error: "Sign in to upscale images.", code: "auth_required" }, 401);
    }

    const ip = clientIp(req);
    if (rateLimited(ip)) {
      return json({ error: "Rate limit exceeded. Try again shortly.", code: "rate_limit" }, 429);
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body", code: "bad_request" }, 400);
    }

    const upModel = body.model as string;
    if (!findUpscaler(upModel)) {
      return json({ error: `Unknown upscaler "${upModel}".`, code: "bad_request" }, 400);
    }

    // ── TOKEN QUOTE + HOLD. P-Image is priced by target megapixels; the others
    // are flat. One output image per task, so the quote is the whole charge.
    const upOpts = { targetMegapixels: Number(body.targetMegapixels) || undefined };
    const q = quoteUpscale(upModel, upOpts);
    const hold = await holdTokens(userHash, q.totalTokens, { model: upModel });
    if (!hold.ok) {
      return json({
        error: `Not enough tokens — this needs ${q.totalTokens}, you have ${Number.isFinite(hold.balance) ? hold.balance : 0}.`,
        code: "insufficient_tokens",
        needed: q.totalTokens,
        balance: Number.isFinite(hold.balance) ? hold.balance : 0,
      }, 402);
    }

    try {
      const res = await runUpscaleHeld(userHash, body, q, hold.ref, upModel, upOpts);
      return json(res);
    } catch (e) {
      // Hold already refunded inside runUpscaleHeld on failure.
      if (e instanceof ProviderError) return json({ error: e.message, code: e.code }, e.status);
      console.error("upscale failed", e);
      return json({ error: "Internal error" }, 500);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BACKGROUND JOB QUEUE  (/api/jobs)
  //
  // The durable path. POST enqueues a generate/upscale job (taking the token
  // HOLD up front so 402 is still synchronous), and the worker runs it whether
  // or not the browser stays connected. GET lists the user's jobs so the queue
  // UI survives refresh/logout. POST .../deliver marks a done job as drained
  // into the library (so multiple tabs don't double-save). DELETE dismisses.
  // ══════════════════════════════════════════════════════════════════════════

  if (path === "/api/jobs" && req.method === "POST") {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const userHash = await verifySessionToken(token);
    if (!userHash) return json({ error: "Sign in to generate images.", code: "auth_required" }, 401);

    const ip = clientIp(req);
    if (rateLimited(ip)) {
      return json({ error: "Rate limit exceeded. Try again shortly.", code: "rate_limit" }, 429);
    }

    let body: Record<string, unknown>;
    try { body = await req.json(); }
    catch { return json({ error: "Invalid JSON body", code: "bad_request" }, 400); }

    const kind = body.kind === "upscale" ? "upscale" : "generate";

    if (kind === "generate") {
      const genCount = Math.max(1, Math.min(4, Number(body.count) || 1));
      const genOpts = {
        resolution: body.resolution as string | undefined,
        width: body.width as number | undefined,
        height: body.height as number | undefined,
        quality: body.quality as string | undefined,
        renderingSpeed: body.renderingSpeed as string | undefined,
      };
      const q = quote(body.model as string, genOpts, genCount);
      const hold = await holdTokens(userHash, q.totalTokens, { model: body.model as string });
      if (!hold.ok) {
        return json({
          error: `Not enough tokens — this needs ${q.totalTokens}, you have ${Number.isFinite(hold.balance) ? hold.balance : 0}.`,
          code: "insufficient_tokens",
          needed: q.totalTokens,
          balance: Number.isFinite(hold.balance) ? hold.balance : 0,
        }, 402);
      }
      const promptSnip = String(body.prompt || "").slice(0, 80) || "Untitled";
      const job = await enqueueJob({
        userHash, kind, request: body,
        holdRef: hold.ref, quotedTotal: q.totalTokens, perImage: q.perImage,
        model: body.model as string,
        label: (genCount > 1 ? `×${genCount} · ` : "") + promptSnip,
      });
      startWorker(); // idempotent — ensures the loop is running
      return json({ jobId: job.id, status: job.status, balance: hold.balance });
    } else {
      const upModel = body.model as string;
      if (!findUpscaler(upModel)) {
        return json({ error: `Unknown upscaler "${upModel}".`, code: "bad_request" }, 400);
      }
      const upOpts = { targetMegapixels: Number(body.targetMegapixels) || undefined };
      const q = quoteUpscale(upModel, upOpts);
      const hold = await holdTokens(userHash, q.totalTokens, { model: upModel });
      if (!hold.ok) {
        return json({
          error: `Not enough tokens — this needs ${q.totalTokens}, you have ${Number.isFinite(hold.balance) ? hold.balance : 0}.`,
          code: "insufficient_tokens",
          needed: q.totalTokens,
          balance: Number.isFinite(hold.balance) ? hold.balance : 0,
        }, 402);
      }
      const job = await enqueueJob({
        userHash, kind, request: body,
        holdRef: hold.ref, quotedTotal: q.totalTokens, perImage: q.perImage,
        model: upModel, label: `Upscale · ${upModel.split(":").pop() || upModel}`,
      });
      startWorker();
      return json({ jobId: job.id, status: job.status, balance: hold.balance });
    }
  }

  if (path === "/api/jobs" && req.method === "GET") {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const userHash = await verifySessionToken(token);
    if (!userHash) return json({ error: "Sign in.", code: "auth_required" }, 401);
    const jobs = await listJobs(userHash);
    // Strip the request payload from the listing — it can be large (reference
    // images as data URIs) and the client doesn't need it back.
    const slim = jobs.map((j) => ({
      id: j.id, kind: j.kind, status: j.status, label: j.label, model: j.model,
      result: j.status === "done" ? j.result : undefined,
      error: j.status === "failed" ? j.error : undefined,
      delivered: !!j.delivered,
      createdAt: j.createdAt, finishedAt: j.finishedAt,
    }));
    return json({ jobs: slim });
  }

  // POST /api/jobs/<id>/deliver — the browser drained this done job into the
  // library; mark it so other tabs skip it. Returns ok:false if already taken.
  {
    const m = path.match(/^\/api\/jobs\/([^/]+)\/deliver$/);
    if (m && req.method === "POST") {
      const authHeader = req.headers.get("authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
      const userHash = await verifySessionToken(token);
      if (!userHash) return json({ error: "Sign in.", code: "auth_required" }, 401);
      const ok = await markDelivered(userHash, m[1]);
      return json({ ok });
    }
  }

  // DELETE /api/jobs/<id> — user dismisses a finished/failed job from the queue.
  {
    const m = path.match(/^\/api\/jobs\/([^/]+)$/);
    if (m && req.method === "DELETE") {
      const authHeader = req.headers.get("authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
      const userHash = await verifySessionToken(token);
      if (!userHash) return json({ error: "Sign in.", code: "auth_required" }, 401);
      // Only allow dismissing terminal jobs; in-flight jobs must finish so their
      // hold is settled/refunded rather than orphaned.
      const job = await getJob(userHash, m[1]);
      if (job && (job.status === "queued" || job.status === "running")) {
        return json({ error: "Job still in progress.", code: "in_progress" }, 409);
      }
      await deleteJob(userHash, m[1]);
      return json({ ok: true });
    }
  }

  // ── Token balance + ledger (session-gated). Deliberately under /api/* so
  // the existing Caddy proxy and service-worker bypass cover them — no
  // routing changes, no frontend deploy.
  if ((path === "/api/tokens/balance" || path === "/api/tokens/ledger") && req.method === "GET") {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const userHash = await verifySessionToken(token);
    if (!userHash) return json({ error: "Sign in required.", code: "auth_required" }, 401);
    if (path === "/api/tokens/balance") {
      return json({ ok: true, balance: await getBalance(userHash) });
    }
    const limit = Number(url.searchParams.get("limit")) || 50;
    // Strip actualCostUsd: that's the PROVIDER cost (our margin), recorded for
    // internal observability only. Users see token amounts, never margin.
    const entries = (await listLedger(userHash, limit)).map((e) => {
      const { actualCostUsd: _private, ...pub } = e;
      return pub;
    });
    return json({ ok: true, entries });
  }

  // ── Zero-knowledge thumbnail lane (session-gated). The browser encrypts a
  // WebP thumbnail under the account DATA KEY and PUTs the ciphertext straight
  // to R2 via a presigned URL — plaintext never reaches this server or
  // Cloudflare. We only sign URLs and enforce per-user key isolation. Soft-
  // degrades to {ok:false} when R2 is unconfigured (client just skips thumbs).
  if (path === "/api/thumbs/presign-put" && req.method === "POST") {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const userHash = await verifySessionToken(token);
    if (!userHash) return json({ error: "Sign in required.", code: "auth_required" }, 401);
    if (!r2Enabled()) return json({ ok: false, reason: "r2_disabled" });
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON", code: "bad_request" }, 400); }
    // Server OWNS the key — never trust a caller-supplied path. id is the fav id.
    const id = String(body.id ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
    if (!id) return json({ error: "id required", code: "bad_request" }, 400);
    const key = `thumbs/${userHash}/${id}.enc`;
    try {
      const presignedUrl = await presignR2Put(key, 300);
      // FIFO: keep this user's newest 1000 thumbs. Fire-and-forget.
      trimR2ToNewest(`thumbs/${userHash}/`, 1000).catch((e) =>
        console.warn("thumb trim failed (non-fatal):", (e as Error).message)
      );
      return json({ ok: true, url: presignedUrl, key });
    } catch (e) {
      console.warn("presign-put failed:", (e as Error).message);
      return json({ ok: false, reason: "presign_failed" });
    }
  }

  if (path === "/api/thumbs/presign-get" && req.method === "POST") {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const userHash = await verifySessionToken(token);
    if (!userHash) return json({ error: "Sign in required.", code: "auth_required" }, 401);
    if (!r2Enabled()) return json({ ok: false, reason: "r2_disabled" });
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON", code: "bad_request" }, 400); }
    const key = String(body.key ?? "");
    // Per-user isolation: a user may only read keys under THEIR own prefix.
    if (!key.startsWith(`thumbs/${userHash}/`)) {
      return json({ error: "Forbidden", code: "forbidden" }, 403);
    }
    try {
      const presignedUrl = await presignR2Get(key, 300);
      return json({ ok: true, url: presignedUrl });
    } catch (e) {
      console.warn("presign-get failed:", (e as Error).message);
      return json({ ok: false, reason: "presign_failed" });
    }
  }

  // ── PRIMARY IMAGE READ — stream a user's stored image bytes off /data.
  // SESSION-GATED: userHash comes ONLY from verifySessionToken, never the URL,
  // so a user can never read another user's favId. The path is /api/img/<favId>;
  // <favId> selects WITHIN that user's namespace. Cached aggressively — bytes at
  // a given favId never change (new generations get new ids).
  if (path.startsWith("/api/img/") && req.method === "GET") {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    const userHash = await verifySessionToken(token);
    if (!userHash) return json({ error: "Sign in to view images.", code: "auth_required" }, 401);
    const favId = path.slice("/api/img/".length);
    const img = await readImage(userHash, favId);
    if (!img) return json({ error: "Image not found.", code: "not_found" }, 404);
    return new Response(img.bytes, {
      status: 200,
      headers: {
        "content-type": img.mime,
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  }

  // ── Library manifest for login re-hydration. Returns the lightweight index
  // (favId + metadata, NO bytes); the client rebuilds its library list and
  // lazy-loads each image via /api/img/<favId> on demand. Session-gated.
  if (path === "/api/manifest" && req.method === "GET") {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    const userHash = await verifySessionToken(token);
    if (!userHash) return json({ error: "Sign in.", code: "auth_required" }, 401);
    return json({ images: await listManifest(userHash) });
  }

  // ── Register durable upscale linkage + dimensions onto an existing image.
  // The client posts this after saving an upscale (it knows the parent favId,
  // output dims, and upscale model — the server's storeImage path does not).
  // This is what lets the login manifest rebuild upscale groups and report
  // correct resolutions even when the client's ZK library doc is unavailable.
  // Session-gated; the favId namespace is per-user so a user can only patch
  // their own images. No-op if the image doesn't exist for this user.
  if (path.startsWith("/api/imgmeta/") && req.method === "POST") {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    const userHash = await verifySessionToken(token);
    if (!userHash) return json({ error: "Sign in.", code: "auth_required" }, 401);
    const favId = path.slice("/api/imgmeta/".length);
    if (!favId) return json({ error: "Missing favId.", code: "bad_request" }, 400);
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* empty body → no-op patch */ }
    const ok = await patchImageMeta(userHash, favId, {
      isUpscale: typeof body.isUpscale === "boolean" ? body.isUpscale : undefined,
      upscaledFromId: (typeof body.upscaledFromId === "string" || body.upscaledFromId === null)
        ? (body.upscaledFromId as string | null) : undefined,
      outW: typeof body.outW === "number" ? body.outW : undefined,
      outH: typeof body.outH === "number" ? body.outH : undefined,
      upMp: typeof body.upMp === "number" ? body.upMp : undefined,
      upFactor: typeof body.upFactor === "number" ? body.upFactor : undefined,
      upModel: typeof body.upModel === "string" ? body.upModel : undefined,
      lineage: typeof body.lineage === "string" ? body.lineage : undefined,
    });
    return json({ ok, patched: ok });
  }

  // ── Per-user storage meter (used + cap), for the library "storage" UI and
  // the future Stripe "buy more" upsell. Session-gated.
  if (path === "/api/storage" && req.method === "GET") {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    const userHash = await verifySessionToken(token);
    if (!userHash) return json({ error: "Sign in.", code: "auth_required" }, 401);
    return json(await userUsage(userHash));
  }

  // ── Zero-knowledge document store (prompts, particles, settings, styles,
  // recent, folders, models, formula-presets). Fly /data is the source of
  // truth; R2 is the offsite snapshot. The server stores OPAQUE CIPHERTEXT +
  // IV only — content is AES-GCM-encrypted client-side with the DATA KEY, so
  // these routes never see plaintext. All session-gated.
  //
  //   GET    /api/data                      -> list index (no ciphertext)
  //   GET    /api/data/<docKey>             -> { iv, ct(b64), ver, updatedAt }
  //   PUT    /api/data/<docKey>  {iv,ct}     -> { ver, updatedAt }
  //   DELETE /api/data/<docKey>
  //   POST   /api/data/snapshot             -> snapshot ALL docs to R2
  //   POST   /api/data/<docKey>/restore     -> restore one doc from R2
  if (path === "/api/data" && req.method === "GET") {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    const userHash = await verifySessionToken(token);
    if (!userHash) return json({ error: "Sign in.", code: "auth_required" }, 401);
    return json({ docs: await listDocs(userHash) });
  }

  if (path === "/api/data/snapshot" && req.method === "POST") {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    const userHash = await verifySessionToken(token);
    if (!userHash) return json({ error: "Sign in.", code: "auth_required" }, 401);
    const n = await snapshotAllToR2(userHash);
    return json({ ok: true, snapshotted: n });
  }

  if (path.startsWith("/api/data/")) {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    const userHash = await verifySessionToken(token);
    if (!userHash) return json({ error: "Sign in.", code: "auth_required" }, 401);

    // Parse "/api/data/<docKey>" or "/api/data/<docKey>/restore".
    const rest = path.slice("/api/data/".length);
    const restoreMatch = /^([a-z0-9-]+)\/restore$/.exec(rest);
    if (restoreMatch && req.method === "POST") {
      const docKey = restoreMatch[1];
      if (!isAllowedDocKey(docKey)) return json({ error: "Unknown doc.", code: "bad_request" }, 400);
      try {
        const ok = await restoreDocFromR2(userHash, docKey);
        return json({ ok, restored: ok });
      } catch (e) {
        console.error("data restore failed", docKey, (e as Error).message);
        return json({ error: "Restore failed.", code: "server_error" }, 500);
      }
    }

    const docKey = rest;
    if (!isAllowedDocKey(docKey)) return json({ error: "Unknown doc.", code: "bad_request" }, 400);

    if (req.method === "GET") {
      const doc = await getDoc(userHash, docKey);
      if (!doc) return json({ error: "Not found.", code: "not_found" }, 404);
      return json({
        iv: doc.iv,
        ct: encodeBase64(doc.ct),
        ver: doc.ver,
        updatedAt: doc.updatedAt,
      });
    }

    if (req.method === "PUT") {
      let body: Record<string, unknown>;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON", code: "bad_request" }, 400); }
      const iv = String(body.iv ?? "");
      const ctB64 = String(body.ct ?? "");
      if (!iv || !ctB64) return json({ error: "iv and ct required", code: "bad_request" }, 400);
      let ct: Uint8Array;
      try { ct = decodeBase64(ctB64); } catch { return json({ error: "ct not base64", code: "bad_request" }, 400); }
      // Soft cap: refuse absurd payloads (10 MB ciphertext) so a bug can't fill
      // the volume in one write. Real docs are KB-scale.
      if (ct.length > 10 * 1024 * 1024) return json({ error: "Doc too large.", code: "too_large" }, 413);
      try {
        const out = await putDoc(userHash, docKey, iv, ct);
        return json({ ok: true, ...out });
      } catch (e) {
        console.error("data put failed", docKey, (e as Error).message);
        return json({ error: "Save failed.", code: "server_error" }, 500);
      }
    }

    if (req.method === "DELETE") {
      await deleteDoc(userHash, docKey);
      return json({ ok: true });
    }

    return json({ error: "Method not allowed", code: "bad_method" }, 405);
  }

  // ── Curated model list for the dropdown (instant, no upstream call).
  if (path === "/api/models" && req.method === "GET") {
    return json({ groups: catalogByFamily() });
  }

  // ── Curated upscaler list for the Upscaler tab. Each entry carries the
  // config surface (megapixels vs diffusion) the frontend renders, plus the
  // flat token price so the UI can show the cost before running.
  if (path === "/api/upscalers" && req.method === "GET") {
    const models = UPSCALERS.map((u) => ({
      ...u,
      tokens: tokensPerUpscale(u.id, { targetMegapixels: u.kind === "megapixels" ? (u.targetMegapixels?.default) : undefined }),
      tokensByMp: u.kind === "megapixels"
        ? { low: tokensPerUpscale(u.id, { targetMegapixels: 1 }), high: tokensPerUpscale(u.id, { targetMegapixels: 8 }) }
        : undefined,
    }));
    return json({ models });
  }

  // ── Token price table (Pass 3 pricing foundation). Read-only, public:
  // the frontend labels the model dropdown and pre-flight quotes from this.
  // Charging happens in the ledger (next step) — this endpoint never mutates.
  if (path === "/api/pricing" && req.method === "GET") {
    return json(pricingTable());
  }

  // ── Single-request quote: ?model=...&count=2&resolution=2K&quality=high
  //    &renderingSpeed=TURBO — returns the exact integer tokens the ledger
  //    would hold. Frontend shows this next to the Generate button.
  if (path === "/api/pricing/quote" && req.method === "GET") {
    const model = url.searchParams.get("model") ?? "";
    if (!model) return json({ error: "model required", code: "bad_request" }, 400);
    return json(quote(model, {
      resolution: url.searchParams.get("resolution") ?? undefined,
      width: Number(url.searchParams.get("width")) || undefined,
      height: Number(url.searchParams.get("height")) || undefined,
      quality: url.searchParams.get("quality") ?? undefined,
      renderingSpeed: url.searchParams.get("renderingSpeed") ?? undefined,
    }, Number(url.searchParams.get("count")) || 1));
  }

  // ── Per-model default params.
  if (path === "/api/models/defaults" && req.method === "GET") {
    const id = url.searchParams.get("id") ?? "";
    const entry = findInCatalog(id);
    return json(defaultsFor(entry?.architecture));
  }

  // ── Live model search across Runware's catalogue (CivitAI + hosted).
  if (path === "/api/models/search" && req.method === "GET") {
    const q = (url.searchParams.get("q") ?? "").trim();
    const arch = url.searchParams.get("arch") ?? undefined;
    const limit = Number(url.searchParams.get("limit")) || 20;
    const offset = Number(url.searchParams.get("offset")) || 0;
    try {
      const out = await searchModels({ search: q, architecture: arch, limit, offset });
      return json(out);
    } catch (e) {
      if (e instanceof ProviderError) return json({ error: e.message, code: e.code }, e.status);
      console.error("model search failed", e);
      return json({ error: "Internal error" }, 500);
    }
  }

  // ── Google OAuth (server-side code flow — durable Drive connection). ─────────
  const oauthResponse = await handleOAuth(req, url);
  if (oauthResponse) return oauthResponse;

  // ── Account / auth / email / recovery: handled by auth.ts (Pass 1). ──────────
  const authResponse = await handleAuth(req, url);
  if (authResponse) return authResponse;

  // ── Admin: handshake + account management (admin.ts). ──────────────────────
  if (path.startsWith("/admin/")) return handleAdmin(req, path);

  // ── Still-unbuilt routes (Pass 2+): passkeys, MFA, settings sync,
  // webhooks. Routed by Caddy; 501 makes "planned but unimplemented" explicit.
  if (
    path.startsWith("/key/") || path.startsWith("/device/") ||
    path.startsWith("/passkey/") || path.startsWith("/mfa/") ||
    path.startsWith("/settings/") ||
    path.startsWith("/webhook/")
  ) {
    return json({ error: "Not implemented yet", code: "not_implemented" }, 501);
  }

  // Anything else shouldn't reach Deno (Caddy serves static files), but just in case:
  return json({ error: "Not found" }, 404);
}

console.log(`Beast Mode backend listening on :${PORT}`);

// ── Background queue boot ────────────────────────────────────────────────────
// Re-claim any job left "running" by a previous crash/restart (flips it back to
// "queued"), then start the worker loop. Both are safe to run before serving;
// the worker also auto-starts on the first enqueue.
reclaimOrphans((job) =>
  refundHold(job.userHash, job.holdRef, job.quotedTotal, "orphan_giveup")
    .then(() => undefined)
)
  .then((n) => { if (n) console.log(`Reclaimed ${n} orphaned job(s) after restart.`); })
  .catch((e) => console.error("orphan reclaim failed:", (e as Error).message))
  .finally(() => startWorker());

// Probe the ZK doc volume at boot — warn-not-block (local dev has no /data).
dataDocsEnabled()
  .then((ok) => { if (!ok) console.warn("kv-store: doc persistence disabled (/data not writable)"); })
  .catch((e) => console.warn("kv-store boot probe failed:", (e as Error).message));

Deno.serve({ port: PORT }, handler);
