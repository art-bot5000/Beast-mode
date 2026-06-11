// providers/google.js
//
// Direct Gemini API adapter ("Nano Banana" family) — bypasses Runware so the
// Google AI Studio FREE TIER can be used for testing.
//
// API shape (verified against ai.google.dev/gemini-api/docs/image-generation):
//   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//   Header: x-goog-api-key: <GEMINI_API_KEY>
//   Body: { contents:[{ parts:[{text}, {inlineData:{mimeType,data}}...] }],
//           generationConfig:{ responseModalities:["TEXT","IMAGE"],
//                              imageConfig:{ aspectRatio:"16:9", imageSize:"1K"|"2K"|"4K" } } }
//   Response: candidates[0].content.parts[] -> inlineData {mimeType, data(base64)}
//
// Canonical ids routed here: "google:<gemini-model-name>", e.g.
//   "google:gemini-3-pro-image"       (Nano Banana Pro)
//   "google:gemini-3.1-flash-image"   (Nano Banana 2)
//   "google:gemini-2.5-flash-image"   (Nano Banana — most generous free tier)
//
// Images come back as BASE64, not URLs. We return them as data: URIs — Deno's
// fetch() accepts data: URIs, so main.ts's existing rehostToR2() pipeline
// uploads them to R2 untouched. Without R2 the data URI flows to the client
// (works, just heavier payloads).

import { ProviderError, parseModelId } from './index.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Aspect ratios the imageConfig accepts (per docs).
const GEMINI_ARS = ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9'];

function apiKey() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) {
    throw new ProviderError('GEMINI_API_KEY is not set — Gemini direct models are unavailable.', {
      provider: 'google', code: 'auth', status: 503,
    });
  }
  return k;
}

/** Closest supported aspect-ratio string for a width/height pair. */
function nearestAR(w, h) {
  const target = w / h;
  let best = '1:1', bestDiff = Infinity;
  for (const ar of GEMINI_ARS) {
    const [a, b] = ar.split(':').map(Number);
    const d = Math.abs(a / b - target);
    if (d < bestDiff) { bestDiff = d; best = ar; }
  }
  return best;
}

/** Size tier from a width/height pair (fallback when no resolution given). */
function sizeTier(w, h) {
  const m = Math.max(w || 0, h || 0);
  if (m >= 3000) return '4K';
  if (m >= 1700) return '2K';
  return '1K';
}

/** Convert a reference (data URI or http URL) into Gemini inlineData. */
async function toInlineData(ref, signal) {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(ref);
  if (m) return { inlineData: { mimeType: m[1], data: m[2] } };
  // http(s) URL (e.g. "USE AS REF" on a previous R2/Runware result): fetch the
  // bytes server-side and inline them — Gemini inlineData requires base64.
  const res = await fetch(ref, { signal });
  if (!res.ok) {
    throw new ProviderError(`Failed to fetch reference image (HTTP ${res.status})`, {
      provider: 'google', code: 'bad_request', status: 400,
    });
  }
  const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > 12_000_000) {
    throw new ProviderError('Reference image too large for Gemini inline upload (max ~12MB)', {
      provider: 'google', code: 'bad_request', status: 400,
    });
  }
  // Chunked base64 to avoid call-stack limits on large images.
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  return { inlineData: { mimeType: mime, data: btoa(bin) } };
}

/** Single generateContent call -> one image (data URI). */
async function generateOne(modelRef, parts, imageConfig, key, signal) {
  let res;
  try {
    res = await fetch(`${GEMINI_BASE}/${encodeURIComponent(modelRef)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig,
        },
      }),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new ProviderError('Generation cancelled', { provider: 'google', code: 'timeout', status: 499 });
    }
    throw new ProviderError(`Network error reaching Gemini: ${e.message}`, {
      provider: 'google', code: 'upstream', status: 502,
    });
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new ProviderError(`Gemini returned non-JSON (HTTP ${res.status})`, {
      provider: 'google', code: 'upstream', status: 502,
    });
  }

  if (!res.ok || body?.error) {
    throw mapGeminiError(body?.error, res.status, body);
  }

  const cand = body?.candidates?.[0];
  // Safety blocks surface as promptFeedback.blockReason or a finishReason.
  const blocked = body?.promptFeedback?.blockReason ||
    (cand && /SAFETY|PROHIBITED|IMAGE_SAFETY/i.test(cand.finishReason || '') ? cand.finishReason : null);
  if (blocked) {
    throw new ProviderError(`Gemini blocked the request (${blocked})`, {
      provider: 'google', code: 'content_filtered', status: 422, raw: body,
    });
  }

  const img = (cand?.content?.parts || []).find((p) => p.inlineData?.data);
  if (!img) {
    throw new ProviderError('Gemini response contained no image', {
      provider: 'google', code: 'upstream', status: 502, raw: body,
    });
  }
  const mime = img.inlineData.mimeType || 'image/png';
  return { url: `data:${mime};base64,${img.inlineData.data}` };
}

export const googleAdapter = {
  id: 'google',

  /**
   * @param {import('./index.js').GenerateRequest} req
   * @returns {Promise<import('./index.js').GenerateResult>}
   */
  async generate(req) {
    const [, modelRef] = parseModelId(req.model); // strip "google:" -> gemini model name
    const key = apiKey();

    // Prompt + optional reference images (image-to-image / editing).
    const parts = [{ text: req.prompt }];
    if (Array.isArray(req.referenceImages) && req.referenceImages.length) {
      const inlines = await Promise.all(
        req.referenceImages.slice(0, 10).map((r) => toInlineData(r, req.signal)),
      );
      parts.push(...inlines);
    }

    // imageConfig: prefer explicit aspectRatio/resolution from the client;
    // fall back to deriving both from a width/height pair. With reference
    // images and no aspectRatio, Gemini matches the input image's AR.
    const imageConfig = {};
    if (req.aspectRatio && GEMINI_ARS.includes(req.aspectRatio)) {
      imageConfig.aspectRatio = req.aspectRatio;
    } else if (Number.isFinite(req.width) && Number.isFinite(req.height)) {
      imageConfig.aspectRatio = nearestAR(req.width, req.height);
    }
    // imageSize (1K/2K/4K) only when asked for: gemini-3* models accept it,
    // gemini-2.5-flash-image predates the param (the client omits resolution
    // for that model, so nothing is sent and Gemini uses its default).
    if (/^(1K|2K|4K)$/.test(req.resolution || '')) {
      imageConfig.imageSize = req.resolution;
    } else if (Number.isFinite(req.width) && Math.max(req.width, req.height) >= 1700) {
      imageConfig.imageSize = sizeTier(req.width, req.height);
    }

    // The image API has no batch parameter — run count requests in parallel.
    const count = Math.max(1, Math.min(4, req.count ?? 1));
    const images = await Promise.all(
      Array.from({ length: count }, () => generateOne(modelRef, parts, imageConfig, key, req.signal)),
    );

    return {
      provider: 'google',
      model: req.model,
      images,
      // Free-tier calls have no metered cost; paid-tier billing happens on the
      // Google side and isn't reported per-response, so costUsd stays undefined.
    };
  },
};

function mapGeminiError(err, httpStatus, raw) {
  const status = err?.status || '';
  const message = err?.message || `Gemini error (HTTP ${httpStatus})`;
  if (httpStatus === 401 || httpStatus === 403 || /API key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(status + message)) {
    return new ProviderError(message, { provider: 'google', code: 'auth', status: 401, raw });
  }
  if (httpStatus === 429 || /RESOURCE_EXHAUSTED|quota/i.test(status + message)) {
    return new ProviderError('Gemini quota/rate limit reached — free tier limits are per-day and per-minute. ' + message, {
      provider: 'google', code: 'rate_limit', status: 429, raw,
    });
  }
  if (/SAFETY|blocked/i.test(status + message)) {
    return new ProviderError(message, { provider: 'google', code: 'content_filtered', status: 422, raw });
  }
  if (httpStatus === 400 || /INVALID_ARGUMENT|not found|NOT_FOUND/i.test(status + message)) {
    return new ProviderError(message, { provider: 'google', code: 'bad_request', status: 400, raw });
  }
  return new ProviderError(message, { provider: 'google', code: 'upstream', status: 502, raw });
}
