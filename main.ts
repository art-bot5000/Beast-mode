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
if (missing.length) {
  console.error(`FATAL: missing required secret(s): ${missing.join(", ")}`);
  console.error("Set them with: fly secrets set KEY=value --app beast-mode");
  Deno.exit(1);
}

// Provider abstraction (the modules we built). Note: import as .js — Deno runs
// them directly. generate() picks the provider from the model-id prefix.
import { generate, searchModels, ProviderError } from "./providers/index.js";
import { catalogByFamily, findInCatalog, defaultsFor } from "./providers/catalog.js";

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

  // ── Generation proxy: the key is attached HERE, server-side, never sent down.
  if (path === "/api/generate" && req.method === "POST") {
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
      const result = await generate({
        prompt: body.prompt as string,
        negativePrompt: body.negativePrompt as string | undefined,
        model: body.model as string,
        width: body.width as number | undefined,
        height: body.height as number | undefined,
        steps: body.steps as number | undefined,
        cfgScale: body.cfgScale as number | undefined,
        count: body.count as number | undefined,
        seed: body.seed as number | undefined,
      });
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

  // ── Account / auth / settings: NOT BUILT YET. ───────────────────────────────
  // These prefixes are routed by Caddy; returning 501 (not 404) makes it explicit
  // they're planned-but-unimplemented rather than missing/misrouted.
  if (
    path.startsWith("/user/") || path.startsWith("/key/") || path.startsWith("/device/") ||
    path.startsWith("/passkey/") || path.startsWith("/mfa/") || path.startsWith("/recovery/") ||
    path.startsWith("/email/") || path.startsWith("/admin/") || path.startsWith("/settings/") ||
    path.startsWith("/webhook/")
  ) {
    return json({ error: "Not implemented yet", code: "not_implemented" }, 501);
  }

  // Anything else shouldn't reach Deno (Caddy serves static files), but just in case:
  return json({ error: "Not found" }, 404);
}

console.log(`Beast Mode backend listening on :${PORT}`);
Deno.serve({ port: PORT }, handler);
