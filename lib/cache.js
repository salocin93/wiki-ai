// Tiny key/value cache: IndexedDB when available, memory otherwise (e.g. Node tests).
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});
  const TTL_MS = 24 * 60 * 60 * 1000;
  const memory = new Map();
  let dbPromise = null;

  function openDb() {
    if (!g.indexedDB) return null;
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('wikiai-cache', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }).catch(() => null);
    }
    return dbPromise;
  }

  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
    });
  }

  async function get(key) {
    if (memory.has(key)) return memory.get(key);
    const db = await openDb();
    if (!db) return undefined;
    const entry = await tx(db, 'readonly', (s) => s.get(key)).catch(() => undefined);
    if (!entry || Date.now() - entry.at > TTL_MS) return undefined;
    memory.set(key, entry.value);
    return entry.value;
  }

  async function set(key, value) {
    memory.set(key, value);
    if (memory.size > 200) memory.delete(memory.keys().next().value);
    const db = await openDb();
    if (db) await tx(db, 'readwrite', (s) => s.put({ at: Date.now(), value }, key)).catch(() => {});
  }

  async function wrap(key, producer) {
    const hit = await get(key);
    if (hit !== undefined) return hit;
    const value = await producer();
    await set(key, value);
    return value;
  }

  W.cache = { get, set, wrap };
})(globalThis);
