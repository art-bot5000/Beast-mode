// routes/generate.example.js
//
// Illustrative fly.io backend route. Shows where the abstraction plugs in.
// Auth + Drive/Dropbox save are sketched as the functions you'll already have
// from the earlier pieces of this project — the point here is how little this
// route knows about Runware vs BFL: it just calls generate().

import express from 'express';
import { generate, ProviderError } from '../providers/index.js';

const router = express.Router();

router.post('/api/generate', async (req, res) => {
  // 1) Verified login (the server-side GIS verification we discussed).
  //    requireUser throws/returns 401 if the session/JWT isn't valid.
  let user;
  try {
    user = await requireUser(req); // <- your auth middleware/helper
  } catch {
    return res.status(401).json({ error: 'Not signed in' });
  }

  const { prompt, negativePrompt, model, width, height, steps, cfgScale, count, seed, save } = req.body || {};

  // 2) Generate — the ONE call. Provider is chosen by the model id's prefix.
  let result;
  try {
    result = await generate({ prompt, negativePrompt, model, width, height, steps, cfgScale, count, seed });
  } catch (e) {
    if (e instanceof ProviderError) {
      // Clean, provider-agnostic error surface for the frontend.
      return res.status(e.status).json({ error: e.message, code: e.code });
    }
    console.error('generate failed', e);
    return res.status(500).json({ error: 'Internal error' });
  }

  // 3) Optionally persist to the user's connected cloud, reusing your existing
  //    Drive/Dropbox code. Images come back as URLs, cheap to hand off.
  if (save && result.images.length) {
    try {
      await saveImagesForUser(user, {
        prompt,
        model: result.model,
        images: result.images, // [{ url, seed }]
      });
    } catch (e) {
      // Don't fail the whole request if saving hiccups — return images anyway.
      console.warn('save failed (non-fatal)', e);
    }
  }

  // 4) Optionally record the generation against the verified user (history, metering).
  //    await recordGeneration(user, { model: result.model, cost: result.costUsd });

  return res.json({
    model: result.model,
    provider: result.provider,
    images: result.images,
    costUsd: result.costUsd,
  });
});

export default router;

// ── stubs representing pieces you already have / will have ───────────────────
async function requireUser(_req) { throw new Error('wire to your auth'); }
async function saveImagesForUser(_user, _payload) { /* reuse Drive/Dropbox code */ }
