// oauth.ts — Server-side Google OAuth (authorization-code flow with refresh tokens)
//
// WHY THIS EXISTS: the old browser-only GIS flow issues 1-hour access tokens
// with no refresh token; when silent refresh fails (third-party-cookie blocking,
// sleeping tabs) Drive silently disconnects and every save no-ops. This module
// fixes that root cause: the user consents ONCE, we store a long-lived REFRESH
// TOKEN tied to their app account, and mint fresh access tokens on demand.
// Drive then stays connected for as long as they're signed into the app.
//
// Endpoints:
//   POST /oauth/google/start       (auth: Bearer session) -> { url } to redirect to
//   GET  /oauth/google/callback    Google redirects here with ?code&state
//   POST /oauth/google/token       (auth: Bearer session) -> { accessToken, expiresIn, email }
//   POST /oauth/google/disconnect  (auth: Bearer session) -> { ok }
//
// Secrets/env:
//   GOOGLE_CLIENT_SECRET  (Fly secret — required for this feature)
//   GOOGLE_CLIENT_ID      (optional env; defaults to the app's known client id)
//   APP_ORIGIN            (optional env; defaults to https://beast-mode.fly.dev)
//
// Scopes requested: openid email  -> lets us show "connected as x@y"
//   drive.appdata  -> existing prompt/settings sync (hidden app folder)
//   drive.file     -> NEW: visible "Beast Mode" folder for generated images
//                     (only files this app creates — not the user's whole Drive)
//
// Honest trade-off, by design: the refresh token is stored server-readable in
// KV (it must be — the server uses it to mint tokens). Scopes are narrow
// (app-created files + appdata only), and this matches the architecture choice
// that Drive content is the "portable zone", not the zero-knowledge zone.

import { kv, verifySessionToken } from "./auth.ts";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";

const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ||
  "115162218034-eoub6c46sqcmhamb72hoj3l69ov1321d.apps.googleusercontent.com";
const APP_ORIGIN = Deno.env.get("APP_ORIGIN") || "https://beast-mode.fly.dev";
const REDIRECT_URI = `${APP_ORIGIN}/oauth/google/callback`;
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/drive.appdata",
  "https://www.googleapis.com/auth/drive.file",
].join(" ");

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function clientSecret(): string | null {
  return Deno.env.get("GOOGLE_CLIENT_SECRET") ?? null;
}

function bearerUser(req: Request): Promise<string | null> {
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  return verifySessionToken(token);
}

interface GDriveRecord {
  refreshToken: string;
  email?: string;
  connectedAt: number;
}

// ── start: create a state nonce bound to the app user, hand back consent URL ──
async function oauthStart(req: Request): Promise<Response> {
  if (!clientSecret()) {
    return json({ error: "Google OAuth not configured on server", code: "not_configured" }, 503);
  }
  const emailHash = await bearerUser(req);
  if (!emailHash) return json({ error: "Sign in first", code: "auth_required" }, 401);

  const state = crypto.randomUUID();
  await kv.set(["oauthstate", state], { emailHash }, { expireIn: 10 * 60 * 1000 });

  const url = `${GOOGLE_AUTH}?` + new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",   // <- this is what makes Google issue a refresh token
    prompt: "consent",        // <- force re-consent so a refresh token is ALWAYS returned
    state,
  }).toString();

  return json({ url });
}

// ── callback: Google lands here; exchange the code, store the refresh token ──
async function oauthCallback(url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errParam = url.searchParams.get("error");

  const back = (flag: string) =>
    new Response(null, { status: 302, headers: { Location: `/?drive=${flag}` } });

  if (errParam) return back("denied");
  if (!code || !state) return back("error");

  const st = await kv.get<{ emailHash: string }>(["oauthstate", state]);
  if (!st.value) return back("error"); // unknown/expired state — possible CSRF, reject
  await kv.delete(["oauthstate", state]);
  const emailHash = st.value.emailHash;

  const secret = clientSecret();
  if (!secret) return back("error");

  // Exchange the authorization code for tokens.
  let tok: Record<string, unknown>;
  try {
    const res = await fetch(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: secret,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    tok = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(tok).slice(0, 200));
  } catch (e) {
    console.error("OAuth code exchange failed:", (e as Error).message);
    return back("error");
  }

  const refreshToken = tok.refresh_token as string | undefined;
  if (!refreshToken) {
    // Can happen if Google didn't re-issue one; prompt=consent should prevent this.
    console.error("No refresh_token in exchange response");
    return back("error");
  }

  // Pull the email out of the id_token for display (decode payload only — we
  // received this directly from Google over TLS, not from the user).
  let email: string | undefined;
  try {
    const idTok = tok.id_token as string | undefined;
    if (idTok) {
      const payload = JSON.parse(atob(idTok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      email = payload.email;
    }
  } catch { /* cosmetic only */ }

  const rec: GDriveRecord = { refreshToken, email, connectedAt: Date.now() };
  await kv.set(["gdrive", emailHash], rec);
  return back("connected");
}

// ── token: mint a fresh access token from the stored refresh token ───────────
async function oauthToken(req: Request): Promise<Response> {
  const emailHash = await bearerUser(req);
  if (!emailHash) return json({ error: "Sign in first", code: "auth_required" }, 401);

  const rec = await kv.get<GDriveRecord>(["gdrive", emailHash]);
  if (!rec.value) return json({ error: "Google Drive not connected", code: "not_connected" }, 404);

  const secret = clientSecret();
  if (!secret) return json({ error: "Not configured", code: "not_configured" }, 503);

  try {
    const res = await fetch(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: rec.value.refreshToken,
        client_id: CLIENT_ID,
        client_secret: secret,
        grant_type: "refresh_token",
      }),
    });
    const tok = await res.json();
    if (!res.ok) {
      // invalid_grant = user revoked access in their Google account; clean up.
      if (tok.error === "invalid_grant") {
        await kv.delete(["gdrive", emailHash]);
        return json({ error: "Drive access was revoked — reconnect", code: "not_connected" }, 404);
      }
      throw new Error(JSON.stringify(tok).slice(0, 200));
    }
    return json({
      accessToken: tok.access_token,
      expiresIn: tok.expires_in,
      email: rec.value.email,
    });
  } catch (e) {
    console.error("Token refresh failed:", (e as Error).message);
    return json({ error: "Token refresh failed", code: "upstream" }, 502);
  }
}

// ── disconnect: forget + best-effort revoke ──────────────────────────────────
async function oauthDisconnect(req: Request): Promise<Response> {
  const emailHash = await bearerUser(req);
  if (!emailHash) return json({ error: "Sign in first", code: "auth_required" }, 401);
  const rec = await kv.get<GDriveRecord>(["gdrive", emailHash]);
  if (rec.value) {
    // Best-effort revoke at Google; ignore failures.
    fetch(`${GOOGLE_REVOKE}?token=${encodeURIComponent(rec.value.refreshToken)}`, { method: "POST" })
      .catch(() => {});
    await kv.delete(["gdrive", emailHash]);
  }
  return json({ ok: true });
}

// ── Router ────────────────────────────────────────────────────────────────────
export async function handleOAuth(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (path === "/oauth/google/start" && req.method === "POST") return oauthStart(req);
  if (path === "/oauth/google/callback" && req.method === "GET") return oauthCallback(url);
  if (path === "/oauth/google/token" && req.method === "POST") return oauthToken(req);
  if (path === "/oauth/google/disconnect" && req.method === "POST") return oauthDisconnect(req);
  return null;
}
