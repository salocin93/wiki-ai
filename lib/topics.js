// Saved topic clusters: small records (titles, themes, one-line summaries, links between pages) in extension storage.
// Article text is not stored here; it comes from the expiring Wikipedia cache when a topic is searched.
import { bm25 } from './bm25.js';
import { cache } from './cache.js';
import { conversations } from './conversations.js';
import { storage } from './storage.js';
import { wiki } from './wiki.js';

const SUMMARY_CHARS = 280;
const ADDED_FACET = 'Added by you';

const MAX_TOPICS = 50; // least recently changed ones go first, with their chats
const LOCK = 'topics';
const store = storage;

const all = async () => {
  const topics = (await store.get('topics')) || {};
  // Leave out damaged records rather than failing every lookup.
  for (const [id, t] of Object.entries(topics)) if (!Array.isArray(t?.pages) || !Array.isArray(t?.facets)) delete topics[id];
  return topics;
};

// Every change to the stored topics goes through here, one at a time. change(topics) edits them in place.
const update = (change) =>
  store.locked(LOCK, async () => {
    const topics = await all();
    const result = await change(topics);
    await store.set('topics', topics);
    return result;
  });

/** @param {Topic} topic */
async function save(topic) {
  const dropped = await update((topics) => {
    topic.updatedAt = Date.now();
    topics[topic.id] = topic;
    const old = Object.values(topics).sort((a, b) => b.updatedAt - a.updatedAt).slice(MAX_TOPICS);
    for (const t of old) delete topics[t.id];
    return old.map((t) => t.id);
  });
  for (const id of dropped) await dropTopicChats(id);
  return topic;
}

const dropTopicChats = (id) => conversations?.clear((scope) => scope === `topic:${id}`);

async function get(id) {
  return id ? (await all())[id] || null : null;
}

async function list() {
  return Object.values(await all())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((t) => ({ id: t.id, name: t.name, lang: t.lang, seed: t.seed, pages: t.pages.length, facets: t.facets.length, updatedAt: t.updatedAt }));
}

async function remove(id) {
  await update(async (topics) => {
    delete topics[id];
    if ((await store.get('activeTopic')) === id) await store.set('activeTopic', null);
  });
  await dropTopicChats(id); // its chats can't be opened without it
}

// Every topic, with the chats asked inside them (chats about single articles stay).
async function clear() {
  await update(async (topics) => {
    for (const id of Object.keys(topics)) delete topics[id];
    await store.set('activeTopic', null);
  });
  await conversations?.clear((scope) => !scope.startsWith('page:'));
  corpora.clear();
}

// Chats of topics that no longer exist (deleted before their chats went with them).
async function dropOrphanChats() {
  const topics = await all();
  await conversations?.clear((scope) => scope.startsWith('topic:') && !topics[scope.slice(6)]);
}

const getActive = async () => get(await store.get('activeTopic'));

// The topic to show on an article: the open one if the article is in it, else the reader's topic built on
// (or containing) this article, else the open one. Looking one up doesn't open it in other tabs. A topic the
// reader closed isn't picked up again on its articles until they open it.
async function forPage(lang, title) {
  const active = await getActive();
  const has = (t) => t.lang === lang && t.pages.some((p) => p.title === title);
  if (active && has(active)) return active;
  const closed = new Set((await store.get('closedTopics')) || []);
  const own = Object.values(await all())
    .filter((t) => has(t) && !closed.has(t.id))
    .sort((a, b) => Number(b.seed === title) - Number(a.seed === title) || b.updatedAt - a.updatedAt);
  return own[0] || active;
}
// Opening a topic makes it the active one. Closing (id null) also stops the closed topic coming back on its own
// articles: `close` names it, since the topic shown on an article isn't always the active one.
async function setActive(id, close = null) {
  const closed = new Set((await store.get('closedTopics')) || []);
  if (id) closed.delete(id);
  else {
    const current = close || (await store.get('activeTopic'));
    if (current) closed.add(current);
  }
  await store.set('closedTopics', [...closed].slice(-MAX_TOPICS));
  await store.set('activeTopic', id || null);
}

async function describe(lang, title) {
  const s = await wiki.getSummary(lang, title).catch(() => null);
  return { description: s?.description || '', summary: (s?.extract || '').slice(0, SUMMARY_CHARS) };
}

// Wikipedia is asked first; the stored topic is then changed in one step, so edits made meanwhile stay.
async function addPage(id, title, facet = ADDED_FACET) {
  const before = await get(id);
  if (!before) throw new Error('Topic not found');
  const resolved = (await wiki.resolveTitles(before.lang, [title])).get(wiki.normTitle(title));
  if (!resolved) throw new Error(`No article called "${title}"`);
  if (before.pages.some((p) => p.title === resolved)) return before;
  const others = before.pages.map((p) => p.title);
  const [about, out, inc] = await Promise.all([
    describe(before.lang, resolved),
    wiki.linksBetween(before.lang, [resolved], others),
    wiki.linksBetween(before.lang, others, [resolved]),
  ]);
  return update((topics) => {
    const topic = topics[id];
    if (!topic) throw new Error('Topic not found');
    if (topic.pages.some((p) => p.title === resolved)) return topic;
    topic.pages.push({ title: resolved, facet, why: '', ...about });
    if (!topic.facets.some((f) => f.name === facet)) topic.facets.push({ name: facet, why: '' });
    topic.edges.push(...[...out, ...inc].filter(([a, b]) => topic.pages.some((p) => p.title === a) && topic.pages.some((p) => p.title === b)));
    topic.updatedAt = Date.now();
    return topic;
  });
}

function removePage(id, title) {
  return update((topics) => {
    const topic = topics[id];
    if (!topic) throw new Error('Topic not found');
    topic.pages = topic.pages.filter((p) => p.title !== title);
    topic.edges = topic.edges.filter(([a, b]) => a !== title && b !== title);
    topic.facets = topic.facets.filter((f) => topic.pages.some((p) => p.facet === f.name));
    topic.updatedAt = Date.now();
    return topic;
  });
}

// All topic articles chunked into one search index, kept in memory while the topic is unchanged.
const corpora = new Map();
async function corpus(topic, onProgress, signal) {
  const key = `${topic.id}:${topic.updatedAt}`;
  if (corpora.has(key)) return corpora.get(key);
  let done = 0;
  // Two at a time: Wikimedia asks clients not to send many requests in parallel.
  const pages = await wiki.mapLimit(topic.pages, 2, async (p) => {
    if (signal?.aborted) return null;
    // Without tables: their HTML would make a 50-article topic a download of tens of MB.
    const entry = await wiki.getIndexedPage(topic.lang, p.title, { html: false, signal }).catch(() => null);
    onProgress?.(++done, topic.pages.length);
    return entry;
  });
  const byPage = new Map();
  for (const e of pages) if (e) byPage.set(e.page.title, e);
  // Topic pages may be stored under a redirect source; map them to what Wikipedia returned.
  topic.pages.forEach((p, i) => pages[i] && byPage.set(p.title, pages[i]));
  const chunks = [...new Set([...byPage.values()])].flatMap((e) => e.chunks);
  const facetOf = new Map(topic.pages.map((p, i) => [pages[i]?.page.title || p.title, p.facet]));
  const index = new bm25.BM25(chunks, (c) => `${c.page} ${c.section} ${c.section} ${c.text}`);
  if (signal?.aborted) throw signal.reason || new Error('Aborted'); // a half-read corpus isn't kept
  const result = { chunks, index, byPage, facetOf };
  corpora.clear(); // one topic at a time is plenty
  corpora.set(key, result);
  return result;
}

// The article cache, and what was built from it in memory.
async function forgetArticles() {
  await cache.clear();
  wiki.forget?.();
  corpora.clear();
}

// Message API used by the content script (via the background, or directly in the test harness).
async function handle(msg) {
  switch (msg.type) {
    case 'topics:list': return list();
    case 'topics:active': return getActive();
    case 'topics:forPage': return forPage(msg.lang, msg.title);
    case 'topics:setActive': await setActive(msg.id, msg.close); return getActive();
    case 'topics:delete': await remove(msg.id); return list();
    case 'topics:clear': await clear(); return list();
    case 'topics:addPage': return addPage(msg.id, msg.title);
    case 'topics:removePage': return removePage(msg.id, msg.title);
    // Which link was pressed last, so the panel opens in the new tab too (see content.js).
    case 'handoff:get': return (await store.get('handoff')) || [];
    case 'handoff:set': await store.set('handoff', msg.list.slice(-5)); return null;
    case 'cache:stats': return { ...(await cache.stats()), topics: (await list()).length };
    case 'cache:clear': await forgetArticles(); return cache.stats();
    // Topics, chats and cached articles. Settings and keys stay.
    case 'data:clear':
      await clear();
      await conversations?.clear();
      await forgetArticles();
      return null;
    default: return conversations?.handle(msg);
  }
}

export const topics = { SUMMARY_CHARS, save, get, list, remove, clear, dropOrphanChats, getActive, setActive, forPage, addPage, removePage, describe, corpus, handle, ADDED_FACET };
