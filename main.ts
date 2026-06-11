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
if (missing.length) {
  console.error(`FATAL: missing required secret(s): ${missing.join(", ")}`);
  console.error("Set them with: fly secrets set KEY=value --app beast-mode");
  Deno.exit(1);
}

// Provider abstraction (the modules we built). Note: import as .js — Deno runs
// them directly. generate() picks the provider from the model-id prefix.
import { generate, searchModels, ProviderError } from "./index.js";
import { catalogByFamily, findInCatalog, defaultsFor } from "./catalog.js";
import { rehostToR2, r2Enabled, trimR2ToNewest } from "./r2.js";
import { handleAuth, verifySessionToken } from "./auth.ts";
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
        // is tampered with. UI offers 1–4.
        count: Math.max(1, Math.min(4, Number(body.count) || 1)),
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
          result.images.map(async (img: { url: string }) => {
            if (!img.url) return;
            try {
              // Gemini direct models return data: URIs (base64) — Deno's fetch
              // handles those, but the extension must come from the mime type.
              const dataMime = /^data:image\/([a-z0-9+]+);base64,/i.exec(img.url);
              const ext = dataMime
                ? (dataMime[1] === 'jpeg' ? 'jpg' : dataMime[1].slice(0, 4))
                : (img.url.split("?")[0].split(".").pop()?.slice(0, 4) || "jpg");
              // Per-user prefix so retention is per user, not global.
              const key = `gen/${userHash}/${crypto.randomUUID()}.${ext}`;
              const original = img.url;
              img.url = await rehostToR2(img.url, key);
              // Keep the PRISTINE bytes alongside the R2 URL: the browser uses
              // them for the Drive/IndexedDB copies, so a flaky/blocked R2
              // public URL can never corrupt the durable backups.
              if (dataMime) (img as Record<string, unknown>).pristine = original;
            } catch (e) {
              console.warn("R2 rehost failed, keeping original URL:", (e as Error).message);
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

      return json({
        model: result.model,
        provider: result.provider,
        images: result.images,
        costUsd: result.costUsd,
      });
    } catch (e) {
      if (e instanceof ProviderError) return json({ error: e.message, code: e.code }, e.status);
      console.error("generate failed", e);
      return json({ error: "Internal error" }, 500);
    }
  }

  // ── Curated model list for the dropdown (instant, no upstream call).
  if (path === "/api/models" && req.method === "GET") {
    return json({ groups: catalogByFamily() });
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

  // ── Still-unbuilt routes (Pass 2+): passkeys, MFA, settings sync, admin,
  // webhooks. Routed by Caddy; 501 makes "planned but unimplemented" explicit.
  if (
    path.startsWith("/key/") || path.startsWith("/device/") ||
    path.startsWith("/passkey/") || path.startsWith("/mfa/") ||
    path.startsWith("/admin/") || path.startsWith("/settings/") ||
    path.startsWith("/webhook/")
  ) {
    return json({ error: "Not implemented yet", code: "not_implemented" }, 501);
  }

  // Anything else shouldn't reach Deno (Caddy serves static files), but just in case:
  return json({ error: "Not found" }, 404);
}

console.log(`Beast Mode backend listening on :${PORT}`);
Deno.serve({ port: PORT }, handler);
