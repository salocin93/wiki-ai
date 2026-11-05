// Tests for semantic search with a fake embedding server: node --test test/embeddings.test.mjs (or npm test).
// The fake "embeds" a text as counts of words from four concept groups, so a question can match a passage
// that shares no word with it, which is what keyword search can't do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../lib/agent.js';
import { appSettings } from '../lib/settings.js';
import { bm25 } from '../lib/bm25.js';
import { embeddings } from '../lib/embeddings.js';

const CONCEPTS = [
  ['sky', 'heavens', 'azure', 'sunlight', 'atmosphere', 'scattering', 'blue'],
  ['money', 'bank', 'loan', 'coins', 'treasury'],
  ['cat', 'feline', 'kitten', 'whiskers'],
  ['war', 'army', 'battle', 'soldiers'],
];
const vec = (text) => CONCEPTS.map((words) => words.reduce((n, w) => n + (text.toLowerCase().split(/\W+/).includes(w) ? 1 : 0), 0) + 0.01);

// Replaces fetch for the duration of fn; `handler(url, body, headers)` returns the JSON to answer with, or a Response.
async function withServer(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, headers: init.headers });
    const out = handler(String(url), body, init.headers);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

const geminiServer = (url, body) => ({ embeddings: body.requests.map((r) => ({ values: vec(r.content.parts[0].text) })) });
const openaiServer = (url, body) => ({ data: body.input.map((t, index) => ({ index, embedding: vec(t) })).reverse() }); // out of order on purpose

const GEMINI = { ...appSettings.DEFAULTS, apiKey: 'chat-key', semanticSearch: true };
const LOCAL = { ...appSettings.DEFAULTS, apiKey: 'chat-key', semanticSearch: true, embedBaseUrl: 'http://localhost:11434/v1', embedModel: 'nomic-embed-text' };

let n = 0;
function article(texts) {
  const title = `Article ${++n}`;
  const chunks = texts.map((text, i) => ({ lang: 'en', page: title, section: `S${i}`, text }));
  return { page: { lang: 'en', title, revid: 1 }, chunks, index: new bm25.BM25(chunks, (c) => `${c.section} ${c.text}`) };
}

const PASSAGES = [
  'Rayleigh scattering of sunlight in the atmosphere gives the daytime its colour.',
  'The treasury issued coins and the bank gave out a loan.',
  'The kitten and the feline in the garden.',
  'The army fought a battle and soldiers died.',
];

test('embeddings: semantic search is off unless switched on and a model is known', () => {
  assert.equal(embeddings.config({ ...GEMINI, semanticSearch: false }), null);
  assert.equal(embeddings.config({ ...appSettings.DEFAULTS, semanticSearch: true, provider: 'custom', baseUrl: 'http://localhost:8080/v1' }), null, 'a local server needs a model name');
  assert.equal(embeddings.config(GEMINI).model, 'gemini-embedding-001');
});

test('embeddings: Gemini requests use the native batch endpoint with task types and the chat key', async () => {
  const e = article(PASSAGES);
  await withServer(geminiServer, async (calls) => {
    await embeddings.search(e, 'heavens azure', GEMINI);
    const [docs, query] = calls.sort((a, b) => b.body.requests.length - a.body.requests.length);
    assert.equal(docs.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents');
    assert.equal(docs.headers['x-goog-api-key'], 'chat-key');
    assert.equal(docs.body.requests.length, 4);
    assert.equal(docs.body.requests[0].taskType, 'RETRIEVAL_DOCUMENT');
    assert.equal(docs.body.requests[0].outputDimensionality, 768);
    assert.ok(docs.body.requests[0].content.parts[0].text.startsWith(`${e.page.title} — S0\n`), 'passages carry their article and section');
    assert.equal(query.body.requests[0].taskType, 'RETRIEVAL_QUERY');
  });
});

test('embeddings: a local OpenAI-compatible server gets prefixes and not the chat key', async () => {
  const e = article(PASSAGES);
  const settings = { ...LOCAL, embedDocPrefix: 'search_document: ', embedQueryPrefix: 'search_query: ' };
  await withServer(openaiServer, async (calls) => {
    const hits = await embeddings.search(e, 'heavens azure', settings);
    assert.equal(calls[0].url, 'http://localhost:11434/v1/embeddings');
    assert.equal(calls[0].headers.Authorization, undefined, 'the chat key stays with the chat endpoint');
    assert.ok(calls.find((c) => c.body.input.length === 4).body.input.every((t) => t.startsWith('search_document: ')));
    assert.ok(calls.find((c) => c.body.input.length === 1).body.input[0].startsWith('search_query: heavens'));
    assert.equal(hits[0].doc, e.chunks[0], 'results came back out of order and are matched by index');
  });
});

test('embeddings: finds a passage that shares no word with the question, and drops unrelated ones', async () => {
  const e = article(PASSAGES);
  assert.equal(e.index.search('heavens azure', 4).length, 0, 'keyword search finds nothing');
  await withServer(geminiServer, async () => {
    const hits = await embeddings.search(e, 'heavens azure', GEMINI);
    assert.deepEqual(hits.map((h) => h.doc), [e.chunks[0]]);
  });
});

test('embeddings: vectors are kept, so a second question embeds only the question', async () => {
  const e = article(PASSAGES);
  await withServer(geminiServer, async (calls) => {
    await embeddings.search(e, 'heavens azure', GEMINI);
    const first = calls.length;
    await embeddings.search(e, 'loan from the bank', GEMINI);
    assert.equal(calls.length, first + 1);
    assert.equal(calls.at(-1).body.requests.length, 1);
    // A fresh index of the same revision (e.g. after the service worker restarted) reuses the stored vectors.
    const again = { page: e.page, chunks: e.chunks.map((c) => ({ ...c })), index: e.index };
    await embeddings.search(again, 'loan from the bank', GEMINI);
    assert.equal(calls.length, first + 1, 'question was remembered too');
  });
});

test('embeddings: reciprocal rank fusion puts passages both lists like on top', () => {
  const [a, b, c] = ['a', 'b', 'c'].map((text) => ({ text }));
  const fused = embeddings.fuse([[{ doc: a }, { doc: b }], [{ doc: c }, { doc: b }]], 3);
  assert.equal(fused[0].doc, b);
  assert.equal(fused.length, 3);
});

test('agent: with semantic search on, search_article finds the passage keywords miss', async () => {
  const e = article(PASSAGES);
  const r = new agent.Run({ settings: { ...GEMINI, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'm' }, page: { lang: 'en', title: e.page.title, links: [] }, question: 'q', emit: () => {} });
  r.current = e;
  r.toolTokens = 0;
  r.systemBase = '';
  await withServer(geminiServer, async () => {
    const out = await r.tool('search_article', { query: 'heavens azure' });
    assert.match(out, /Rayleigh scattering/);
    assert.ok(r.trace.notes.some((x) => /found only by meaning/.test(x)));
  });
});

test('agent: with semantic search off, nothing is sent anywhere', async () => {
  const e = article(PASSAGES);
  const r = new agent.Run({ settings: { ...appSettings.DEFAULTS, baseUrl: 'https://x/v1', model: 'm' }, page: { lang: 'en', title: e.page.title, links: [] }, question: 'q', emit: () => {} });
  r.current = e;
  await withServer(geminiServer, async (calls) => {
    const hits = await r.retrieve(e, 'sunlight atmosphere', 3);
    assert.equal(calls.length, 0);
    assert.equal(hits[0].doc, e.chunks[0]);
  });
});

test('agent: a failing embedding service falls back to keywords, says so once, and is not retried at once', async () => {
  const e = article(PASSAGES);
  const steps = [];
  const r = new agent.Run({ settings: { ...GEMINI, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'm' }, page: { lang: 'en', title: e.page.title, links: [] }, question: 'q', emit: (x) => steps.push(x.text) });
  r.current = e;
  await withServer(() => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 }), async (calls) => {
    const hits = await r.retrieve(e, 'sunlight atmosphere', 3);
    assert.equal(hits[0].doc, e.chunks[0], 'keyword results are still returned');
    const sent = calls.length;
    await r.retrieve(e, 'bank loan', 3);
    assert.equal(calls.length, sent + 1, 'only the question is tried again; the passages are not re-embedded within the minute');
  });
  assert.equal(steps.filter((s) => /Semantic search unavailable/.test(s)).length, 1);
  assert.ok(r.trace.notes.some((x) => /API key not valid/.test(x)));
});

test('embeddings: a topic corpus is assembled from its articles, and an oversized one is refused', async () => {
  const a = article(PASSAGES.slice(0, 2));
  const b = article(PASSAGES.slice(2));
  const corpus = { chunks: [...a.chunks, ...b.chunks], entries: [a, b], index: new bm25.BM25([], () => '') };
  await withServer(geminiServer, async () => {
    const hits = await embeddings.search(corpus, 'kitten', GEMINI);
    assert.equal(hits[0].doc, b.chunks[0]);
  });
  const huge = { chunks: Array.from({ length: embeddings.TOPIC_CHUNK_CAP + 1 }, () => ({ text: 'x' })), entries: [] };
  await assert.rejects(embeddings.search(huge, 'x', GEMINI), /more than the/);
});

test('embeddings: the key is only sent to the chat endpoint unless one is set for embeddings', () => {
  assert.equal(embeddings.config(LOCAL).key, '');
  assert.equal(embeddings.config({ ...LOCAL, embedApiKey: 'local-key' }).key, 'local-key');
  assert.equal(embeddings.config(GEMINI).key, 'chat-key');
});

test('embeddings: a similarity floor keeps an unrelated question from adding passages', async () => {
  const e = article(PASSAGES);
  await withServer(geminiServer, async () => {
    assert.equal(embeddings.config(GEMINI).minScore, 0.55, 'the measured default for gemini-embedding-001');
    assert.deepEqual(await embeddings.search(e, 'zebra', GEMINI), [], 'a question with no concept scores about 0.5 against everything');
    assert.ok((await embeddings.search(e, 'zebra', { ...GEMINI, embedMinScore: -1 })).length > 0, '-1 turns the floor off');
  });
  assert.equal(embeddings.config(LOCAL).minScore, -1, 'no floor for a model nobody has calibrated');
  assert.equal(embeddings.config({ ...LOCAL, embedMinScore: 0.4 }).minScore, 0.4);
});
