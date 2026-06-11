// providers/catalog.js
//
// The CURATED list. These are the models your dropdown shows by default —
// hand-picked so users get good, working options instantly without searching.
// Everything here uses the same canonical id scheme as generate(): the prefix
// before the first ":" selects the provider, the rest is that provider's ref.
//
// All AIR ids below were verified against runware.ai/docs in June 2026:
//   Nano Banana Pro      google:4@2
//   Nano Banana 2        google:4@3
//   GPT Image 2          openai:gpt-image@2
//   Ideogram 4.0         ideogram:4@0
//   Seedream 5.0 Lite    bytedance:seedream@5.0-lite
//   FLUX.2 [max]         bfl:7@1
//   FLUX.2 [pro]         bfl:5@1
//   FLUX.2 [dev]         runware:400@1
//   FLUX.2 [klein] 9B B  runware:400@3
//
// `snap` controls server-side dimension snapping: open SD/FLUX.1 community
// models require width/height as multiples of 64 (snap=true / omitted), while
// the closed/preset models above demand EXACT dimensions from their published
// tables — snapping those would corrupt e.g. 1376x768 -> 1408x768 and 400.

/**
 * @typedef {Object} CatalogModel
 * @property {string} id            Canonical id, e.g. "runware:google:4@2".
 * @property {string} label         Human-friendly name for the dropdown.
 * @property {string} family        Grouping for <optgroup>.
 * @property {string} [architecture] Hint for default params.
 * @property {boolean} [open]       True = open-source/community.
 * @property {boolean} [snap]       Snap dims to /64 (default true). False = exact dims.
 * @property {boolean} [i2i]        Supports inputs.referenceImages.
 * @property {string} [note]        One-liner shown as tooltip/subtitle.
 */

/** @type {CatalogModel[]} */
export const CATALOG = [
  // ── Google "Nano Banana" — DIRECT Gemini API (google.js adapter) ──────────
  // Routed via the google: prefix, NOT Runware, so the Google AI Studio free
  // tier can be used. Requires GEMINI_API_KEY (soft-degrades if unset).
  {
    id: 'google:gemini-3-pro-image',
    label: 'Nano Banana Pro',
    family: 'Google',
    architecture: 'gemini',
    snap: false,
    i2i: true,
    note: 'Gemini 3 Pro Image — 1K/2K/4K, multi-image blending, top quality.',
  },
  {
    id: 'google:gemini-3.1-flash-image',
    label: 'Nano Banana 2',
    family: 'Google',
    architecture: 'gemini',
    snap: false,
    i2i: true,
    note: 'Gemini 3.1 Flash Image — fast, 4K-capable, great text rendering.',
  },
  {
    id: 'google:gemini-2.5-flash-image',
    label: 'Nano Banana (free tier)',
    family: 'Google',
    architecture: 'gemini',
    snap: false,
    i2i: true,
    note: 'Gemini 2.5 Flash Image — most generous free-tier quota. Ideal for testing.',
  },

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  {
    id: 'runware:openai:gpt-image@2',
    label: 'GPT Image 2',
    family: 'OpenAI',
    architecture: 'free16',
    snap: false,
    i2i: true,
    note: 'Strong prompt fidelity + layout control. Dims 480–3840, /16.',
  },

  // ── Ideogram ───────────────────────────────────────────────────────────────
  {
    id: 'runware:ideogram:4@0',
    label: 'Ideogram 4.0',
    family: 'Ideogram',
    architecture: 'preset',
    snap: false,
    i2i: false,
    note: 'Design/typography specialist. Turbo / Default / Quality speeds.',
  },

  // ── ByteDance ──────────────────────────────────────────────────────────────
  {
    id: 'runware:bytedance:seedream@5.0-lite',
    label: 'Seedream 5.0 Lite',
    family: 'ByteDance',
    architecture: 'preset',
    snap: false,
    i2i: true,
    note: '2K/3K output, single reference image, very low cost.',
  },

  // ── FLUX.2 (Black Forest Labs) ─────────────────────────────────────────────
  {
    id: 'runware:bfl:7@1',
    label: 'FLUX.2 [max]',
    family: 'FLUX.2',
    architecture: 'free32',
    snap: false,
    i2i: true,
    note: 'Maximum prompt adherence, multi-reference editing.',
  },
  {
    id: 'runware:bfl:5@1',
    label: 'FLUX.2 [pro]',
    family: 'FLUX.2',
    architecture: 'free32',
    snap: false,
    i2i: true,
    note: '4MP output, multi-image references, robust edits.',
  },
  {
    id: 'runware:runware:400@1',
    label: 'FLUX.2 [dev]',
    family: 'FLUX.2',
    architecture: 'flux2',
    open: true,
    i2i: true,
    note: 'Open weights — steps/CFG/negative prompt exposed.',
  },
  {
    id: 'runware:runware:400@3',
    label: 'FLUX.2 [klein] 9B',
    family: 'FLUX.2',
    architecture: 'flux2',
    open: true,
    i2i: true,
    note: 'Compact, fast, full sampling control. Great value.',
  },

  // ── FLUX.1 (legacy, kept for speed/price) ──────────────────────────────────
  {
    id: 'runware:runware:100@1',
    label: 'FLUX.1 Schnell',
    family: 'FLUX.1',
    architecture: 'flux',
    open: true,
    note: 'Fastest FLUX, great for drafts (~sub-second).',
  },
  {
    id: 'runware:runware:101@1',
    label: 'FLUX.1 Dev',
    family: 'FLUX.1',
    architecture: 'flux',
    open: true,
    note: 'Higher quality than Schnell, slower.',
  },

  // ── Stable Diffusion XL (open) ────────────────────────────────────────────
  {
    id: 'runware:civitai:101055@128078',
    label: 'SDXL 1.0 (base)',
    family: 'SDXL',
    architecture: 'sdxl',
    open: true,
    note: 'Classic SDXL base. Strong with LoRAs/fine-tunes.',
  },
];

/** Models grouped for the dropdown's <optgroup>s. */
export function catalogByFamily() {
  const groups = {};
  for (const m of CATALOG) {
    (groups[m.family] ||= []).push({ id: m.id, label: m.label, note: m.note, open: !!m.open, i2i: !!m.i2i });
  }
  return Object.entries(groups).map(([family, models]) => ({ family, models }));
}

/** Per-architecture sensible defaults, so the route can fill in steps/CFG by model. */
export function defaultsFor(architecture) {
  switch (architecture) {
    case 'flux':
      return { steps: 4, cfgScale: 1.0, width: 1024, height: 1024 };
    case 'flux2':
      return { steps: 28, cfgScale: 3.5, width: 1024, height: 1024 };
    case 'sdxl':
      return { steps: 30, cfgScale: 7.0, width: 1024, height: 1024 };
    case 'sd':
      return { steps: 25, cfgScale: 7.5, width: 768, height: 768 };
    case 'preset':
    case 'free16':
    case 'free32':
      return { width: 1024, height: 1024 }; // closed models: no steps/CFG
    case 'gemini':
      return { resolution: '1K' }; // direct Gemini: AR + size tier, no pixel dims
    default:
      return { steps: 30, cfgScale: 7.0, width: 1024, height: 1024 };
  }
}

/** Look up a catalog entry by canonical id (for applying defaults / snap rules). */
export function findInCatalog(id) {
  return CATALOG.find((m) => m.id === id) || null;
}
