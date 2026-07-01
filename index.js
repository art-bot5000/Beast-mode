// providers/index.js
//
// Provider abstraction for image generation.
//
// The whole point: your backend route calls ONE function — generate(opts) —
// and never knows or cares which vendor served it. Adding Black Forest Labs
// (or Replicate, or OpenAI) later means writing one new adapter file and
// adding one line to the registry below. Nothing else in your app changes.
//
// ──────────────────────────────────────────────────────────────────────────
// THE CONTRACT
//
// Every adapter is an object: { id, generate(req) -> Promise<GenerateResult> }
//
// generate() receives a NORMALIZED request (GenerateRequest) and returns a
// NORMALIZED result (GenerateResult). The normalization is what makes the
// providers interchangeable — the caller speaks one language, each adapter
// translates to/from its vendor's dialect internally.
// ──────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} GenerateRequest
 * @property {string}  prompt            Positive prompt text.
 * @property {string} [negativePrompt]   Things to avoid (ignored by models that don't support it).
 * @property {string}  model             A canonical model id, e.g. "runware:civitai:36520@76907"
 *                                        or "bfl:flux.2-pro". The part before the first ":" picks
 *                                        the provider; the rest is the provider-specific model ref.
 * @property {number} [width=1024]
 * @property {number} [height=1024]
 * @property {number} [steps]            Sampling steps (provider clamps to its own valid range).
 * @property {number} [cfgScale]         Guidance scale.
 * @property {number} [count=1]          How many images.
 * @property {number} [seed]             Optional seed for reproducibility.
 * @property {string[]} [referenceImages] Image-to-image references (URL or data URI). Max 10.
 * @property {string} [resolution]       Preset ("1K"|"2K"|"4K") for models that support it.
 *                                        Mutually exclusive with width/height.
 * @property {boolean} [snapDims=true]   Snap width/height to /64 (community models).
 *                                        Set false for closed models with exact dim tables.
 * @property {string} [quality]          GPT Image quality (auto|low|medium|high).
 * @property {string} [renderingSpeed]   Ideogram speed (TURBO|DEFAULT|QUALITY).
 * @property {string} [seedImage]        Outpainting source (URL or data URI). The
 *                                        original image the model expands beyond.
 * @property {{top:number,right:number,bottom:number,left:number}} [outpaint]
 *                                        Per-side pixel extents for outpainting.
 *                                        width/height must be the FINAL combined dims.
 * @property {string} [maskImage]        Outpaint mask (Fill [dev] only) — white =
 *                                        generate, black = keep. URL or data URI.
 * @property {AbortSignal} [signal]      Optional cancellation.
 */

/**
 * @typedef {Object} GeneratedImage
 * @property {string} url                Hosted image URL (preferred — cheap to pass to Drive/Dropbox save).
 * @property {string} [b64]              Base64 data, only if a provider returns inline bytes.
 * @property {number} [seed]             Seed actually used.
 */

/**
 * @typedef {Object} GenerateResult
 * @property {string} provider           Which adapter served this.
 * @property {string} model              Echo of the canonical model id requested.
 * @property {GeneratedImage[]} images
 * @property {number} [costUsd]          Total cost if the provider reports it.
 * @property {Object} [raw]              The untouched vendor response, for debugging/logging.
 */

/**
 * A typed error so the route can map provider failures to clean HTTP responses
 * instead of leaking vendor-specific shapes to the client.
 */
export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {Object} [opts]
   * @param {string} [opts.provider]
   * @param {string} [opts.code]      Stable-ish code: "auth" | "rate_limit" | "bad_request" | "content_filtered" | "upstream" | "timeout"
   * @param {number} [opts.status]    Suggested HTTP status to return to your client.
   * @param {Object} [opts.raw]       Original vendor error payload.
   */
  constructor(message, { provider, code = 'upstream', status = 502, raw } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.code = code;
    this.status = status;
    this.raw = raw;
  }
}

// ── Registry ────────────────────────────────────────────────────────────────
// Adapters register themselves by their prefix. Add BFL later with one import
// + one line here; the router below picks it up automatically.

import { runwareAdapter } from './runware.js';
import { googleAdapter } from './google.js';

// Built lazily on first use. The adapter modules import ProviderError/parseModelId
// FROM this module, so referencing their exports at module-init time hits a
// temporal-dead-zone error under the circular import. Resolving inside a function
// (called only when a request arrives) guarantees every module is initialized.
/** @type {Record<string, {id: string, generate: (req: GenerateRequest) => Promise<GenerateResult>}>|null} */
let _registry = null;
function registry() {
  if (!_registry) {
    _registry = {
      [runwareAdapter.id]: runwareAdapter,
      [googleAdapter.id]: googleAdapter,   // direct Gemini (Nano Banana) models
      // [bflAdapter.id]: bflAdapter,   // <- drop-in later, see providers/bfl.js stub
    };
  }
  return _registry;
}

/**
 * Split a canonical model id into [providerPrefix, providerModelRef].
 * "runware:civitai:36520@76907" -> ["runware", "civitai:36520@76907"]
 * "bfl:flux.2-pro"              -> ["bfl", "flux.2-pro"]
 */
export function parseModelId(modelId) {
  const idx = modelId.indexOf(':');
  if (idx === -1) {
    throw new ProviderError(`Model id "${modelId}" is missing a provider prefix (expected "<provider>:<ref>")`, {
      code: 'bad_request',
      status: 400,
    });
  }
  return [modelId.slice(0, idx), modelId.slice(idx + 1)];
}

/**
 * The single entry point your fly.io route calls.
 * @param {GenerateRequest} req
 * @returns {Promise<GenerateResult>}
 */
export async function generate(req) {
  if (!req || typeof req.prompt !== 'string' || !req.prompt.trim()) {
    throw new ProviderError('A non-empty "prompt" is required', { code: 'bad_request', status: 400 });
  }
  if (typeof req.model !== 'string' || !req.model) {
    throw new ProviderError('A "model" is required', { code: 'bad_request', status: 400 });
  }

  const [prefix] = parseModelId(req.model);
  const REG = registry();
  const adapter = REG[prefix];
  if (!adapter) {
    throw new ProviderError(
      `No provider registered for prefix "${prefix}". Registered: ${Object.keys(REG).join(', ') || '(none)'}`,
      { code: 'bad_request', status: 400 }
    );
  }

  // Validate reference images (image-to-image) before they hit the adapter.
  if (req.referenceImages !== undefined) {
    if (!Array.isArray(req.referenceImages) || req.referenceImages.some((r) => typeof r !== 'string' || !r)) {
      throw new ProviderError('"referenceImages" must be an array of non-empty strings', { code: 'bad_request', status: 400 });
    }
    if (req.referenceImages.length > 10) {
      throw new ProviderError('A maximum of 10 reference images is supported', { code: 'bad_request', status: 400 });
    }
    // Each ref must be an https URL or a data URI (caps payload at ~15MB each).
    for (const r of req.referenceImages) {
      const isUrl = /^https?:\/\//i.test(r);
      // Accept ANY image/<subtype> data URI (png/jpeg/webp/gif/avif/heic/…). The
      // /data store re-encodes library sources via FileReader, so the subtype is
      // whatever the stored content-type was — pinning it to four formats 400'd
      // valid i2i refs ("Each reference image must be an http(s) URL or…").
      const isDataUri = /^data:image\/[a-z0-9.+-]+;base64,/i.test(r);
      if (!isUrl && !isDataUri) {
        throw new ProviderError('Each reference image must be an http(s) URL or a base64 image data URI', { code: 'bad_request', status: 400 });
      }
      if (isDataUri && r.length > 15_000_000) {
        throw new ProviderError('Reference image too large (max ~10MB per image)', { code: 'bad_request', status: 400 });
      }
    }
  }

  // Validate outpainting inputs (Tools → Outpaint) before the adapter. seedImage
  // and maskImage accept the same forms as reference images; outpaint must be an
  // object of four non-negative pixel extents.
  const isImgRef = (s) =>
    /^https?:\/\//i.test(s) || /^data:image\/[a-z0-9.+-]+;base64,/i.test(s);
  if (req.seedImage !== undefined) {
    if (typeof req.seedImage !== 'string' || !isImgRef(req.seedImage)) {
      throw new ProviderError('"seedImage" must be an http(s) URL or a base64 image data URI', { code: 'bad_request', status: 400 });
    }
    if (/^data:/i.test(req.seedImage) && req.seedImage.length > 15_000_000) {
      throw new ProviderError('Seed image too large (max ~10MB)', { code: 'bad_request', status: 400 });
    }
  }
  if (req.maskImage !== undefined) {
    if (typeof req.maskImage !== 'string' || !isImgRef(req.maskImage)) {
      throw new ProviderError('"maskImage" must be an http(s) URL or a base64 image data URI', { code: 'bad_request', status: 400 });
    }
    if (/^data:/i.test(req.maskImage) && req.maskImage.length > 15_000_000) {
      throw new ProviderError('Mask image too large (max ~10MB)', { code: 'bad_request', status: 400 });
    }
  }
  if (req.outpaint !== undefined) {
    const o = req.outpaint;
    const ok = o && typeof o === 'object' &&
      ['top', 'right', 'bottom', 'left'].every((k) => Number.isFinite(Number(o[k])) && Number(o[k]) >= 0);
    if (!ok) {
      throw new ProviderError('"outpaint" must be an object with non-negative top/right/bottom/left pixel values', { code: 'bad_request', status: 400 });
    }
  }

  // Apply shared defaults once, so individual adapters stay lean. Width/height
  // defaults only apply to snapped (community) models — preset/closed models
  // either send exact dims, a resolution preset, or nothing (i2i AR-match).
  const normalized = { count: 1, ...req };
  if (normalized.snapDims !== false && normalized.resolution === undefined) {
    if (!Number.isFinite(normalized.width)) normalized.width = 1024;
    if (!Number.isFinite(normalized.height)) normalized.height = 1024;
  }

  return adapter.generate(normalized);
}

/** Convenience for a /models endpoint or the frontend dropdown. */
export function registeredProviders() {
  return Object.keys(registry());
}

/**
 * Provider-agnostic live model search. Defaults to Runware (the only provider
 * with a searchable catalogue today); pass { provider } to target another once
 * it implements searchModels(). Providers without the capability are skipped.
 * @param {Object} opts  { search, architecture, category, limit, offset, provider, signal }
 */
export async function searchModels(opts = {}) {
  const prefix = opts.provider || runwareAdapter.id;
  const adapter = registry()[prefix];
  if (!adapter || typeof adapter.searchModels !== 'function') {
    throw new ProviderError(`Provider "${prefix}" does not support model search`, {
      code: 'bad_request',
      status: 400,
    });
  }
  return adapter.searchModels(opts);
}

/**
 * @typedef {Object} UpscaleRequest
 * @property {string}  model          Upscaler id: "prunaai:p-image@upscale" | "runware:500@1" | "runware:502@1" | google Nano Banana ids.
 * @property {string}  inputImage     Source image (https URL, data URI, base64, or Runware image UUID).
 * @property {string} [outputFormat]  JPG | PNG | WEBP (default JPG).
 * @property {number} [outputQuality] 20–99.
 * @property {number} [targetMegapixels] P-Image only: 1–8.
 * @property {boolean}[enhanceDetails] P-Image only.
 * @property {boolean}[realism]        P-Image only.
 * @property {number} [upscaleFactor]  Clarity/SD Latent: 2–4 (SD Latent fixed at 2).
 * @property {string} [positivePrompt] Diffusion upscalers.
 * @property {string} [negativePrompt] Diffusion upscalers.
 * @property {number} [steps]          Diffusion upscalers.
 * @property {number} [CFGScale]       Diffusion upscalers.
 * @property {number} [strength]       Diffusion upscalers (0–1).
 * @property {number} [seed]           Diffusion upscalers.
 * @property {string} [resolution]     Gemini upscalers: '0.5K'|'1K'|'2K'|'4K'.
 * @property {string} [aspectRatio]    Gemini upscalers: '1:1'|'16:9'|etc.
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {Object} UpscaleResult
 * @property {string} provider
 * @property {string} model
 * @property {{url:string, b64?:string}} image
 * @property {number} [costUsd]
 * @property {Object} [raw]
 */

/**
 * Curated upscaler catalogue — the models exposed in the Upscaler tab, with the
 * config surface each one supports so the frontend can render the right controls
 * and the route can validate. Kept here (not in catalog.js) because upscalers
 * are a distinct task family from the generation catalog.
 */
export const UPSCALERS = [
  {
    id: 'prunaai:p-image@upscale',
    label: 'P-Image Upscale',
    family: 'Pruna',
    kind: 'megapixels',                 // controls: target MP slider + toggles
    targetMegapixels: { min: 1, max: 8, default: 4 },
    toggles: ['enhanceDetails', 'realism'],
    note: 'Targets a megapixel count (1–8 MP) with optional detail & realism enhancement. Best on AI-generated images.',
  },
  {
    id: 'runware:500@1',
    label: 'Clarity',
    family: 'Runware',
    kind: 'diffusion',                  // controls: factor + prompt + steps/CFG/seed
    factor: { values: [2, 4], default: 2 },
    prompt: true,
    sampler: { steps: 24, cfg: 5.5, strength: 0.34 },
    note: 'Diffusion upscaler boosting perceived detail at 2×–4×. A guiding prompt sharpens the result.',
  },
  {
    id: 'runware:502@1',
    label: 'Stable Diffusion Latent Upscaler',
    family: 'Stability',
    kind: 'diffusion',
    factor: { values: [2], default: 2 },
    prompt: true,
    // NB: SD Latent does NOT accept settings.strength (Runware rejects it).
    // Only Clarity among our upscalers supports strength.
    sampler: { steps: 20, cfg: 6.5 },
    note: 'Fast 2× latent-space upscale before VAE decode. Improves detail without changing composition.',
  },
  // ── Google Nano Banana (Gemini) — AI-guided upscale via generate+reference ──
  // These use the direct Gemini API (google.js). The source image is sent as a
  // reference image; the model regenerates at the target resolution guided by
  // the prompt. Requires GEMINI_API_KEY. Resolution options match Gemini's
  // supported imageSize values. Results are "AI-reimagined" rather than pixel-
  // perfect upscales — excellent for artistic enhancement, detail recovery.
  {
    id: 'google:gemini-3-pro-image:upscale',
    label: 'Nano Banana Pro',
    family: 'Google',
    kind: 'gemini-upscale',             // routes to googleAdapter.generate() with referenceImages
    geminiModel: 'google:gemini-3-pro-image', // the underlying generate model id
    resolution: { values: ['1K', '2K', '4K'], default: '2K' },
    prompt: true,
    note: 'Gemini 3 Pro: AI-guided enhancement at 1K/2K/4K. Adds detail and improves quality using your prompt. Direct Google API.',
  },
  {
    id: 'google:gemini-3.1-flash-image:upscale',
    label: 'Nano Banana 2',
    family: 'Google',
    kind: 'gemini-upscale',
    geminiModel: 'google:gemini-3.1-flash-image',
    resolution: { values: ['0.5K', '1K', '2K', '4K'], default: '2K' },
    prompt: true,
    note: 'Gemini 3.1 Flash: fast AI-guided enhancement at up to 4K. Great text rendering. Direct Google API.',
  },
  {
    id: 'google:gemini-3.1-flash-lite-image:upscale',
    label: 'Nano Banana 2 Lite',
    family: 'Google',
    kind: 'gemini-upscale',
    geminiModel: 'google:gemini-3.1-flash-lite-image',
    resolution: { values: ['1K'], default: '1K' }, // Lite priced/positioned as 1K draft tier
    prompt: true,
    note: 'Gemini 3.1 Flash Lite: fastest, cheapest AI-guided enhancement at ~1K. Direct Google API.',
  },
  {
    id: 'google:gemini-2.5-flash-image:upscale',
    label: 'Nano Banana (2.5)',
    family: 'Google',
    kind: 'gemini-upscale',
    geminiModel: 'google:gemini-2.5-flash-image',
    resolution: { values: ['1K'], default: '1K' }, // 2.5 Flash ignores imageSize, outputs ~1K
    prompt: true,
    note: 'Gemini 2.5 Flash: cost-effective AI enhancement. Fixed ~1K output size. Direct Google API.',
  },
];

/** Look up a curated upscaler entry by id. */
export function findUpscaler(modelId) {
  return UPSCALERS.find((u) => u.id === modelId) || null;
}

/**
 * Provider-agnostic image upscale. Runware-served upscalers route to the
 * runware adapter; Gemini-kind upscalers route to googleAdapter.generate()
 * with the source image as a reference. Validates the source image + the
 * model-specific config before calling the adapter.
 *
 * @param {UpscaleRequest} req
 * @returns {Promise<UpscaleResult>}
 */
export async function upscale(req) {
  if (!req || typeof req.model !== 'string' || !req.model) {
    throw new ProviderError('An upscaler "model" is required', { code: 'bad_request', status: 400 });
  }
  const entry = findUpscaler(req.model);
  if (!entry) {
    throw new ProviderError(`Unknown upscaler "${req.model}"`, { code: 'bad_request', status: 400 });
  }
  const img = req.inputImage;
  if (typeof img !== 'string' || !img) {
    throw new ProviderError('An "inputImage" is required', { code: 'bad_request', status: 400 });
  }
  const isUrl = /^https?:\/\//i.test(img);
  // Any image/<subtype> data URI — see referenceImages note above.
  const isDataUri = /^data:image\/[a-z0-9.+-]+;base64,/i.test(img);
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(img);
  if (!isUrl && !isDataUri && !isUuid) {
    throw new ProviderError('inputImage must be an http(s) URL, a base64 image data URI, or a Runware image UUID', { code: 'bad_request', status: 400 });
  }
  if (isDataUri && img.length > 15_000_000) {
    throw new ProviderError('Source image too large (max ~10MB)', { code: 'bad_request', status: 400 });
  }

  // ── Gemini-guided upscale (AI reimagining with reference image) ─────────────
  if (entry.kind === 'gemini-upscale') {
    if (!entry.geminiModel) {
      throw new ProviderError('geminiModel not set on upscaler entry', { code: 'bad_request', status: 400 });
    }
    // Gemini requires inline data URIs for reference images — URLs need fetching
    // first. For Runware UUIDs (not applicable here) we'd need a different path;
    // in practice the frontend always sends data URIs for the upscaler.
    if (!isDataUri && !isUrl) {
      throw new ProviderError('Gemini upscale requires a data URI or https URL as inputImage', { code: 'bad_request', status: 400 });
    }
    const prompt = req.positivePrompt || 'Upscale this image to the selected resolution and improve details, enhance sharpness and clarity while preserving the original style and composition.';
    const genReq = {
      model: entry.geminiModel,
      prompt,
      referenceImages: [img],
      resolution: req.resolution || (entry.resolution && entry.resolution.default) || '2K',
      aspectRatio: req.aspectRatio || '1:1',
      signal: req.signal,
    };
    const adapter = registry()[googleAdapter.id];
    if (!adapter || typeof adapter.generate !== 'function') {
      throw new ProviderError('Google Gemini adapter is not available', { code: 'auth', status: 503 });
    }
    const result = await adapter.generate(genReq);
    // Map GenerateResult → UpscaleResult shape
    const firstImage = Array.isArray(result.images) ? result.images[0] : null;
    if (!firstImage) {
      throw new ProviderError('Gemini returned no image', { code: 'upstream', status: 502 });
    }
    return {
      provider: result.provider,
      model: entry.geminiModel,
      image: { url: firstImage.url, b64: firstImage.b64 },
      costUsd: result.costUsd || null,
      raw: result.raw || null,
    };
  }

  const adapter = registry()[runwareAdapter.id];
  if (!adapter || typeof adapter.upscale !== 'function') {
    throw new ProviderError('Upscaling is not available', { code: 'bad_request', status: 400 });
  }
  return adapter.upscale(req);
}

/**
 * Curated background-removal catalogue (Tools → Background removal). BiRefNet
 * variants run through Runware's removeBackground task; the Gemini option runs a
 * prompt-guided edit through googleAdapter.generate(). Costs verified June 2026.
 */
export const BG_REMOVERS = [
  {
    id: 'runware:runware:112@1',
    label: 'General',
    family: 'BiRefNet',
    kind: 'birefnet',
    default: true,
    note: 'BiRefNet v1 Base — best all-round subject cut-out.',
  },
  {
    id: 'runware:runware:112@2',
    label: 'Complex / camouflaged',
    family: 'BiRefNet',
    kind: 'birefnet',
    note: 'BiRefNet COD — subjects that blend into the background.',
  },
  {
    id: 'runware:runware:112@10',
    label: 'Portrait',
    family: 'BiRefNet',
    kind: 'birefnet',
    note: 'BiRefNet Portrait — people, clean hair edges.',
  },
  {
    id: 'google:gemini-2.5-flash-image',
    label: 'Gemini (Nano Banana 2.5)',
    family: 'Gemini',
    kind: 'gemini-bg',
    geminiModel: 'google:gemini-2.5-flash-image',
    note: 'Prompt-guided removal — flexible but far pricier than BiRefNet.',
  },
];

/** Look up a background remover by canonical id. */
export function findBgRemover(modelId) {
  return BG_REMOVERS.find((m) => m.id === modelId) || null;
}

/**
 * Remove the background from an image. BiRefNet models route to the Runware
 * removeBackground task; the Gemini model routes to googleAdapter.generate()
 * with a removal prompt. Mirrors upscale()'s validation + routing.
 * @param {{model:string, inputImage:string, outputFormat?:string, prompt?:string, signal?:AbortSignal}} req
 * @returns {Promise<{provider:string, model:string, image:{url:string,b64?:string}, costUsd?:number, raw?:Object}>}
 */
export async function removeBackground(req) {
  if (!req || typeof req.model !== 'string' || !req.model) {
    throw new ProviderError('A background-removal "model" is required', { code: 'bad_request', status: 400 });
  }
  const entry = findBgRemover(req.model);
  if (!entry) {
    throw new ProviderError(`Unknown background remover "${req.model}"`, { code: 'bad_request', status: 400 });
  }
  const img = req.inputImage;
  if (typeof img !== 'string' || !img) {
    throw new ProviderError('An "inputImage" is required', { code: 'bad_request', status: 400 });
  }
  const isUrl = /^https?:\/\//i.test(img);
  const isDataUri = /^data:image\/[a-z0-9.+-]+;base64,/i.test(img);
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(img);
  if (!isUrl && !isDataUri && !isUuid) {
    throw new ProviderError('inputImage must be an http(s) URL, a base64 image data URI, or a Runware image UUID', { code: 'bad_request', status: 400 });
  }
  if (isDataUri && img.length > 15_000_000) {
    throw new ProviderError('Source image too large (max ~10MB)', { code: 'bad_request', status: 400 });
  }

  // ── Gemini prompt-guided removal (AI edit with reference image) ─────────────
  if (entry.kind === 'gemini-bg') {
    if (!isDataUri && !isUrl) {
      throw new ProviderError('Gemini background removal requires a data URI or https URL as inputImage', { code: 'bad_request', status: 400 });
    }
    const prompt = req.prompt || 'keep the main subject, remove the background';
    const genReq = {
      model: entry.geminiModel,
      prompt,
      referenceImages: [img],
      signal: req.signal,
    };
    const adapter = registry()[googleAdapter.id];
    if (!adapter || typeof adapter.generate !== 'function') {
      throw new ProviderError('Google Gemini adapter is not available', { code: 'auth', status: 503 });
    }
    const result = await adapter.generate(genReq);
    const firstImage = Array.isArray(result.images) ? result.images[0] : null;
    if (!firstImage) {
      throw new ProviderError('Gemini returned no image', { code: 'upstream', status: 502 });
    }
    return {
      provider: result.provider,
      model: entry.geminiModel,
      image: { url: firstImage.url, b64: firstImage.b64 },
      costUsd: result.costUsd || null,
      raw: result.raw || null,
    };
  }

  // ── BiRefNet via Runware removeBackground task ─────────────────────────────
  const adapter = registry()[runwareAdapter.id];
  if (!adapter || typeof adapter.removeBackground !== 'function') {
    throw new ProviderError('Background removal is not available', { code: 'bad_request', status: 400 });
  }
  // Strip the leading "runware:" prefix — the adapter expects the native ref.
  const [, modelRef] = parseModelId(req.model);
  return adapter.removeBackground({
    model: modelRef,
    inputImage: img,
    outputFormat: req.outputFormat,
    outputQuality: req.outputQuality,
    signal: req.signal,
  });
}
