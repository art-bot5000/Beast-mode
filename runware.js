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
      width: snap64(req.width, 1024),
      height: snap64(req.height, 1024),
      numberResults: Math.max(1, Math.min(20, req.count ?? 1)),
      outputType: 'URL',
      outputFormat: 'JPG',
      includeCost: true,
    };
    if (req.negativePrompt) task.negativePrompt = req.negativePrompt;
    if (Number.isFinite(req.steps)) task.steps = req.steps;
    if (Number.isFinite(req.cfgScale)) task.CFGScale = req.cfgScale;
    if (Number.isFinite(req.seed)) task.seed = req.seed;

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
   * Live model discovery via Runware's modelSearch task (same endpoint).
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
