// ═══════════════════════════════════════════════════════════════════════════
// bm-doc.js — Beast Mode ZK document transport layer
// ═══════════════════════════════════════════════════════════════════════════
//
// Extracted from app.html (library-subsystem-map.md §6.1 — "cleanest possible
// cut"). This module owns the encrypt/PUT, GET/decrypt, list, R2-restore, and
// debounced-snapshot transport for the per-account zero-knowledge docs. It does
// NOT own any library/preset/model STATE — that stays in the main file (and a
// future bm-library.js). The doc-key allowlist `BM_DOC_KEYS` also stays in the
// main inline scope (32 bare references depend on it lexically); the main file
// bridges it to `window.BM_DOC_KEYS` for this module to read.
//
// Loaded as a CLASSIC <script src="./bm-doc.js"> AFTER the main inline script,
// so the helpers it reads (window._b64FromBytes, window._bytesFromB64,
// window.pbPasteToast, window.BM_DOC_KEYS, window.bmSession) are already
// defined by call-time. All public functions are attached to `window` at the
// bottom so the ~36 bare call sites across the inline scope keep working
// unchanged.
//
// Dependency surface (all read off `window`, never owned here):
//   window.bmSession          — { sessionToken, dataKey }   (auth)
//   window.BM_DOC_KEYS        — doc-key allowlist            (main inline)
//   window._b64FromBytes      — Uint8Array → base64          (main inline)
//   window._bytesFromB64      — base64 → Uint8Array          (main inline)
//   window.pbPasteToast       — toast helper (optional)      (main inline)
//   window.__bmLockedSaveWarned — once-per-session warn flag (main inline)
//   crypto.subtle, fetch, TextEncoder/TextDecoder            (platform)
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // True when we have a session token AND the DATA KEY (i.e. unlocked). Doc
  // save/load both require the key — without it we can neither encrypt nor
  // decrypt, so callers fall back to localStorage only.
  function bmDocReady() {
    const s = window.bmSession;
    return !!(s && s.sessionToken && s.dataKey);
  }

  // Encrypt + PUT one doc to Fly. `obj` is any JSON-serialisable value. Returns
  // true on success. Best-effort: never throws (callers keep their local copy).
  async function bmDocSave(docKey, obj) {
    try {
      if (!bmDocReady()) {
        // (C) Surface the silent-loss vector once per session. If we're signed in
        // (have a session token) but LOCKED (no DATA KEY), a prompts-doc save can't
        // encrypt — so library changes only reach localStorage and won't survive a
        // cache clear. Warn the user ONCE so they can unlock and re-sync, instead
        // of discovering missing images later. Other doc keys stay silent.
        try {
          const s = window.bmSession;
          if (docKey === window.BM_DOC_KEYS.PROMPTS && s && s.sessionToken && !s.dataKey
              && !window.__bmLockedSaveWarned) {
            window.__bmLockedSaveWarned = true;
            if (typeof window.pbPasteToast === 'function') {
              window.pbPasteToast('Library locked — unlock to sync new images across devices');
            }
          }
        } catch (_) {}
        return false; // locked → localStorage only, no remote write
      }
      const sess = window.bmSession;
      const plain = new TextEncoder().encode(JSON.stringify(obj));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sess.dataKey, plain);
      const res = await fetch('/api/data/' + encodeURIComponent(docKey), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + sess.sessionToken },
        body: JSON.stringify({ iv: window._b64FromBytes(iv), ct: window._b64FromBytes(new Uint8Array(ctBuf)) }),
      });
      if (!res.ok) return false;
      bmScheduleSnapshot(); // debounced offsite backup
      return true;
    } catch (e) { return false; }
  }

  // GET + decrypt one doc from Fly. Returns the parsed object, or null when
  // absent / locked / on any failure (caller falls back to localStorage).
  async function bmDocLoad(docKey) {
    try {
      if (!bmDocReady()) return null;
      const sess = window.bmSession;
      const res = await fetch('/api/data/' + encodeURIComponent(docKey), {
        headers: { 'Authorization': 'Bearer ' + sess.sessionToken },
      });
      if (res.status === 404) return null; // no doc yet
      if (!res.ok) return null;
      const pd = await res.json().catch(() => null);
      if (!pd || !pd.iv || !pd.ct) return null;
      const iv = window._bytesFromB64(pd.iv);
      const ct = window._bytesFromB64(pd.ct);
      const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, sess.dataKey, ct);
      return JSON.parse(new TextDecoder().decode(plainBuf));
    } catch (e) { return null; }
  }

  // List the server-side doc index (docKey + ver + updatedAt, no ciphertext).
  async function bmDocList() {
    try {
      if (!bmDocReady()) return [];
      const sess = window.bmSession;
      const res = await fetch('/api/data', { headers: { 'Authorization': 'Bearer ' + sess.sessionToken } });
      if (!res.ok) return [];
      const pd = await res.json().catch(() => null);
      return (pd && Array.isArray(pd.docs)) ? pd.docs : [];
    } catch (e) { return []; }
  }

  // Restore one doc from its R2 snapshot into Fly (recovery). Returns true if a
  // snapshot existed and was restored server-side.
  async function bmDocRestoreFromR2(docKey) {
    try {
      if (!bmDocReady()) return false;
      const sess = window.bmSession;
      const res = await fetch('/api/data/' + encodeURIComponent(docKey) + '/restore', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + sess.sessionToken },
      });
      if (!res.ok) return false;
      const pd = await res.json().catch(() => ({}));
      return !!pd.restored;
    } catch (e) { return false; }
  }

  // ── Debounced R2 snapshot (decision 2: periodic, all-docs, NOT write-through) ─
  let _bmSnapTimer = null;
  function bmScheduleSnapshot() {
    if (_bmSnapTimer) clearTimeout(_bmSnapTimer);
    _bmSnapTimer = setTimeout(() => { _bmSnapTimer = null; bmSnapshotNow(); }, 90000); // 90s after last write
  }
  async function bmSnapshotNow() {
    try {
      if (!bmDocReady()) return;
      const sess = window.bmSession;
      await fetch('/api/data/snapshot', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + sess.sessionToken }, keepalive: true,
      });
    } catch (e) { /* best-effort */ }
  }
  // Flush a pending snapshot on logout / tab close so a backup isn't lost.
  window.addEventListener('beforeunload', () => {
    if (_bmSnapTimer) { clearTimeout(_bmSnapTimer); _bmSnapTimer = null; bmSnapshotNow(); }
  });

  // ── Bridge to globals ───────────────────────────────────────────────────────
  // The ~36 call sites across the main inline scope reference these as bare
  // globals. A classic external <script> has its own function scope, so we must
  // explicitly publish them on `window`.
  window.bmDocReady         = bmDocReady;
  window.bmDocSave          = bmDocSave;
  window.bmDocLoad          = bmDocLoad;
  window.bmDocList          = bmDocList;
  window.bmDocRestoreFromR2 = bmDocRestoreFromR2;
  window.bmScheduleSnapshot = bmScheduleSnapshot;
  window.bmSnapshotNow      = bmSnapshotNow;
})();
