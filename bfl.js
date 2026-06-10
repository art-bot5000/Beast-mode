// providers/bfl.js
//
// STUB — not wired in yet. This is the "later" adapter. When you're ready to
// hit FLUX directly (cheaper per image than going through a reseller), fill in
// the TODOs, then add ONE line to the registry in providers/index.js:
//
//     import { bflAdapter } from './bfl.js';
//     [bflAdapter.id]: bflAdapter,
//
// Nothing else changes. The model dropdown just starts offering "bfl:..." ids,
// the router sends them here, and the rest of your app is none the wiser.
//
// BFL's API is ASYNCHRONOUS: you POST a job, get an id + polling URL, then poll
// until status is "Ready". That's why we built the contract async from day one
// — this adapter does its polling internally and still returns a single
// resolved GenerateResult, exactly like the synchronous Runware one.

import { ProviderError, parseModelId } from './index.js';

const BFL_BASE = 'https://api.bfl.ai'; // TODO: confirm against current BFL docs when you wire this up

function apiKey() {
  const k = process.env.BFL_API_KEY;
  if (!k) throw new ProviderError('BFL_API_KEY is not set', { provider: 'bfl', code: 'auth', status: 500 });
  return k;
}

// Map our canonical refs to BFL endpoints, e.g. "flux.2-pro" -> "/v1/flux-pro-1.1"
const MODEL_ROUTES = {
  // 'flux.2-pro':  '/v1/flux-2-pro',
  // 'flux.2-klein':'/v1/flux-2-klein',
};

export const bflAdapter = {
  id: 'bfl',

  async generate(req) {
    const [, ref] = parseModelId(req.model);
    const path = MODEL_ROUTES[ref];
    if (!path) {
      throw new ProviderError(`Unknown BFL model "${ref}"`, { provider: 'bfl', code: 'bad_request', status: 400 });
    }

    // 1) Submit the job.
    //    const submit = await fetch(`${BFL_BASE}${path}`, {
    //      method: 'POST',
    //      headers: { 'Content-Type': 'application/json', 'x-key': apiKey() },
    //      body: JSON.stringify({ prompt: req.prompt, width: req.width, height: req.height, seed: req.seed }),
    //      signal: req.signal,
    //    });
    //    const { id, polling_url } = await submit.json();

    // 2) Poll polling_url until result.status === 'Ready', then read result.sample (a URL).
    //    Respect req.signal for cancellation; add a max-wait timeout -> ProviderError code 'timeout'.

    // 3) return {
    //      provider: 'bfl',
    //      model: req.model,
    //      images: [{ url: result.sample, seed: req.seed }],
    //      raw: result,
    //    };

    throw new ProviderError('BFL adapter not yet implemented', { provider: 'bfl', code: 'upstream', status: 501 });
  },
};
