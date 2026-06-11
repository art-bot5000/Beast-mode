// providers/pricing.js
//
// THE TOKEN PRICE TABLE — single source of truth for what a generation costs
// the user, in integer "tokens". This is Pass 3's pricing foundation: the
// ledger (hold → settle → refund) quotes from here, /api/pricing serves the
// table to the frontend, and the dropdown's hard-coded cost strings get
// replaced by these numbers.
//
// ── Design decisions (agreed June 2026) ─────────────────────────────────────
//
// 1 token = $0.01 retail (TOKEN_USD). Integers ONLY — token amounts are never
// floats, anywhere. ceil() at quote time, floor of 1 token per image.
//
// Users are charged the FIXED table price per (model × resolution/quality/
// speed tier), known before they hit Generate. We do NOT pass through actual
// provider cost to users — actual cost (Runware's costUsd, or Gemini cost
// computed from usageMetadata) is logged to the ledger so margin drift is
// observable, but never billed.
//
// TIERED MARGINS — chosen after comparing against Higgsfield's credit pricing
// (their subscription model retails Nano Banana Pro at ~$0.066–0.15/image,
// at or below Google's raw API price, subsidised by breakage + video margin):
//   ×1.40  Google anchor models (Nano Banana Pro / 2 / 2.5) — the models
//          people price-compare. Counter-position: tokens never expire.
//   ×1.75  Mid tier (GPT Image 2, Ideogram, FLUX.2 [max]).
//   ×2.00+ Cheap/draft models — nobody price-compares a 1¢ draft, and drafts
//          dominate volume, so blended margin lands near 2× overall.
//
// Provider costs baked in below were verified June 2026:
//   Gemini:  https://ai.google.dev/gemini-api/docs/pricing
//     gemini-3-pro-image    out images $120/1M tok → $0.134 (1K/2K), $0.24 (4K)
//     gemini-3.1-flash-image out images $60/1M tok → $0.045 (0.5K), $0.067 (1K),
//                                                    $0.101 (2K), $0.151 (4K)
//     gemini-2.5-flash-image $0.039/image (1290 tok @ $30/1M, ≤1024px)
//   Runware: per-model figures from runware.ai/docs (also echoed in IG_MODELS).
//
// UNKNOWN MODELS (live CivitAI search results not in this table) quote
// DEFAULT_TOKENS. Community models run ~$0.002–0.01 so 4 tokens covers 2× up
// to $0.02 actual. The ledger's actual-cost log is the tripwire: if an
// unlisted model ever settles above DEFAULT_TOKENS×TOKEN_USD÷2, it needs a
// table row.
//
// CONSERVATIVE RULE: whenever a variant can't be resolved (unknown resolution
// on a resolution-priced model, GPT "auto" quality, etc.) we charge the MAX
// variant. Never undercharge by guessing low.

export const TOKEN_USD = 0.01;   // 1 token = 1 US cent retail
export const DEFAULT_TOKENS = 4; // unlisted/community models, per image

// ── Canonical pricing keys + aliases ─────────────────────────────────────────
// The same Google model is reachable two ways (direct Gemini API via google.js,
// or via Runware's AIR id). Both alias to ONE pricing row so the user pays the
// same either way and a routing change never silently changes prices.
const ALIASES = {
  'runware:google:4@2': 'google:gemini-3-pro-image',   // Nano Banana Pro
  'runware:google:4@3': 'google:gemini-3.1-flash-image', // Nano Banana 2
};

/**
 * Table rows by canonical id.
 *   kind:'flat'        -> { tokens }
 *   kind:'resolution'  -> { byRes: {'0.5K'|'1K'|'2K'|'4K': tokens} }
 *   kind:'quality'     -> { byQuality: {low|medium|high: tokens} }   (GPT Image)
 *   kind:'speed'       -> { bySpeed: {TURBO|DEFAULT|QUALITY: tokens} } (Ideogram)
 * `costUsd` mirrors the variant structure with the PROVIDER cost we priced
 * against — for margin logging only, never shown to users.
 */
export const PRICING = {
  // ── Google (×1.40 anchor tier) ─────────────────────────────────────────────
  'google:gemini-3-pro-image': {
    label: 'Nano Banana Pro',
    kind: 'resolution',
    byRes: { '1K': 19, '2K': 19, '4K': 34 },
    costUsd: { '1K': 0.134, '2K': 0.134, '4K': 0.24 },
  },
  'google:gemini-3.1-flash-image': {
    label: 'Nano Banana 2',
    kind: 'resolution',
    byRes: { '0.5K': 7, '1K': 10, '2K': 15, '4K': 22 },
    costUsd: { '0.5K': 0.045, '1K': 0.067, '2K': 0.101, '4K': 0.151 },
  },
  'google:gemini-2.5-flash-image': {
    label: 'Nano Banana (2.5)',
    kind: 'flat',
    tokens: 6,
    costUsd: 0.039,
  },

  // ── Mid tier (×1.75) ───────────────────────────────────────────────────────
  'runware:openai:gpt-image@2': {
    label: 'GPT Image 2',
    kind: 'quality',
    byQuality: { low: 2, medium: 11, high: 37 }, // "auto" resolves to max (high)
    costUsd: { low: 0.006, medium: 0.06, high: 0.21 },
  },
  'runware:ideogram:4@0': {
    label: 'Ideogram 4.0',
    kind: 'speed',
    bySpeed: { TURBO: 6, DEFAULT: 11, QUALITY: 18 },
    costUsd: { TURBO: 0.03, DEFAULT: 0.06, QUALITY: 0.10 },
  },
  'runware:bfl:7@1': {
    label: 'FLUX.2 [max]',
    kind: 'flat',
    tokens: 18,
    costUsd: 0.10,
  },

  // ── Cheap/draft tier (×2.00+, floor 1) ────────────────────────────────────
  'runware:bfl:5@1':                  { label: 'FLUX.2 [pro]',      kind: 'flat', tokens: 6, costUsd: 0.03 },
  'runware:bytedance:seedream@5.0-lite': { label: 'Seedream 5.0 Lite', kind: 'flat', tokens: 7, costUsd: 0.035 },
  'runware:runware:400@1':            { label: 'FLUX.2 [dev]',      kind: 'flat', tokens: 4, costUsd: 0.02 },
  'runware:runware:400@3':            { label: 'FLUX.2 [klein] 9B', kind: 'flat', tokens: 3, costUsd: 0.012 },
  'runware:runware:101@1':            { label: 'FLUX.1 Dev',        kind: 'flat', tokens: 2, costUsd: 0.0085 },
  'runware:runware:100@1':            { label: 'FLUX.1 Schnell',    kind: 'flat', tokens: 1, costUsd: 0.0019 },
  'runware:civitai:101055@128078':    { label: 'SDXL 1.0 (base)',   kind: 'flat', tokens: 1, costUsd: 0.0019 },
};

// ── Resolution inference ─────────────────────────────────────────────────────
// The app usually sends resolution presets ('1K'|'2K'|'4K') for preset models,
// but width/height can arrive instead. Map the LONG edge to a bucket,
// rounding UP (conservative rule).
function resBucket({ resolution, width, height } = {}) {
  if (resolution && typeof resolution === 'string') {
    const r = resolution.toUpperCase();
    if (r === '0.5K' || r === '1K' || r === '2K' || r === '4K') return r;
  }
  const edge = Math.max(Number(width) || 0, Number(height) || 0);
  if (!edge) return null;
  if (edge <= 512) return '0.5K';
  if (edge <= 1024) return '1K';
  if (edge <= 2048) return '2K';
  return '4K';
}

function maxOf(obj) {
  return Math.max(...Object.values(obj));
}

/** Resolve a model id to its pricing row (following aliases), or null. */
export function pricingFor(modelId) {
  const key = ALIASES[modelId] || modelId;
  return PRICING[key] || null;
}

/**
 * Integer tokens charged PER IMAGE for a model + options.
 * Unknown model -> DEFAULT_TOKENS. Unknown variant -> max variant (never
 * undercharge). Always >= 1.
 *
 * @param {string} modelId  Canonical id, e.g. "runware:bfl:5@1" or
 *                          "google:gemini-3-pro-image".
 * @param {Object} [opts]   { resolution, width, height, quality, renderingSpeed }
 * @returns {number} integer tokens per image
 */
export function tokensPerImage(modelId, opts = {}) {
  const row = pricingFor(modelId);
  if (!row) return DEFAULT_TOKENS;

  let t;
  switch (row.kind) {
    case 'flat':
      t = row.tokens;
      break;
    case 'resolution': {
      const bucket = resBucket(opts);
      // Bucket the row doesn't list (e.g. 0.5K on NB Pro) -> nearest listed
      // at-or-above, else max. Simplest conservative form: listed or max.
      t = (bucket && row.byRes[bucket]) || maxOf(row.byRes);
      break;
    }
    case 'quality': {
      const q = String(opts.quality || '').toLowerCase();
      t = row.byQuality[q] || maxOf(row.byQuality); // "auto"/missing -> high
      break;
    }
    case 'speed': {
      const s = String(opts.renderingSpeed || '').toUpperCase();
      t = row.bySpeed[s] || row.bySpeed.DEFAULT || maxOf(row.bySpeed);
      break;
    }
    default:
      t = DEFAULT_TOKENS;
  }
  return Math.max(1, Math.ceil(t));
}

/**
 * Full quote for a generation request — what the ledger will HOLD before the
 * provider call, and what the frontend shows next to the Generate button.
 *
 * @param {string} modelId
 * @param {Object} [opts]   Same options as tokensPerImage.
 * @param {number} [count=1] Images requested (clamped to 1..10).
 * @returns {{ modelId, perImage, count, totalTokens, retailUsd, listed }}
 *          listed=false means the model wasn't in the table (DEFAULT_TOKENS).
 */
export function quote(modelId, opts = {}, count = 1) {
  const n = Math.min(10, Math.max(1, Math.floor(Number(count) || 1)));
  const perImage = tokensPerImage(modelId, opts);
  return {
    modelId,
    perImage,
    count: n,
    totalTokens: perImage * n,
    retailUsd: +(perImage * n * TOKEN_USD).toFixed(2),
    listed: !!pricingFor(modelId),
  };
}

/**
 * Estimated PROVIDER cost in USD per image for the priced variant — the number
 * we margined against. For ledger margin logging when the provider doesn't
 * report cost. Null for unlisted models.
 */
export function estimatedCostUsd(modelId, opts = {}) {
  const row = pricingFor(modelId);
  if (!row || row.costUsd == null) return null;
  if (typeof row.costUsd === 'number') return row.costUsd;
  switch (row.kind) {
    case 'resolution': {
      const bucket = resBucket(opts);
      return (bucket && row.costUsd[bucket]) || maxOf(row.costUsd);
    }
    case 'quality': {
      const q = String(opts.quality || '').toLowerCase();
      return row.costUsd[q] || maxOf(row.costUsd);
    }
    case 'speed': {
      const s = String(opts.renderingSpeed || '').toUpperCase();
      return row.costUsd[s] || row.costUsd.DEFAULT || maxOf(row.costUsd);
    }
    default:
      return null;
  }
}

// ── Gemini ACTUAL cost from usageMetadata ────────────────────────────────────
// Gemini doesn't return a dollar figure; it returns token counts. Rates below
// are the June 2026 paid-tier standard rates, USD per 1M tokens. Used ONLY for
// ledger margin logging — users always pay the table price above.
const GEMINI_RATES = {
  'google:gemini-3-pro-image':     { inPerM: 2.00, outTextPerM: 12.00, outImagePerM: 120.00 },
  'google:gemini-3.1-flash-image': { inPerM: 0.50, outTextPerM: 3.00,  outImagePerM: 60.00 },
  'google:gemini-2.5-flash-image': { inPerM: 0.30, outTextPerM: 2.50,  outImagePerM: 30.00 },
};

/**
 * Compute actual USD cost of a direct-Gemini call from its usageMetadata.
 * Falls back to estimatedCostUsd() (caller's job) when metadata is absent.
 *
 * usageMetadata shape (Gemini API):
 *   { promptTokenCount, candidatesTokenCount,
 *     candidatesTokensDetails: [{ modality: 'IMAGE'|'TEXT', tokenCount }] }
 *
 * @returns {number|null} USD, or null if it can't be computed.
 */
export function geminiUsageCostUsd(modelId, usageMetadata) {
  const key = ALIASES[modelId] || modelId;
  const rates = GEMINI_RATES[key];
  if (!rates || !usageMetadata) return null;

  const inTok = Number(usageMetadata.promptTokenCount) || 0;
  let imgTok = 0;
  let txtTok = 0;
  const details = usageMetadata.candidatesTokensDetails;
  if (Array.isArray(details)) {
    for (const d of details) {
      const n = Number(d?.tokenCount) || 0;
      if (String(d?.modality).toUpperCase() === 'IMAGE') imgTok += n;
      else txtTok += n;
    }
  } else {
    // No per-modality breakdown: price ALL output tokens at the image rate
    // (conservative — image rate is the higher one).
    imgTok = Number(usageMetadata.candidatesTokenCount) || 0;
  }
  if (!inTok && !imgTok && !txtTok) return null;

  const usd = (inTok / 1e6) * rates.inPerM
    + (txtTok / 1e6) * rates.outTextPerM
    + (imgTok / 1e6) * rates.outImagePerM;
  return +usd.toFixed(6);
}

/**
 * Serializable public table for GET /api/pricing — everything the frontend
 * needs to label the dropdown and show pre-flight quotes. Provider costs are
 * deliberately EXCLUDED (margin is not a client-side concern).
 */
export function pricingTable() {
  const models = {};
  for (const [id, row] of Object.entries(PRICING)) {
    const m = { label: row.label, kind: row.kind };
    if (row.kind === 'flat') m.tokens = row.tokens;
    if (row.kind === 'resolution') m.byRes = row.byRes;
    if (row.kind === 'quality') m.byQuality = row.byQuality;
    if (row.kind === 'speed') m.bySpeed = row.bySpeed;
    models[id] = m;
  }
  return {
    tokenUsd: TOKEN_USD,
    defaultTokens: DEFAULT_TOKENS,
    aliases: { ...ALIASES },
    models,
  };
}
