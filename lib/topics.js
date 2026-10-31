// Saved topic clusters: small records (titles, themes, one-line summaries, links between pages) in extension storage.
// Article text is not stored here; it comes from the expiring Wikipedia cache when a topic is searched.
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});
  const SUMMARY_CHARS = 280;
  const ADDED_FACET = 'Added by you';

  // chrome.storage.local in the extension; memory elsewhere (Node tests, the page harness).
  const memoryStore = {};
  const store = {
    async get(key) {
      if (g.chrome?.storage?.local) return (await chrome.storage.local.get(key))[key];
      return memoryStore[key];
    },
    async set(key, value) {
      if (g.chrome?.storage?.local) await chrome.storage.local.set({ [key]: value });
      else memoryStore[key] = value;
    },
  };

  const all = async () => (await store.get('topics')) || {};

  async function save(topic) {
    const topics = await all();
    topic.updatedAt = Date.now();
    topics[topic.id] = topic;
    await store.set('topics', topics);
    return topic;
  }

  async function get(id) {
    return id ? (await all())[id] || null : null;
  }

  async function list() {
    return Object.values(await all())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => ({ id: t.id, name: t.name, lang: t.lang, seed: t.seed, pages: t.pages.length, facets: t.facets.length, updatedAt: t.updatedAt }));
  }

  async function remove(id) {
    const topics = await all();
    delete topics[id];
    await store.set('topics', topics);
    if ((await store.get('activeTopic')) === id) await store.set('activeTopic', null);
  }

  const getActive = async () => get(await store.get('activeTopic'));
  const setActive = (id) => store.set('activeTopic', id || null);

  async function describe(lang, title) {
    const s = await W.wiki.getSummary(lang, title).catch(() => null);
    return { description: s?.description || '', summary: (s?.extract || '').slice(0, SUMMARY_CHARS) };
  }

  async function addPage(id, title, facet = ADDED_FACET) {
    const topic = await get(id);
    if (!topic) throw new Error('Topic not found');
    const resolved = (await W.wiki.resolveTitles(topic.lang, [title])).get(W.wiki.normTitle(title));
    if (!resolved) throw new Error(`No article called "${title}"`);
    if (topic.pages.some((p) => p.title === resolved)) return topic;
    topic.pages.push({ title: resolved, facet, why: '', ...(await describe(topic.lang, resolved)) });
    if (!topic.facets.some((f) => f.name === facet)) topic.facets.push({ name: facet, why: '' });
    const others = topic.pages.map((p) => p.title).filter((t) => t !== resolved);
    const [out, inc] = await Promise.all([
      W.wiki.linksBetween(topic.lang, [resolved], others),
      W.wiki.linksBetween(topic.lang, others, [resolved]),
    ]);
    topic.edges.push(...out, ...inc);
    return save(topic);
  }

  async function removePage(id, title) {
    const topic = await get(id);
    if (!topic) throw new Error('Topic not found');
    topic.pages = topic.pages.filter((p) => p.title !== title);
    topic.edges = topic.edges.filter(([a, b]) => a !== title && b !== title);
    topic.facets = topic.facets.filter((f) => topic.pages.some((p) => p.facet === f.name));
    return save(topic);
  }

  // All topic articles chunked into one search index, kept in memory while the topic is unchanged.
  const corpora = new Map();
  async function corpus(topic, onProgress) {
    const key = `${topic.id}:${topic.updatedAt}`;
    if (corpora.has(key)) return corpora.get(key);
    let done = 0;
    const pages = await W.wiki.mapLimit(topic.pages, 6, async (p) => {
      const entry = await W.wiki.getIndexedPage(topic.lang, p.title).catch(() => null);
      onProgress?.(++done, topic.pages.length);
      return entry;
    });
    const byPage = new Map();
    for (const e of pages) if (e) byPage.set(e.page.title, e);
    // Topic pages may be stored under a redirect source; map them to what Wikipedia returned.
    topic.pages.forEach((p, i) => pages[i] && byPage.set(p.title, pages[i]));
    const chunks = [...new Set([...byPage.values()])].flatMap((e) => e.chunks);
    const facetOf = new Map(topic.pages.map((p, i) => [pages[i]?.page.title || p.title, p.facet]));
    const index = new W.bm25.BM25(chunks, (c) => `${c.page} ${c.section} ${c.section} ${c.text}`);
    const result = { chunks, index, byPage, facetOf };
    corpora.clear(); // one topic at a time is plenty
    corpora.set(key, result);
    return result;
  }

  // Message API used by the content script (via the background, or directly in the test harness).
  async function handle(msg) {
    switch (msg.type) {
      case 'topics:list': return list();
      case 'topics:active': return getActive();
      case 'topics:setActive': await setActive(msg.id); return getActive();
      case 'topics:delete': await remove(msg.id); return list();
      case 'topics:addPage': return addPage(msg.id, msg.title);
      case 'topics:removePage': return removePage(msg.id, msg.title);
      case 'cache:stats': return { ...(await W.cache.stats()), topics: (await list()).length };
      case 'cache:clear': await W.cache.clear(); return W.cache.stats();
      default: return undefined;
    }
  }

  W.topics = { save, get, list, remove, getActive, setActive, addPage, removePage, describe, corpus, handle, ADDED_FACET };
})(globalThis);
