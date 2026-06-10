// providers/catalog.js
//
// The CURATED list. These are the models your dropdown shows by default —
// hand-picked so users get good, working options instantly without searching.
// Everything here uses the same canonical id scheme as generate(): the prefix
// before the first ":" selects the provider, the rest is that provider's ref.
//
// This is intentionally small. The point of a curated list is that every entry
// is one you've verified works and want to recommend. The 300k-model long tail
// is reachable through the live search endpoint (see models.js), not here.
//
// To pin a new CivitAI model: find its AIR id (provider:modelId@versionId) in
// Runware's Model Explorer, then add a row with id "runware:civitai:<m>@<v>".

/**
 * @typedef {Object} CatalogModel
 * @property {string} id            Canonical id, e.g. "runware:civitai:101055@128078".
 * @property {string} label         Human-friendly name for the dropdown.
 * @property {string} family        Grouping for <optgroup>, e.g. "FLUX", "SDXL".
 * @property {string} [architecture] Hint for default params ("flux" | "sdxl" | "sd").
 * @property {boolean} [open]       True = open-source/community (your "now" tier).
 * @property {string} [note]        Optional one-liner shown as a tooltip/subtitle.
 */

/** @type {CatalogModel[]} */
export const CATALOG = [
  // ── FLUX (open) — your starting tier via Runware ──────────────────────────
  {
    id: 'runware:runware:100@1',
    label: 'FLUX.1 Schnell',
    family: 'FLUX',
    architecture: 'flux',
    open: true,
    note: 'Fastest FLUX, great for drafts (~sub-second).',
  },
  {
    id: 'runware:runware:101@1',
    label: 'FLUX.1 Dev',
    family: 'FLUX',
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

  // NOTE: the CivitAI ids above the SDXL base are examples of the FORMAT. Verify
  // each AIR id in Runware's Model Explorer before shipping — CivitAI version
  // ids change, and an unverified id will 400 at generation time. The format is
  // always "runware:civitai:<modelId>@<versionId>".
];

/** Models grouped for the dropdown's <optgroup>s. */
export function catalogByFamily() {
  const groups = {};
  for (const m of CATALOG) {
    (groups[m.family] ||= []).push({ id: m.id, label: m.label, note: m.note, open: !!m.open });
  }
  return Object.entries(groups).map(([family, models]) => ({ family, models }));
}

/** Per-architecture sensible defaults, so the route can fill in steps/CFG by model. */
export function defaultsFor(architecture) {
  switch (architecture) {
    case 'flux':
      return { steps: 4, cfgScale: 1.0, width: 1024, height: 1024 };   // schnell-ish; dev can override
    case 'sdxl':
      return { steps: 30, cfgScale: 7.0, width: 1024, height: 1024 };
    case 'sd':
      return { steps: 25, cfgScale: 7.5, width: 768, height: 768 };
    default:
      return { steps: 30, cfgScale: 7.0, width: 1024, height: 1024 };
  }
}

/** Look up a catalog entry by canonical id (for applying defaults). */
export function findInCatalog(id) {
  return CATALOG.find((m) => m.id === id) || null;
}
