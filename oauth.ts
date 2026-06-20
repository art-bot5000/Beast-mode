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
import { storeImage, listManifest } from "./data-store.ts";

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

// ── helper: mint a fresh access token from a user's stored refresh token ──────
// Shared by /token and the one-time /merge. Returns the access token, or an
// error shape. Cleans up the stored record on invalid_grant (user revoked).
async function mintAccessToken(
  emailHash: string,
): Promise<{ token: string; email?: string; expiresIn: number } | { error: string; code: string; status: number }> {
  const rec = await kv.get<GDriveRecord>(["gdrive", emailHash]);
  if (!rec.value) return { error: "Google Drive not connected", code: "not_connected", status: 404 };

  const secret = clientSecret();
  if (!secret) return { error: "Not configured", code: "not_configured", status: 503 };

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
      if (tok.error === "invalid_grant") {
        await kv.delete(["gdrive", emailHash]);
        return { error: "Drive access was revoked — reconnect", code: "not_connected", status: 404 };
      }
      throw new Error(JSON.stringify(tok).slice(0, 200));
    }
    // Google returns expires_in (seconds, normally 3599). The client schedules
    // its NEXT refresh from this, so it MUST be a finite positive number — a
    // missing value made the client compute setTimeout(..., NaN) → fire at 0ms →
    // an unbounded /oauth/google/token refresh storm. Default defensively.
    const expiresIn = (typeof tok.expires_in === "number" && tok.expires_in > 0)
      ? tok.expires_in : 3600;
    return { token: tok.access_token as string, email: rec.value.email, expiresIn };
  } catch (e) {
    console.error("Token refresh failed:", (e as Error).message);
    return { error: "Token refresh failed", code: "upstream", status: 502 };
  }
}

// ── token: mint a fresh access token from the stored refresh token ───────────
async function oauthToken(req: Request): Promise<Response> {
  const emailHash = await bearerUser(req);
  if (!emailHash) return json({ error: "Sign in first", code: "auth_required" }, 401);
  const r = await mintAccessToken(emailHash);
  if ("error" in r) return json({ error: r.error, code: r.code }, r.status);
  return json({ accessToken: r.token, email: r.email, expiresIn: r.expiresIn });
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

// ── one-time merge: pull every image from the visible "Beast Mode" Drive folder
// into the durable Fly /data store, so the library no longer relies on Drive.
//
// Why server-side: the server already holds the user's refresh token (durable
// connect flow), so it can mint a token and read the app-created folder under
// drive.file scope — no in-app Drive login required. Idempotent: any favId
// already present in the Fly manifest is SKIPPED, so it's safe to run twice.
//
// Filename contract: images were uploaded as `beast-mode-<favId>.jpg` (and
// `beast-mode-<favId>-markup.jpg`). We parse the favId from the name so the
// merged copy keeps its ORIGINAL identity — preserving upscale linkage (ids in
// upscaledFromId / upscaleIds) and createdAt ordering. Files whose names don't
// match are skipped (not Beast-Mode-generated).
const DRIVE_FILES_API = "https://www.googleapis.com/drive/v3/files";
const FAVID_RE = /beast-mode-(\d{8,20})(?:-[a-z0-9]+)?\.(jpe?g|png|webp)$/i;

async function oauthMerge(req: Request): Promise<Response> {
  const emailHash = await bearerUser(req);
  if (!emailHash) return json({ error: "Sign in first", code: "auth_required" }, 401);

  const minted = await mintAccessToken(emailHash);
  if ("error" in minted) return json({ error: minted.error, code: minted.code }, minted.status);
  const accessToken = minted.token;
  const authHdr = { Authorization: `Bearer ${accessToken}` };

  // Existing Fly favIds — skip these so the merge never duplicates.
  const existing = new Set<string>();
  try {
    for (const m of await listManifest(emailHash)) existing.add(String(m.favId));
  } catch { /* empty store is fine */ }

  // 1) Locate the "Beast Mode" folder (created by this app, so drive.file sees it).
  let folderId: string | null = null;
  try {
    const q = encodeURIComponent(
      "mimeType='application/vnd.google-apps.folder' and name='Beast Mode' and trashed=false",
    );
    const res = await fetch(`${DRIVE_FILES_API}?q=${q}&fields=files(id,name)&pageSize=10`, { headers: authHdr });
    if (!res.ok) {
      const t = await res.text();
      console.error("merge: folder lookup failed", res.status, t.slice(0, 200));
      return json({ error: "Drive folder lookup failed", code: "upstream" }, 502);
    }
    const data = await res.json();
    const files = Array.isArray(data.files) ? data.files : [];
    if (files.length) folderId = files[0].id;
  } catch (e) {
    console.error("merge: folder lookup error", (e as Error).message);
    return json({ error: "Drive folder lookup error", code: "upstream" }, 502);
  }
  if (!folderId) {
    return json({ ok: true, folderFound: false, found: 0, merged: 0, skipped: 0, failed: 0, note: "No 'Beast Mode' folder found in Drive." });
  }

  // 2) Page through every image file in the folder.
  const driveFiles: Array<{ id: string; name: string }> = [];
  let pageToken: string | undefined;
  try {
    do {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
      // Build the URL manually so the Drive query operators aren't double-encoded.
      let urlStr = `${DRIVE_FILES_API}?q=${q}&fields=${encodeURIComponent("nextPageToken,files(id,name,mimeType)")}&pageSize=100`;
      if (pageToken) urlStr += `&pageToken=${encodeURIComponent(pageToken)}`;
      const res = await fetch(urlStr, { headers: authHdr });
      if (!res.ok) {
        const t = await res.text();
        console.error("merge: list failed", res.status, t.slice(0, 200));
        return json({ error: "Drive file list failed", code: "upstream" }, 502);
      }
      const data = await res.json();
      for (const f of (Array.isArray(data.files) ? data.files : [])) {
        if (f && f.id && f.name) driveFiles.push({ id: f.id, name: f.name });
      }
      pageToken = data.nextPageToken || undefined;
    } while (pageToken);
  } catch (e) {
    console.error("merge: list error", (e as Error).message);
    return json({ error: "Drive file list error", code: "upstream" }, 502);
  }

  // 3) For each file: parse favId, skip if already stored, else download + store.
  let merged = 0, skipped = 0, failed = 0, unmatched = 0;
  for (const f of driveFiles) {
    const m = FAVID_RE.exec(f.name);
    if (!m) { unmatched++; continue; }
    const favId = m[1];
    if (existing.has(favId)) { skipped++; continue; }
    try {
      const dl = await fetch(`${DRIVE_FILES_API}/${f.id}?alt=media`, { headers: authHdr });
      if (!dl.ok) { failed++; continue; }
      const ct = dl.headers.get("content-type") || "";
      const buf = new Uint8Array(await dl.arrayBuffer());
      // Guard: refuse anything that isn't a real image (Drive can hand back HTML
      // error bodies on transient failures).
      if (!/^image\//i.test(ct) || buf.length < 512) { failed++; continue; }
      const mime = ct.split(";")[0].trim();
      // Preserve original creation order: the favId IS a Date.now() timestamp.
      const createdAt = Number(favId) || undefined;
      await storeImage(emailHash, favId, buf, mime, createdAt);
      existing.add(favId); // in case the folder has dup names for one favId
      merged++;
    } catch (e) {
      console.error("merge: store failed for", f.name, (e as Error).message);
      failed++;
    }
  }

  return json({
    ok: true,
    folderFound: true,
    found: driveFiles.length,
    merged,
    skipped,
    failed,
    unmatched,
  });
}
export async function handleOAuth(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (path === "/oauth/google/start" && req.method === "POST") return oauthStart(req);
  if (path === "/oauth/google/callback" && req.method === "GET") return oauthCallback(url);
  if (path === "/oauth/google/token" && req.method === "POST") return oauthToken(req);
  if (path === "/oauth/google/merge" && req.method === "POST") return oauthMerge(req);
  if (path === "/oauth/google/disconnect" && req.method === "POST") return oauthDisconnect(req);
  return null;
}
