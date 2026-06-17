# Spec — Upscaler thumbnail parity + Drive decoupling

**File:** `beast-mode-mech-my-ride-v4.html` only. Pure JS, no CSS, no backend.
**Goal:** Bottom-bar picker and library grid both show fast compressed thumbs,
sourced from Fly.io/R2 — never dependent on Drive. Backfill thumbless favs on
unlock/login. Fix the misleading Drive message.

---

## Change 1 — Eager background thumb sweep on unlock/login

**Where:** `bmThumbsOnUnlock()` (~line 20148). It already fires when the DATA KEY
becomes available (called at ~line 23051 in the sign-in path) and on unlock.

**Add** a new function `bmThumbSweep()` and call it (fire-and-forget) from the
end of `bmThumbsOnUnlock()`.

**Behaviour:**
- Guard: require `window.bmSession.sessionToken` + `dataKey`; bail otherwise
  (can't encrypt without the key).
- Re-entrancy guard: module-level `let _bmThumbSweeping = false;` — bail if true.
- Select targets: `favourites.filter(f => f && f.imageData && !f.thumbKey)`.
- Throttle: process sequentially with a small delay (e.g. `await sleep(150)`
  between items) so a large library doesn't saturate the network or pin the
  main thread during canvas encode. Cap concurrency at 1.
- For each target, resolve a source to thumbnail from, in order:
  1. local cache (`bmGetCachedImage(f.id)`) — already a blob: URL, cheapest
  2. server full-size (`bmFetchServerImage(f.serverImageUrl || <imageData if /api/img>)`)
  3. `f.imageData` if it's inline data: (not an /api/img URL)
  Skip the item if none resolve (don't fetch Drive — sweep is Fly/R2-only).
- Call existing `bmThumbUpload(f, src)` with the resolved src. It already:
  encrypts under DATA KEY → presign-put → PUT → sets `thumbKey/thumbIv/thumbMime`
  → `lsSave(LS.FAVS)` → `driveSavePrompt(f)`.
- After the sweep finishes (or every N items), refresh open surfaces so new
  thumbs appear without a reload: if `renderFavs` exists call it; if the
  upscaler view is active and `upRenderLibBar` exists, call that too.
- `_bmThumbSweeping = false` in a `finally`.

**Add helper** (if no sleep util exists — grep `function sleep` / `=> new Promise` first):
`const _bmSleep = (ms) => new Promise(r => setTimeout(r, ms));`

**Verify:** grep `function sleep` and `_bmSleep` to avoid a duplicate.

---

## Change 2 — Make the terminal fallback message Drive-conditional

**Where:** `bmImageFallback()` (~line 23719), final else branch (~line 23737):

Current:
```
  imgEl.style.opacity = '0.25'
  imgEl.title = 'Image no longer available — connect Google Drive to keep all images'
```

New:
```
  imgEl.style.opacity = '0.25'
  imgEl.title = (typeof driveBackupEnabled === 'function' && driveBackupEnabled())
    ? 'Image no longer available — try reconnecting Google Drive'
    : 'Image unavailable'
```

Rationale: Drive is opt-in backup now; only mention it if the user actually
enabled it. Otherwise the generic message stops implying Drive is required.

**Search string (unique):** `connect Google Drive to keep all images`

---

## Change 3 (defensive) — bmApplyThumb fallback should not dead-end on Drive

**Where:** `bmApplyThumb()` (~line 20076). Already correct in ordering (thumb →
cache → server → inline → lock). No change needed for Drive decoupling — it
never calls Drive. Confirm only; **no edit** unless verification shows otherwise.

Per the answered architecture question, the locked-state behaviour
(cache → inline → lock) is KEPT as-is. No change.

---

## Out of scope / explicitly NOT doing
- No backend/.ts changes. presign-put/get already exist and work.
- No change to locked-state rendering (keep cache → inline → lock).
- No CSS. Bottom bar + grid already share `bmApplyThumb`, so parity is achieved
  purely by ensuring thumbs EXIST (Change 1).
- Not touching `CACHE_NAME` (Pete bumps it). Will remind at end.

---

## Validation checklist
1. `node --check` the affected inline `<script>` block.
2. Brace/tag balance unchanged (12/12 scripts, 4/4 styles).
3. Re-grep tracers (all non-zero).
4. Confirm new symbols present: `bmThumbSweep`, `_bmThumbSweeping`.
5. Confirm `connect Google Drive to keep all images` string is gone.
6. Line/byte drift recorded.

## Cache reminder
Frontend asset changed → Pete must bump `CACHE_NAME` in `sw.js`
(`'beast-mode-v4.1'` or next). Claude does NOT edit it.
