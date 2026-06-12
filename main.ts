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
import { rehostToR2, rehostBytesToR2, r2Enabled, trimR2ToNewest, presignR2Put, presignR2Get } from "./r2.js";
import { handleAuth, verifySessionToken } from "./auth.ts";
import { handleAdmin } from "./admin.ts";
import { handleOAuth } from "./oauth.ts";

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
      // Snap rule comes from the curated catalog: closed/preset models (snap:
      // false) need EXACT dims; unknown/community models default to /64 snap.
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
        // Clamp count server-side: protects Runware spend even if the client
        // is tampered with. UI offers 1–4. (Clamped above — the token hold and
        // the provider request must always agree on the batch size.)
        count: genCount,
        seed: body.seed as number | undefined,
        referenceImages: body.referenceImages as string[] | undefined,
        resolution: body.resolution as string | undefined,
        aspectRatio: body.aspectRatio as string | undefined,
        quality: body.quality as string | undefined,
        renderingSpeed: body.renderingSpeed as string | undefined,
        snapDims,
      });

      // ── Re-host to R2 so saved images don't break when Runware URLs expire.
      // Graceful: if R2 isn't configured or an upload fails, keep the original
      // URL so generation still succeeds.
      if (r2Enabled()) {
        await Promise.all(
          result.images.map(async (img: { url?: string; b64?: string; mimeType?: string }) => {
            try {
              if (img.b64) {
                // ── Byte-bearing provider (direct Gemini). Decode the base64
                // ONCE to bytes, upload, return only the short R2 URL. The
                // base64 is then dropped so it's never serialized to the client
                // — this is the fix for the 4K-image OOM on small machines.
                const mime = img.mimeType || "image/png";
                const ext = mime.split("/")[1]?.replace("jpeg", "jpg").slice(0, 4) || "png";
                const bytes = decodeBase64(img.b64);
                const key = `gen/${userHash}/${crypto.randomUUID()}.${ext}`;
                img.url = await rehostBytesToR2(bytes, mime, key);
                delete img.b64;            // free it — never sent to the client
                delete img.mimeType;
              } else if (img.url) {
                // ── URL-bearing provider (Runware). Fetch + rehost as before.
                const ext = img.url.split("?")[0].split(".").pop()?.slice(0, 4) || "jpg";
                const key = `gen/${userHash}/${crypto.randomUUID()}.${ext}`;
                img.url = await rehostToR2(img.url, key);
              }
            } catch (e) {
              // Graceful: if R2 upload fails for a byte-bearing image we have no
              // public URL to fall back to, so surface a data URI as a last
              // resort (keeps generation working; larger response, rare path).
              if (img.b64) {
                img.url = `data:${img.mimeType || "image/png"};base64,${img.b64}`;
                delete img.b64; delete img.mimeType;
              }
              console.warn("R2 rehost failed, keeping original:", (e as Error).message);
            }
          }),
        );
        // FIFO retention: keep only this user's newest 5 images on R2. Their
        // durable copies belong in their own Drive/Dropbox; R2 is a hot cache.
        // Fire-and-forget — a trim failure must never break generation.
        trimR2ToNewest(`gen/${userHash}/`, 5).catch((e) =>
          console.warn("R2 trim failed (non-fatal):", (e as Error).message)
        );
      }

      // ── SETTLE: charge for images actually delivered, refund the rest.
      // Actual provider cost goes to the ledger for margin tracking only:
      // Runware reports costUsd; direct Gemini is computed from usageMetadata;
      // otherwise fall back to the table's estimate.
      const delivered = result.images.length;
      const charged = Math.min(q.totalTokens, q.perImage * delivered);
      const rawUsage = (result.raw && typeof result.raw === "object")
        ? (result.raw as Record<string, unknown>).usageMetadata
        : undefined;
      const actualCostUsd = (typeof result.costUsd === "number" ? result.costUsd : null)
        ?? geminiUsageCostUsd(body.model as string, rawUsage)
        ?? estimatedCostUsd(body.model as string, genOpts);
      const settled = await settleHold(userHash, hold.ref, {
        chargedTokens: charged,
        refundTokens: q.totalTokens - charged,
        model: body.model as string,
        images: delivered,
        actualCostUsd,
      });

      // NOTE: result.costUsd (raw provider cost) is deliberately NOT returned —
      // users pay the token table price; provider cost is margin-private and
      // lives only in the ledger. `ref` lets the client stamp saved library
      // items so the settings activity view can link a charge to its image.
      return json({
        model: result.model,
        provider: result.provider,
        images: result.images,
        tokens: { charged, perImage: q.perImage, balance: settled.balance, ref: hold.ref },
      });
    } catch (e) {
      // ── REFUND: the provider call failed — return the entire hold. Never
      // let a refund failure mask the original error.
      await refundHold(userHash, hold.ref, q.totalTokens,
        e instanceof ProviderError ? `provider:${e.code}` : "internal_error",
      ).catch((re) => console.error("CRITICAL: refund failed after generate error:", (re as Error).message));
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
      const result = await upscale({
        model: upModel,
        inputImage: body.inputImage as string,
        outputFormat: body.outputFormat as string | undefined,
        outputQuality: body.outputQuality as number | undefined,
        // P-Image
        targetMegapixels: body.targetMegapixels as number | undefined,
        enhanceDetails: body.enhanceDetails as boolean | undefined,
        realism: body.realism as boolean | undefined,
        // Diffusion upscalers (Clarity / SD Latent)
        upscaleFactor: body.upscaleFactor as number | undefined,
        positivePrompt: body.positivePrompt as string | undefined,
        negativePrompt: body.negativePrompt as string | undefined,
        steps: body.steps as number | undefined,
        CFGScale: body.CFGScale as number | undefined,
        strength: body.strength as number | undefined,
        seed: body.seed as number | undefined,
      });

      // ── Re-host to R2 (same hot-cache policy as generation). Graceful on
      // failure: keep the Runware URL so the upscale still succeeds.
      const out = result.image as { url: string; b64?: string };
      if (r2Enabled() && out?.url) {
        try {
          const ext = out.url.split("?")[0].split(".").pop()?.slice(0, 4) || "jpg";
          const key = `gen/${userHash}/${crypto.randomUUID()}.${ext}`;
          out.url = await rehostToR2(out.url, key);
        } catch (e) {
          console.warn("R2 rehost failed (upscale), keeping original URL:", (e as Error).message);
        }
        trimR2ToNewest(`gen/${userHash}/`, 5).catch((e) =>
          console.warn("R2 trim failed (non-fatal):", (e as Error).message)
        );
      }

      // ── SETTLE: one image delivered → charge the full quote. Provider cost
      // (Runware costUsd, or the table estimate) goes to the ledger for margin
      // tracking only — never billed, never returned to the client.
      const delivered = out?.url ? 1 : 0;
      const charged = delivered ? q.totalTokens : 0;
      const actualCostUsd = (typeof result.costUsd === "number" ? result.costUsd : null)
        ?? estimatedUpscaleCostUsd(upModel, upOpts);
      const settled = await settleHold(userHash, hold.ref, {
        chargedTokens: charged,
        refundTokens: q.totalTokens - charged,
        model: upModel,
        images: delivered,
        actualCostUsd,
      });

      if (!delivered) {
        return json({ error: "Upscaler returned no image.", code: "upstream" }, 502);
      }
      return json({
        model: result.model,
        provider: result.provider,
        image: out,
        tokens: { charged, perImage: q.perImage, balance: settled.balance, ref: hold.ref },
      });
    } catch (e) {
      await refundHold(userHash, hold.ref, q.totalTokens,
        e instanceof ProviderError ? `provider:${e.code}` : "internal_error",
      ).catch((re) => console.error("CRITICAL: refund failed after upscale error:", (re as Error).message));
      if (e instanceof ProviderError) return json({ error: e.message, code: e.code }, e.status);
      console.error("upscale failed", e);
      return json({ error: "Internal error" }, 500);
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
Deno.serve({ port: PORT }, handler);
