// Key/value cache for Wikipedia responses: IndexedDB when available, memory otherwise (e.g. Node tests).
// Entries expire after a day and the store is capped, so it can't grow without bound.
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});
  const TTL_MS = 24 * 60 * 60 * 1000;
  const MAX_ENTRIES = 300; // article texts are ~30–150 KB each, so this stays in the tens of MB at most
  const MEMORY_ENTRIES = 40;
  const PRUNE_EVERY = 50; // writes between prunes
  const memory = new Map();
  let dbPromise = null;
  let writes = 0;

  function openDb() {
    if (!g.indexedDB) return null;
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('wikiai-cache', 2);
        req.onupgradeneeded = () => {
          const db = req.result;
          // v1 had no timestamps index; it only held disposable cache entries, so start over.
          for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
          db.createObjectStore('kv'); // key → value
          db.createObjectStore('meta'); // key → last write time, small, used for pruning
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
        .then((db) => {
          prune(db).catch(() => {});
          return db;
        })
        .catch(() => null);
    }
    return dbPromise;
  }

  function tx(db, stores, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      const req = fn(t);
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
    });
  }

  // Deletes expired entries, then the oldest ones beyond MAX_ENTRIES.
  async function prune(db) {
    const [keys, times] = await Promise.all([
      tx(db, 'meta', 'readonly', (t) => t.objectStore('meta').getAllKeys()),
      tx(db, 'meta', 'readonly', (t) => t.objectStore('meta').getAll()),
    ]);
    const entries = keys.map((key, i) => ({ key, at: times[i] })).sort((a, b) => b.at - a.at);
    const now = Date.now();
    const doomed = entries.filter((e, i) => now - e.at > TTL_MS || i >= MAX_ENTRIES).map((e) => e.key);
    if (!doomed.length) return 0;
    await tx(db, ['kv', 'meta'], 'readwrite', (t) => {
      for (const key of doomed) {
        t.objectStore('kv').delete(key);
        t.objectStore('meta').delete(key);
      }
    });
    return doomed.length;
  }

  function remember(key, value) {
    memory.delete(key);
    memory.set(key, value);
    if (memory.size > MEMORY_ENTRIES) memory.delete(memory.keys().next().value);
  }

  async function get(key) {
    if (memory.has(key)) return memory.get(key);
    const db = await openDb();
    if (!db) return undefined;
    const [value, at] = await Promise.all([
      tx(db, 'kv', 'readonly', (t) => t.objectStore('kv').get(key)),
      tx(db, 'meta', 'readonly', (t) => t.objectStore('meta').get(key)),
    ]).catch(() => []);
    if (value === undefined || !at || Date.now() - at > TTL_MS) return undefined;
    remember(key, value);
    return value;
  }

  async function set(key, value) {
    remember(key, value);
    const db = await openDb();
    if (!db) return;
    await tx(db, ['kv', 'meta'], 'readwrite', (t) => {
      t.objectStore('kv').put(value, key);
      t.objectStore('meta').put(Date.now(), key);
    }).catch(() => {});
    if (++writes % PRUNE_EVERY === 0) prune(db).catch(() => {});
  }

  async function wrap(key, producer) {
    const hit = await get(key);
    if (hit !== undefined) return hit;
    const value = await producer();
    await set(key, value);
    return value;
  }

  // Storage estimate for the settings page.
  async function stats() {
    const db = await openDb();
    const entries = db ? await tx(db, 'meta', 'readonly', (t) => t.objectStore('meta').count()) : memory.size;
    const estimate = await g.navigator?.storage?.estimate?.().catch(() => null);
    return { entries, bytes: estimate?.usage ?? null };
  }

  async function clear() {
    memory.clear();
    const db = await openDb();
    if (db) await tx(db, ['kv', 'meta'], 'readwrite', (t) => {
      t.objectStore('kv').clear();
      t.objectStore('meta').clear();
    });
  }

  W.cache = { get, set, wrap, stats, clear, prune: async () => prune(await openDb()) };
})(globalThis);
