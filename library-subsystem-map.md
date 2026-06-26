# Beast Mode — Library Persistence Subsystem: State & Global Map

Generated from `app.html` (25,361-line fixed base). This is the governing
document for (a) the in-file consolidation done now, and (b) any future
extraction into a standalone `bm-library.js` module.

---

## 1. The subsystem (functions in scope)

These are the functions that own image-library state, persistence, restore, and
reconciliation. They currently live in **five separate regions** of `app.html`:

| Region | Lines (approx) | Functions |
|---|---|---|
| A | 4843 | `deleteFav` |
| B | 5740 | `driveSavePrompt` |
| C | 9006–9145 | `lsSave`, `lsSaveAll`, `lsRestoreAll`, `bmDocSaveAll`, `bmDocRestoreAll` |
| D | 17693–17880 | `bmRegisterUpscaleMeta`, `bmSyncLibraryFromManifest` |
| E | 18113–18620 | `autoSaveGeneratedImage`, `bmThumbUpload`, `bmDocReady`, `bmDocSave`, `bmDocLoad`, `bmDocRestoreFromR2`, `bmScheduleSnapshot`, `bmSnapshotNow` |
| F | 25149–25340 | `bmFindDeadImageFavs`, `bmReconcileDeadImages`, `bmCacheImage`, `bmGetCachedImage` |

**This scatter is the root cause of the vanishing-images bug.** The three
functions that must agree on one invariant — `autoSaveGeneratedImage` (write),
`bmDocRestoreAll` (restore), `bmSyncLibraryFromManifest` (reconcile) — sit in
regions E, C, and D respectively, thousands of lines apart.

---

## 2. The core invariant

> Every code path that adds or changes an image in `favourites` must reach the
> **ZK PROMPTS doc** (`bmDocSave('prompts', favourites)`), and the restore path
> must **never drop** a fav the server still backs.

The bug was a violation of both halves: autosave's doc-write silently no-op'd
when locked, and restore wholesale-replaced `favourites` from the stale doc.
(Fixed by Parts A/B/C in the prior session.)

---

## 3. Shared global STATE (the data the subsystem reads/writes)

The single most important number for an extraction: **`favourites` is mutated at
~18 sites across the whole file**, only 3 of which are in the persistence
cluster. A clean module boundary requires routing ALL of these through one API.

### 3a. `favourites` — the library array. WRITE sites:

| Line | Enclosing function | Region | Operation |
|---|---|---|---|
| 3351 | (top-level) | — | `let favourites = []` (declaration) |
| 4844 | `deleteFav` | A | `.filter` (remove) |
| 5792 | `lsRestoreAll` | C | `[...loaded, ...localOnly]` |
| 6378 | `doSaveFav` | — | `.unshift` |
| 6511 | (select-mode bulk delete) | C-ish | `.filter` (remove) |
| 7342 | `markupFav` | — | `.unshift` |
| 7958 | `iterSaveVariant` | — | `.unshift` |
| 9031 | `lsRestoreAll` path | C | `favourites = savedFavs` |
| 9131 | `bmDocRestoreAll` | C | merge `[...v, ...survivors]` (**fixed B**) |
| 9270 | `handleZipFile` (import) | — | `.unshift` |
| 13223 | `bkiImportAll` (import) | — | `.unshift` |
| 17843 | `bmSyncLibraryFromManifest` | D | `.push` (rehydrate) |
| 18221 | `autoSaveGeneratedImage` | E | `.unshift` (the primary add) |
| 19672 | `bmSaveUploadToLibrary` | — | `.unshift` |
| 22022–22070 | `bmRepairUpscaleLinks` | — | `.splice` (reorder) |
| 25190 | `bmReconcileDeadImages` | F | `.filter` (remove) |

**Extraction debt:** the 8 mutation sites NOT in the cluster (`doSaveFav`,
`markupFav`, `iterSaveVariant`, `handleZipFile`, `bkiImportAll`,
`bmSaveUploadToLibrary`, `bmRepairUpscaleLinks`, select-mode delete) each reach
into `favourites` directly. A real `bm-library.js` must give each of them a
method (`add`, `remove`, `reorder`, `importMany`) — otherwise the boundary leaks.

### 3b. Other shared state globals the cluster touches:

| Global | Written by | Read by |
|---|---|---|
| `favourites` | see 3a | nearly all |
| `customPresets` | `bmDocRestoreAll` | `bmDocSaveAll` |
| `customModels` | `bmDocRestoreAll` | `bmDocSaveAll` |
| `libFolders` | `bmDocRestoreAll` | `bmDocSaveAll` |
| `pbFavParticles` | `bmDocRestoreAll` | `bmDocSaveAll` |
| `pbFormulaPresets` | `bmDocRestoreAll` | `bmDocSaveAll` |
| `pbLibraries` | (elsewhere) | `bmDocRestoreAll`, `bmDocSaveAll` |
| `drivePromptIds` | `driveSavePrompt` | `driveSavePrompt` |
| `_bmManifestSyncing` | `bmSyncLibraryFromManifest` | (reentrancy guard, local-ish) |
| `_thumbUrlCache` | `bmSyncLibraryFromManifest` | thumb subsystem |
| `window.bmSession` | (auth) | `bmDocReady`, `bmDocSave`, `bmDocLoad`, `bmDocRestoreFromR2`, `bmRegisterUpscaleMeta`, `bmSyncLibraryFromManifest` |
| `window.__bmDocRestorePromise` | `setSession` | `bmSyncLibraryFromManifest` |

> Note: `bmDocRestoreAll`/`bmDocSaveAll` are NOT purely library functions — they
> also own presets, models, folders, particles, settings. **This is the key
> finding for extraction scope:** a `bm-library.js` cannot cleanly own the doc
> save/restore *all* path, because that path is multi-domain. Either the module
> owns only `prompts` (and a higher-level orchestrator owns "save/restore all"),
> or the doc layer (`bmDocSave`/`bmDocLoad`/`bmDocReady`) is its own module that
> the library module depends on. **Recommended: doc layer = its own module.**

---

## 4. Shared CONSTANTS the cluster depends on

| Constant | Defined | Purpose |
|---|---|---|
| `BM_DOC_KEYS` | region E (18483) | ZK doc-key allowlist (mirrors server `ALLOWED_DOC_KEYS`) |
| `LS` | (top) | localStorage key map |
| `SETTINGS_DELIMITER` | (top) | `---SETTINGS---` prompt/settings splitter |
| `GEN_IMAGE_MODEL` | (top) | default model fallback |
| `PROMPT_FILE_PREFIX` | (top) | Drive prompt filename prefix |
| `PROMPT_HISTORY_KEY`, `PC_STORAGE_KEY` | (top) | straggler localStorage keys |

---

## 5. External functions the cluster CALLS (its dependency surface)

These are the functions a `bm-library.js` would need imported or injected.
Grouped by subsystem:

**Render / UI:** `renderFavs`, `renderLibrary`, `updateLibBadge`,
`promptHistoryRender`, `setDriveStatus`, `pbPasteToast`

**Thumbnails:** `bmThumbUpload`, `bmApplyThumb`, `bmThumbDecrypt`,
`bmThumbLocked`, `bmBackfillThumbMeta`

**Lineage / family repair:** `bmRepairUpscaleLinks`, `bmRepairFamilyLinks`,
`bmBackfillLineage`, `bmNewLineageRoot`, `bmNextChildLineage`, `bmNewFamilyCode`

**Image bytes:** `bmCacheImage`, `bmGetCachedImage`, `bmFetchServerImage`

**Drive/cloud:** `cloudIsConnected`, `cloudCreateFile`, `cloudPatchFile`,
`driveUploadImage`, `driveFetchImageBlob`, `driveDeletePrompt`,
`driveBackupEnabled`

**Settings:** `captureSettings`, `applySettings`, `pcLoad`

**Crypto/encoding:** `_b64FromBytes`, `_bytesFromB64`, `crypto.subtle`

**Snapshot:** `bmScheduleSnapshot`, `bmSnapshotNow`

---

## 6. Verdict on a future clean extraction

**Achievable, but the boundary must be drawn in TWO layers, not one:**

1. **`bm-doc.js`** — the ZK doc transport: `bmDocReady`, `bmDocSave`,
   `bmDocLoad`, `bmDocRestoreFromR2`. Depends only on `window.bmSession`,
   `BM_DOC_KEYS`, crypto/encoding helpers, `pbPasteToast`. **Cleanest possible
   cut — almost zero app coupling.** Do this first.

2. **`bm-library.js`** — owns `favourites` as private state + the prompts-doc
   persistence/restore/sync/reconcile logic. Exposes:
   `add(fav)`, `remove(id)`, `reorder(...)`, `importMany(favs)`, `getAll()`,
   `restore()`, `syncFromManifest()`, `reconcileDead()`.
   **Blocked until** the 8 scattered `favourites.*` mutation sites (§3a) are
   routed through this API. That's the real work.

3. **Leave `bmDocSaveAll`/`bmDocRestoreAll` as a thin orchestrator** in the main
   file (or a `bm-app-state.js`) — they are multi-domain and shouldn't live
   inside the library module.

**Do NOT** attempt a single `bm-library.js` that also swallows the doc-all path
or leaves the 8 external mutations reaching across the boundary — that's the
half-extraction that keeps the coupling while adding build complexity.

---

## 7. What the consolidation (done now) achieves

Physically groups regions A–F into ONE contiguous block under a banner that
states the §2 invariant, so the write/restore/sync trio is visible together and
the next change to any one of them sees the other two. This is the cheap,
high-signal step. It does **not** change the build, scope, or any behaviour —
it only moves function definitions adjacent to each other.
