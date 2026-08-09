'use strict';
// Persistence backend abstraction.
// Today this wraps the browser's localStorage. To get durable, cache-clear-proof
// saves (e.g. under Tauri), swap `saveStore` for a filesystem-backed implementation
// that keeps an in-memory cache mirrored to disk — the same synchronous KV surface
// (getItem / setItem / removeItem / keys) keeps main.js unchanged.

function createLocalStorageBackend() {
  const ok = typeof localStorage !== 'undefined';
  return {
    kind: 'localStorage',
    // Survives page reloads, but NOT a browser cache/site-data clear.
    durable: false,
    available: ok,
    getItem(key) { return ok ? localStorage.getItem(key) : null; },
    setItem(key, value) { if (ok) localStorage.setItem(key, value); },
    removeItem(key) { if (ok) localStorage.removeItem(key); },
    keys() {
      if (!ok) return [];
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) out.push(k);
      }
      return out;
    }
  };
}

export const saveStore = createLocalStorageBackend();
