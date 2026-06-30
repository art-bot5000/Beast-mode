// providers/runware.js
//
// Runware adapter. Translates the normalized GenerateRequest into Runware's
// task-array REST format and maps the response back to GenerateResult.
//
// API shape (verified against runware.ai/docs):
//   POST https://api.runware.ai/v1
//   Authorization: Bearer <RUNWARE_API_KEY>
//   Body: an ARRAY of task objects. Each imageInference task carries its own
//         client-generated taskUUID (v4). We use the synchronous REST form,
//         which returns results inline in { data: [...] } — simplest to wire
//         into a request/response route. (Webhooks/WebSocket exist too, but we
//         don't need them for v1.)
//
// Canonical model ids routed here keep Runware's native ref after the prefix:
//   "runware:runware:101@1"          -> ref "runware:101@1"   (Runware-hosted model)
//   "runware:civitai:36520@76907"    -> ref "civitai:36520@76907" (CivitAI model)
//   "runware:bfl:5@1"                -> ref "bfl:5@1"          (BFL via Runware resale)
//
// i.e. everything after the FIRST colon is handed to Runware verbatim. That's
// what unlocks the 400k-model CivitAI catalogue through one integration.

import { randomUUID } from 'node:crypto';
import { ProviderError, parseModelId } from './index.js';

const RUNWARE_URL = 'https://api.runware.ai/v1';

function apiKey() {
  const k = process.env.RUNWARE_API_KEY;
  if (!k) {
    throw new ProviderError('RUNWARE_API_KEY is not set', { provider: 'runware', code: 'auth', status: 500 });
  }
  return k;
}

/** Runware requires width/height to be multiples of 64 within its bounds. */
function snap64(n, fallback) {
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.max(128, Math.min(2048, Math.round(n)));
  return Math.round(clamped / 64) * 64;
}

export const runwareAdapter = {
  id: 'runware',

  /**
   * @param {import('./index.js').GenerateRequest} req
   * @returns {Promise<import('./index.js').GenerateResult>}
   */
  async generate(req) {
    const [, modelRef] = parseModelId(req.model); // strip the "runware:" prefix

    const taskUUID = randomUUID();
    const task = {
      taskType: 'imageInference',
      taskUUID,
      model: modelRef,
      positivePrompt: req.prompt,
      numberResults: Math.max(1, Math.min(20, req.count ?? 1)),
      outputType: 'URL',
      outputFormat: 'JPG',
      includeCost: true,
    };

    // ── Dimensions ────────────────────────────────────────────────────────────
    // Three mutually-aware modes (per Runware model docs):
    //   1. resolution preset ("1K"|"2K"|"4K") — Google models; CANNOT combine
    //      with width/height. With reference images it auto-matches input AR.
    //   2. exact dims (snapDims === false) — closed models publish fixed dim
    //      tables (e.g. Nano Banana 1376x768); snapping to /64 would 400.
    //   3. snapped dims (default) — community SD/FLUX.1 checkpoints need /64.
    if (req.resolution && !Number.isFinite(req.width)) {
      task.resolution = String(req.resolution);
    } else if (req.snapDims === false) {
      if (Number.isFinite(req.width) && Number.isFinite(req.height)) {
        task.width = Math.round(req.width);
        task.height = Math.round(req.height);
      }
      // else: omit dims entirely (valid for i2i on preset models — the model
      // matches the reference image's aspect ratio).
    } else {
      task.width = snap64(req.width, 1024);
      task.height = snap64(req.height, 1024);
    }

    // ── Image-to-image: reference images (UUID, URL, data URI, or base64). ───
    if (Array.isArray(req.referenceImages) && req.referenceImages.length) {
      task.inputs = { referenceImages: req.referenceImages.slice(0, 10) };
    }

    // ── Outpainting (Tools → Outpaint). Unified Runware shape across the
    // outpaint-capable models (ideogram:4@4 reframe, bfl:1@3 Expand [pro],
    // runware:102@1 Fill [dev]). The original travels as `seedImage`; the four
    // per-side pixel extents go on `outpaint`; width/height MUST already be the
    // FINAL combined dims (original + extensions) — the route computes those.
    // Fill [dev] additionally needs a mask (white = generate, black = keep); the
    // frontend builds it client-side and sends it as `maskImage` so the three
    // models behave identically here.
    if (typeof req.seedImage === 'string' && req.seedImage) {
      task.seedImage = req.seedImage;
    }
    if (req.outpaint && typeof req.outpaint === 'object') {
      const o = req.outpaint;
      const px = (v) => Math.max(0, Math.round(Number(v) || 0));
      task.outpaint = { top: px(o.top), right: px(o.right), bottom: px(o.bottom), left: px(o.left) };
    }
    if (typeof req.maskImage === 'string' && req.maskImage) {
      task.maskImage = req.maskImage;
    }

    if (req.negativePrompt) task.negativePrompt = req.negativePrompt;
    if (Number.isFinite(req.steps)) task.steps = req.steps;
    if (Number.isFinite(req.cfgScale)) task.CFGScale = req.cfgScale;
    if (Number.isFinite(req.seed)) task.seed = Math.max(0, Math.round(req.seed));

    // ── Model-specific tuning, validated to a small whitelist. ───────────────
    // GPT Image 2: providerSettings.openai.quality (auto|low|medium|high).
    if (req.quality && /^(auto|low|medium|high)$/.test(req.quality)) {
      task.providerSettings = { ...(task.providerSettings || {}), openai: { quality: req.quality } };
    }
    // Ideogram 4.0: settings.renderingSpeed (TURBO|DEFAULT|QUALITY).
    if (req.renderingSpeed && /^(TURBO|DEFAULT|QUALITY)$/.test(req.renderingSpeed)) {
      task.settings = { ...(task.settings || {}), renderingSpeed: req.renderingSpeed };
    }

    const key = apiKey(); // resolve before the try so a missing key is a clean auth error, not "upstream"

    let res;
    try {
      res = await fetch(RUNWARE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify([task]), // <- the body is an ARRAY of tasks
        signal: req.signal,
      });
    } catch (e) {
      if (e?.name === 'AbortError') {
        throw new ProviderError('Generation cancelled', { provider: 'runware', code: 'timeout', status: 499 });
      }
      throw new ProviderError(`Network error reaching Runware: ${e.message}`, {
        provider: 'runware',
        code: 'upstream',
        status: 502,
      });
    }

    let body;
    try {
      body = await res.json();
    } catch {
      throw new ProviderError(`Runware returned non-JSON (HTTP ${res.status})`, {
        provider: 'runware',
        code: 'upstream',
        status: 502,
      });
    }

    // Runware signals failure by returning { errors: [...] } (or { error: ... })
    // and omitting data. Map the first error to a clean ProviderError.
    const errors = body?.errors || (body?.error ? [body.error] : null);
    if (errors && errors.length) {
      const first = errors[0];
      throw mapRunwareError(first, res.status, body);
    }

    const items = Array.isArray(body?.data) ? body.data : [];
    const ours = items.filter((d) => d.taskUUID === taskUUID && d.taskType === 'imageInference');
    if (!ours.length) {
      throw new ProviderError('Runware response contained no images for this task', {
        provider: 'runware',
        code: 'upstream',
        status: 502,
        raw: body,
      });
    }

    const images = ours.map((d) => ({
      url: d.imageURL,
      b64: d.imageBase64Data || d.base64Data || undefined,
      seed: d.seed,
    }));

    const costUsd = ours.reduce((sum, d) => sum + (typeof d.cost === 'number' ? d.cost : 0), 0) || undefined;

    return {
      provider: 'runware',
      model: req.model,
      images,
      costUsd,
      raw: body,
    };
  },

  /**
   * Image upscaling. All three supported models use Runware's `upscale`
   * taskType with the input under inputs.image, but differ in their tuning:
   *   - P-Image  (prunaai:p-image@upscale): targetMegapixels (1–8) +
   *     settings.{enhanceDetails, realism}. No upscaleFactor.
   *   - Clarity  (runware:500@1) & SD Latent (runware:502@1): diffusion
   *     upscalers — upscaleFactor + settings.{positivePrompt, negativePrompt,
   *     steps, CFGScale, seed, strength}.
   * The response taskType is `imageUpscale`; we match on taskUUID, not type.
   *
   * @param {import('./index.js').UpscaleRequest} req
   * @returns {Promise<import('./index.js').UpscaleResult>}
   */
  async upscale(req) {
    const [, modelRef] = parseModelId(req.model); // strip "runware:" / "prunaai:" prefix? No —
    // NB: upscaler ids are full AIRs ("prunaai:p-image@upscale", "runware:500@1").
    // parseModelId strips the FIRST segment, which would corrupt these. Use the
    // id verbatim as the Runware `model` value instead.
    void modelRef;
    const model = req.model;

    const taskUUID = randomUUID();
    const task = {
      taskType: 'upscale',
      taskUUID,
      model,
      outputType: 'URL',
      outputFormat: req.outputFormat && /^(JPG|PNG|WEBP)$/.test(req.outputFormat) ? req.outputFormat : 'JPG',
      includeCost: true,
      inputs: { image: req.inputImage },
    };
    if (Number.isFinite(req.outputQuality)) {
      task.outputQuality = Math.max(20, Math.min(99, Math.round(req.outputQuality)));
    }

    const isPImage = model === 'prunaai:p-image@upscale';
    if (isPImage) {
      // Megapixel-targeted; clamp to the documented 1–8 range.
      if (Number.isFinite(req.targetMegapixels)) {
        task.targetMegapixels = Math.max(1, Math.min(8, Math.round(req.targetMegapixels)));
      }
      const s = {};
      if (req.enhanceDetails === true) s.enhanceDetails = true;
      if (req.realism === true) s.realism = true;
      if (Object.keys(s).length) task.settings = s;
    } else {
      // Diffusion upscalers (Clarity / SD Latent): factor + optional settings.
      if (Number.isFinite(req.upscaleFactor)) {
        task.upscaleFactor = Math.max(2, Math.min(4, Math.round(req.upscaleFactor)));
      } else {
        task.upscaleFactor = 2;
      }
      const s = {};
      if (req.positivePrompt) s.positivePrompt = String(req.positivePrompt);
      if (req.negativePrompt) s.negativePrompt = String(req.negativePrompt);
      if (Number.isFinite(req.steps)) s.steps = Math.max(1, Math.min(60, Math.round(req.steps)));
      if (Number.isFinite(req.CFGScale)) s.CFGScale = req.CFGScale;
      if (Number.isFinite(req.seed)) s.seed = Math.max(0, Math.round(req.seed));
      // strength is model-specific: Clarity accepts it, SD Latent (runware:502@1)
      // REJECTS it ("Unsupported use of 'settings.strength'"). Gate on the model
      // so a stray value from the client can't produce a hard API error.
      if (model === 'runware:500@1' && Number.isFinite(req.strength)) {
        s.strength = Math.max(0, Math.min(1, req.strength));
      }
      if (Object.keys(s).length) task.settings = s;
    }

    const key = apiKey();

    let res;
    try {
      res = await fetch(RUNWARE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify([task]),
        signal: req.signal,
      });
    } catch (e) {
      if (e?.name === 'AbortError') {
        throw new ProviderError('Upscale cancelled', { provider: 'runware', code: 'timeout', status: 499 });
      }
      throw new ProviderError(`Network error reaching Runware: ${e.message}`, {
        provider: 'runware', code: 'upstream', status: 502,
      });
    }

    let body;
    try {
      body = await res.json();
    } catch {
      throw new ProviderError(`Runware returned non-JSON (HTTP ${res.status})`, {
        provider: 'runware', code: 'upstream', status: 502,
      });
    }

    const errors = body?.errors || (body?.error ? [body.error] : null);
    if (errors && errors.length) throw mapRunwareError(errors[0], res.status, body);

    const items = Array.isArray(body?.data) ? body.data : [];
    // Match on taskUUID only — the response taskType is `imageUpscale`, not the
    // `upscale` we sent, so filtering by type would drop every result.
    const ours = items.filter((d) => d.taskUUID === taskUUID);
    if (!ours.length) {
      throw new ProviderError('Runware response contained no upscaled image for this task', {
        provider: 'runware', code: 'upstream', status: 502, raw: body,
      });
    }

    const d = ours[0];
    const costUsd = typeof d.cost === 'number' ? d.cost : undefined;
    return {
      provider: 'runware',
      model: req.model,
      image: { url: d.imageURL, b64: d.imageBase64Data || undefined },
      costUsd,
      raw: body,
    };
  },

  /**
   * Background removal (Tools → Background removal). Uses Runware's
   * `removeBackground` taskType with the source under inputs.image. BiRefNet
   * variants (runware:112@1 General, 112@2 COD, 112@10 Portrait) take no width/
   * height/prompt. Output defaults to PNG so the transparent alpha is preserved.
   * The response taskType is `imageBackgroundRemoval`, so we match on taskUUID
   * only (same as upscale).
   * @param {{model:string, inputImage:string, outputFormat?:string, outputQuality?:number, signal?:AbortSignal}} req
   * @returns {Promise<{provider:string, model:string, image:{url:string,b64?:string}, costUsd?:number, raw?:Object}>}
   */
  async removeBackground(req) {
    const taskUUID = randomUUID();
    const task = {
      taskType: 'removeBackground',
      taskUUID,
      model: req.model,
      outputType: 'URL',
      outputFormat: req.outputFormat && /^(JPG|PNG|WEBP)$/.test(req.outputFormat) ? req.outputFormat : 'PNG',
      includeCost: true,
      inputs: { image: req.inputImage },
    };
    if (Number.isFinite(req.outputQuality)) {
      task.outputQuality = Math.max(20, Math.min(99, Math.round(req.outputQuality)));
    }

    const key = apiKey();

    let res;
    try {
      res = await fetch(RUNWARE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify([task]),
        signal: req.signal,
      });
    } catch (e) {
      if (e?.name === 'AbortError') {
        throw new ProviderError('Background removal cancelled', { provider: 'runware', code: 'timeout', status: 499 });
      }
      throw new ProviderError(`Network error reaching Runware: ${e.message}`, {
        provider: 'runware', code: 'upstream', status: 502,
      });
    }

    let body;
    try {
      body = await res.json();
    } catch {
      throw new ProviderError(`Runware returned non-JSON (HTTP ${res.status})`, {
        provider: 'runware', code: 'upstream', status: 502,
      });
    }

    const errors = body?.errors || (body?.error ? [body.error] : null);
    if (errors && errors.length) throw mapRunwareError(errors[0], res.status, body);

    const items = Array.isArray(body?.data) ? body.data : [];
    // Response taskType is `imageBackgroundRemoval`, not the `removeBackground`
    // we sent — match on taskUUID only (mirrors the upscale path).
    const ours = items.filter((d) => d.taskUUID === taskUUID);
    if (!ours.length) {
      throw new ProviderError('Runware response contained no image for this task', {
        provider: 'runware', code: 'upstream', status: 502, raw: body,
      });
    }

    const d = ours[0];
    const costUsd = typeof d.cost === 'number' ? d.cost : undefined;
    return {
      provider: 'runware',
      model: req.model,
      image: { url: d.imageURL, b64: d.imageBase64Data || undefined },
      costUsd,
      raw: body,
    };
  },

  /**
   * Returns normalized rows the frontend can drop straight into the dropdown.
   * @param {Object} opts
   * @param {string} [opts.search]        Free-text query (name/description/AIR id).
   * @param {string} [opts.architecture]  e.g. "sdxl" | "flux" | "sd".
   * @param {string} [opts.category]      e.g. "checkpoint".
   * @param {number} [opts.limit=20]
   * @param {number} [opts.offset=0]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<{total:number, models:Array<{id:string,label:string,architecture?:string,open:boolean}>}>}
   */
  async searchModels(opts = {}) {
    const key = apiKey();
    const task = {
      taskType: 'modelSearch',
      taskUUID: randomUUID(),
      visibility: 'all',
      limit: Math.max(1, Math.min(100, opts.limit ?? 20)),
      offset: Math.max(0, opts.offset ?? 0),
    };
    if (opts.search) task.search = opts.search;
    if (opts.architecture) task.architecture = opts.architecture;
    if (opts.category) task.category = opts.category;

    let res, body;
    try {
      res = await fetch(RUNWARE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify([task]),
        signal: opts.signal,
      });
      body = await res.json();
    } catch (e) {
      throw new ProviderError(`Model search failed: ${e.message}`, { provider: 'runware', code: 'upstream', status: 502 });
    }

    const errors = body?.errors || (body?.error ? [body.error] : null);
    if (errors && errors.length) throw mapRunwareError(errors[0], res.status, body);

    const row = (Array.isArray(body?.data) ? body.data : []).find((d) => d.taskType === 'modelSearch') || {};
    // Runware returns model rows with an AIR id; field names can include `air`,
    // `model`, or `id` depending on version, so we read defensively.
    const results = Array.isArray(row.results) ? row.results : Array.isArray(row.models) ? row.models : [];
    const models = results.map((m) => {
      const air = m.air || m.airId || m.model || m.id;
      return {
        id: air ? `runware:${air}` : undefined,
        label: m.name || m.title || air,
        architecture: m.architecture,
        open: true, // community/search results are open-source by nature
      };
    }).filter((m) => m.id);

    return { total: typeof row.totalResults === 'number' ? row.totalResults : (row.total ?? models.length), models };
  },
};

function mapRunwareError(err, httpStatus, raw) {
  const code = err?.code || '';
  const message = err?.message || 'Runware error';
  // Best-effort mapping of common cases to stable codes + HTTP statuses.
  if (/auth|unauthor|api ?key|token/i.test(code + message)) {
    return new ProviderError(message, { provider: 'runware', code: 'auth', status: 401, raw });
  }
  if (/rate|quota|too many/i.test(code + message) || httpStatus === 429) {
    return new ProviderError(message, { provider: 'runware', code: 'rate_limit', status: 429, raw });
  }
  if (/nsfw|safety|content/i.test(code + message)) {
    return new ProviderError(message, { provider: 'runware', code: 'content_filtered', status: 422, raw });
  }
  if (/invalid|missing|param|model/i.test(code + message)) {
    return new ProviderError(message, { provider: 'runware', code: 'bad_request', status: 400, raw });
  }
  return new ProviderError(message, { provider: 'runware', code: 'upstream', status: 502, raw });
}
