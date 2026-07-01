// providers/google.js
//
// Direct Google Gemini ("Nano Banana") image adapter. Talks to the public
// Generative Language REST API (NOT via Runware), so these models use YOUR
// Google key and bill on YOUR Google account — matching the "DIRECT Google API"
// label in the Image Gen dropdown.
//
// API shape (verified against ai.google.dev/gemini-api/docs/image-generation,
// June 2026):
//   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//   Header: x-goog-api-key: <GEMINI_API_KEY>
//   Body: {
//     contents: [{ parts: [ {text}, {inlineData:{mimeType,data}}… ] }],
//     generationConfig: {
//       responseModalities: ["TEXT","IMAGE"],
//       imageConfig: { aspectRatio, imageSize }   // imageSize: "1K"|"2K"|"4K"
//     }
//   }
//   Response: { candidates:[{ content:{ parts:[ {inlineData:{mimeType,data}} ] }}],
//               usageMetadata:{…} }
//
// Canonical model ids handled here (the part after "google:" is the Gemini id):
//   "google:gemini-3-pro-image"     -> Nano Banana Pro
//   "google:gemini-3.1-flash-image" -> Nano Banana 2
//   "google:gemini-3.1-flash-lite-image" -> Nano Banana 2 Lite
//   "google:gemini-2.5-flash-image" -> Nano Banana (2.5)

import { ProviderError, parseModelId } from './index.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Models this adapter serves, with which extra config each accepts. Only the
// 3-series accepts an explicit image size; 2.5 Flash ignores it.
const GEMINI_MODELS = {
  'gemini-3-pro-image':          { sizes: true },
  'gemini-3.1-flash-image':      { sizes: true },
  'gemini-3.1-flash-lite-image': { sizes: true },
  'gemini-2.5-flash-image':      { sizes: false },
};

function apiKey() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) {
    throw new ProviderError('GEMINI_API_KEY is not set — direct Gemini (Nano Banana) models are unavailable.', {
      provider: 'google', code: 'auth', status: 503,
    });
  }
  return k;
}

/** Split a "data:image/png;base64,AAAA" URI into { mimeType, data }. */
function parseDataUri(uri) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(uri);
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

/** Base64-encode bytes without blowing the call stack on large arrays. */
function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000; // 32 KiB per fromCharCode call
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Resolve a single reference image to Gemini's inline form { mimeType, data }.
 * Gemini has no URL-reference mechanism — bytes must be inlined as base64. So:
 *   • data: URI  → parsed directly (the historical path).
 *   • http(s) URL → fetched server-side and base64-encoded. This is the path
 *     taken since reference images moved to direct-R2 upload: the client now
 *     sends an R2 URL, and the bytes only ever transit this process on the
 *     outbound hop to Google. Runware fetches URLs itself and never reaches
 *     here, so this cost is Gemini-only.
 * Throws ProviderError on a failed/oversized fetch rather than silently
 * dropping the reference (the bug this replaces).
 */
async function resolveRefToInline(ref) {
  if (typeof ref !== 'string' || !ref) return null;
  const parsed = parseDataUri(ref);
  if (parsed) return parsed;
  if (!/^https?:\/\//i.test(ref)) return null; // not a data URI, not a URL → skip
  // SSRF guard: only fetch from our own R2 public origin. referenceImages is a
  // client-supplied field, and this is the one place the server dereferences
  // it, so we never let it point the fetch at an arbitrary host. R2_PUBLIC_BASE
  // is where /api/upload-url hands back gen-src/ URLs, so the legit path always
  // matches; anything else is rejected.
  const base = (process.env.R2_PUBLIC_BASE || '').replace(/\/+$/, '');
  let allowed = false;
  if (base) {
    try { allowed = new URL(ref).origin === new URL(base).origin; } catch { allowed = false; }
  }
  if (!allowed) {
    throw new ProviderError('Reference image URL is not from an allowed origin.', { provider: 'google', code: 'bad_request', status: 400 });
  }
  let res;
  try {
    res = await fetch(ref);
  } catch (e) {
    throw new ProviderError(`Could not fetch reference image: ${e.message}`, { provider: 'google', code: 'bad_request', status: 400 });
  }
  if (!res.ok) {
    throw new ProviderError(`Reference image fetch failed (HTTP ${res.status})`, { provider: 'google', code: 'bad_request', status: 400 });
  }
  const mimeType = (res.headers.get('content-type') || 'image/png').split(';')[0].trim();
  if (!/^image\//i.test(mimeType)) {
    throw new ProviderError(`Reference URL is not an image (${mimeType})`, { provider: 'google', code: 'bad_request', status: 400 });
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { mimeType, data: bytesToBase64(bytes) };
}

export const googleAdapter = {
  id: 'google',

  /**
   * @param {import('./index.js').GenerateRequest} req
   * @returns {Promise<import('./index.js').GenerateResult>}
   */
  async generate(req) {
    const [, geminiId] = parseModelId(req.model); // strip "google:" prefix
    const spec = GEMINI_MODELS[geminiId];
    if (!spec) {
      throw new ProviderError(`Unknown Gemini model "${geminiId}"`, { provider: 'google', code: 'bad_request', status: 400 });
    }

    // ── Build the parts array: prompt text + any reference images (i2i). ──────
    const parts = [{ text: req.prompt }];
    if (req.negativePrompt) {
      // Gemini has no dedicated negative field; fold it into the prompt as a
      // soft instruction (this matches Google's own guidance).
      parts[0].text += `\n\nAvoid: ${req.negativePrompt}`;
    }
    if (Array.isArray(req.referenceImages) && req.referenceImages.length) {
      for (const ref of req.referenceImages.slice(0, 6)) {
        // Resolve each reference to inline base64. data: URIs parse directly;
        // R2/http(s) URLs (the direct-upload path) are fetched server-side and
        // encoded here. A failed fetch throws rather than silently dropping the
        // reference, so a Gemini i2i run can never quietly degrade to text-only.
        const inline = await resolveRefToInline(ref);
        if (inline) {
          parts.push({ inlineData: { mimeType: inline.mimeType, data: inline.data } });
        }
      }
    }

    const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
    const imageConfig = {};
    if (req.aspectRatio && /^\d+:\d+$/.test(req.aspectRatio)) {
      imageConfig.aspectRatio = req.aspectRatio;
    }
    if (spec.sizes && req.resolution && /^(1K|2K|4K)$/.test(req.resolution)) {
      imageConfig.imageSize = req.resolution;
    }
    if (Object.keys(imageConfig).length) generationConfig.imageConfig = imageConfig;

    const bodyObj = { contents: [{ parts }], generationConfig };

    const key = apiKey(); // resolve first so a missing key is a clean auth error
    const url = `${GEMINI_BASE}/${encodeURIComponent(geminiId)}:generateContent`;

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(bodyObj),
        signal: req.signal,
      });
    } catch (e) {
      if (e?.name === 'AbortError') {
        throw new ProviderError('Generation cancelled', { provider: 'google', code: 'timeout', status: 499 });
      }
      throw new ProviderError(`Network error reaching Google: ${e.message}`, { provider: 'google', code: 'upstream', status: 502 });
    }

    let body;
    try {
      body = await res.json();
    } catch {
      throw new ProviderError(`Google returned non-JSON (HTTP ${res.status})`, { provider: 'google', code: 'upstream', status: 502 });
    }

    if (!res.ok || body?.error) {
      const mapped = mapGoogleError(body?.error, res.status, body);
      // Log the real Google message server-side — otherwise a clean ProviderError
      // reaches the client but the cause never hits the logs, leaving 502s opaque.
      try {
        console.error('[google] generateContent error', JSON.stringify({
          model: geminiId, httpStatus: res.status, googleError: body?.error || body,
        }).slice(0, 1200));
      } catch { /* logging must never throw */ }
      throw mapped;
    }

    // ── Collect image parts from the first candidate. ────────────────────────
    const candidates = Array.isArray(body?.candidates) ? body.candidates : [];
    const first = candidates[0];
    const outParts = first?.content?.parts || [];
    const images = [];
    for (const p of outParts) {
      const inline = p?.inlineData || p?.inline_data;
      if (inline?.data) {
        const mime = inline.mimeType || inline.mime_type || 'image/png';
        // Return the raw base64 + mime, NOT a data: URI. The route decodes this
        // to bytes exactly once and uploads straight to R2 — avoiding the old
        // path that wrapped it in a data URI and let fetch() re-decode it,
        // keeping several MB-scale copies resident (the 256mb OOM cause).
        images.push({ b64: inline.data, mimeType: mime });
      }
    }

    // A safety block returns no image parts but a finishReason — surface it.
    if (!images.length) {
      const reason = first?.finishReason || first?.finish_reason;
      try {
        console.error('[google] no image in response', JSON.stringify({
          model: geminiId, finishReason: reason, candidateCount: candidates.length,
          partKinds: outParts.map((p) => Object.keys(p)[0]),
          promptFeedback: body?.promptFeedback || body?.prompt_feedback,
        }).slice(0, 1200));
      } catch { /* logging must never throw */ }
      if (reason && /safety|blocklist|prohibited|recitation/i.test(String(reason))) {
        throw new ProviderError(`Blocked by Google safety filters (${reason}).`, { provider: 'google', code: 'content_filtered', status: 422, raw: body });
      }
      throw new ProviderError('Google returned no image for this prompt.', { provider: 'google', code: 'upstream', status: 502, raw: body });
    }

    // usageMetadata is preserved in `raw` so the route can compute actual cost
    // via pricing.geminiUsageCostUsd() for margin logging.
    return {
      provider: 'google',
      model: req.model,
      images,
      // No per-call dollar figure from Gemini; cost is computed from usageMetadata.
      costUsd: undefined,
      raw: body,
    };
  },
};

function mapGoogleError(err, httpStatus, raw) {
  const status = err?.status || '';
  const message = err?.message || `Google error (HTTP ${httpStatus})`;
  const code = err?.code || httpStatus;
  if (/permission|unauthenticated|api[_ ]?key|forbidden/i.test(status + message) || code === 401 || code === 403) {
    return new ProviderError(message, { provider: 'google', code: 'auth', status: 401, raw });
  }
  if (/resource_exhausted|quota|rate/i.test(status + message) || code === 429) {
    return new ProviderError(message, { provider: 'google', code: 'rate_limit', status: 429, raw });
  }
  if (/safety|blocked|prohibited/i.test(status + message)) {
    return new ProviderError(message, { provider: 'google', code: 'content_filtered', status: 422, raw });
  }
  if (/invalid|failed_precondition|not_found|bad/i.test(status + message) || code === 400 || code === 404) {
    return new ProviderError(message, { provider: 'google', code: 'bad_request', status: 400, raw });
  }
  return new ProviderError(message, { provider: 'google', code: 'upstream', status: 502, raw });
}
