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

/** @type {Record<string, {id: string, generate: (req: GenerateRequest) => Promise<GenerateResult>}>} */
const REGISTRY = {
  [runwareAdapter.id]: runwareAdapter,
  // [bflAdapter.id]: bflAdapter,   // <- drop-in later, see providers/bfl.js stub
};

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
  const adapter = REGISTRY[prefix];
  if (!adapter) {
    throw new ProviderError(
      `No provider registered for prefix "${prefix}". Registered: ${Object.keys(REGISTRY).join(', ') || '(none)'}`,
      { code: 'bad_request', status: 400 }
    );
  }

  // Apply shared defaults once, so individual adapters stay lean.
  const normalized = {
    width: 1024,
    height: 1024,
    count: 1,
    ...req,
  };

  return adapter.generate(normalized);
}

/** Convenience for a /models endpoint or the frontend dropdown. */
export function registeredProviders() {
  return Object.keys(REGISTRY);
}

/**
 * Provider-agnostic live model search. Defaults to Runware (the only provider
 * with a searchable catalogue today); pass { provider } to target another once
 * it implements searchModels(). Providers without the capability are skipped.
 * @param {Object} opts  { search, architecture, category, limit, offset, provider, signal }
 */
export async function searchModels(opts = {}) {
  const prefix = opts.provider || runwareAdapter.id;
  const adapter = REGISTRY[prefix];
  if (!adapter || typeof adapter.searchModels !== 'function') {
    throw new ProviderError(`Provider "${prefix}" does not support model search`, {
      code: 'bad_request',
      status: 400,
    });
  }
  return adapter.searchModels(opts);
}
