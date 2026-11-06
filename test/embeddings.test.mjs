// Tests for semantic search with a fake embedding server: node --test test/embeddings.test.mjs (or npm test).
// The fake "embeds" a text as counts of words from four concept groups, so a question can match a section
// that shares no word with it, which is what keyword search can't do.
import test, { beforeEach } from 'node:test';
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

const textOf = (r) => r.content.parts[0].text;
const geminiServer = (url, body) => ({ embeddings: body.requests.map((r) => ({ values: vec(textOf(r)) })) });
const openaiServer = (url, body) => ({ data: body.input.map((t, index) => ({ index, embedding: vec(t) })).reverse() }); // out of order on purpose

const AUTO = { ...appSettings.DEFAULTS, apiKey: 'chat-key', semanticSearch: true }; // Gemini, both embedding models
const ONE = { ...AUTO, embedModel: 'gemini-embedding-001' };
const V2 = { ...AUTO, embedModel: 'gemini-embedding-2' };
const LOCAL = { ...AUTO, embedBaseUrl: 'http://localhost:11434/v1', embedModel: 'nomic-embed-text' };

beforeEach(async () => {
  await embeddings.resetBudget();
  embeddings.forget();
});

let n = 0;
/** An article with one section per text (so one unit each), or with sections given as [path, text] pairs. */
function article(texts, sections) {
  const title = `Article ${++n}`;
  const chunks = texts.map((text, i) => ({ lang: 'en', page: title, section: sections?.[i] ?? `S${i}`, text }));
  return { page: { lang: 'en', title, revid: 1 }, chunks, index: new bm25.BM25(chunks, (c) => `${c.section} ${c.text}`) };
}

const PASSAGES = [
  'Rayleigh scattering of sunlight in the atmosphere gives the daytime its colour.',
  'The treasury issued coins and the bank gave out a loan.',
  'The kitten and the feline in the garden.',
  'The army fought a battle and soldiers died.',
];

test('embeddings: configs, limits and floors', () => {
  assert.deepEqual(embeddings.configs({ ...AUTO, semanticSearch: false }), []);
  assert.deepEqual(embeddings.configs({ ...appSettings.DEFAULTS, semanticSearch: true, provider: 'custom', baseUrl: 'http://localhost:8080/v1' }), [], 'a local server needs a model name');
  const both = embeddings.configs(AUTO);
  assert.deepEqual(both.map((c) => c.model), ['gemini-embedding-001', 'gemini-embedding-2'], 'Gemini: both models, each with its own quota');
  assert.deepEqual(both.map((c) => c.limit), [1000, 1000]);
  assert.deepEqual(both.map((c) => c.minScore), [0.55, 0.62], 'a floor per Gemini model, from the measured scores');
  assert.deepEqual(embeddings.configs(ONE).map((c) => c.model), ['gemini-embedding-001']);
  assert.equal(embeddings.configs({ ...AUTO, embedDailyLimit: -1 })[0].limit, Infinity);
  assert.equal(embeddings.configs({ ...AUTO, embedDailyLimit: 300 })[0].limit, 300);
  assert.equal(embeddings.configs(LOCAL)[0].limit, Infinity, 'no daily cap for a local model');
  assert.equal(embeddings.configs(LOCAL)[0].minScore, -1);
  assert.equal(embeddings.configs({ ...LOCAL, embedMinScore: 0.4 })[0].minScore, 0.4);
  assert.equal(embeddings.configs(LOCAL)[0].key, '', 'the chat key stays with the chat endpoint');
  assert.equal(embeddings.configs({ ...LOCAL, embedApiKey: 'local-key' })[0].key, 'local-key');
  assert.equal(embeddings.configs(AUTO)[0].key, 'chat-key');
});

test('embeddings: gemini-embedding-001 requests use the native batch endpoint with task types and the chat key', async () => {
  const e = article(PASSAGES);
  await withServer(geminiServer, async (calls) => {
    await embeddings.search(e, 'heavens azure', ONE);
    const [docs, query] = calls;
    assert.equal(docs.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents');
    assert.equal(docs.headers['x-goog-api-key'], 'chat-key');
    assert.equal(docs.body.requests.length, 4, 'one text per section');
    assert.equal(docs.body.requests[0].taskType, 'RETRIEVAL_DOCUMENT');
    assert.equal(docs.body.requests[0].outputDimensionality, 768);
    assert.ok(textOf(docs.body.requests[0]).startsWith(`${e.page.title} — S0\n`), 'a section carries its article and heading');
    assert.equal(query.body.requests[0].taskType, 'RETRIEVAL_QUERY');
  });
});

test('embeddings: gemini-embedding-2 has no task type; the task is part of the text', async () => {
  const e = article(PASSAGES);
  await withServer(geminiServer, async (calls) => {
    await embeddings.search(e, 'heavens azure', V2);
    const [docs, query] = calls;
    assert.equal(docs.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents');
    assert.equal(docs.body.requests[0].taskType, undefined);
    assert.equal(docs.body.requests[0].outputDimensionality, 768);
    assert.ok(textOf(docs.body.requests[0]).startsWith(`title: ${e.page.title} — S0 | text: Rayleigh`));
    assert.equal(textOf(query.body.requests[0]), 'task: search result | query: heavens azure');
  });
});

test('embeddings: a local OpenAI-compatible server gets prefixes and not the chat key', async () => {
  const e = article(PASSAGES);
  const settings = { ...LOCAL, embedDocPrefix: 'search_document: ', embedQueryPrefix: 'search_query: ' };
  await withServer(openaiServer, async (calls) => {
    const hits = await embeddings.search(e, 'heavens azure', settings);
    assert.equal(calls[0].url, 'http://localhost:11434/v1/embeddings');
    assert.equal(calls[0].headers.Authorization, undefined);
    assert.ok(calls.find((c) => c.body.input.length === 4).body.input.every((t) => t.startsWith('search_document: ')));
    assert.ok(calls.find((c) => c.body.input.length === 1).body.input[0].startsWith('search_query: heavens'));
    assert.equal(hits[0].doc.members[0], e.chunks[0], 'results came back out of order and are matched by index');
  });
});

test('embeddings: finds a section that shares no word with the question, and an unrelated question finds none', async () => {
  const e = article(PASSAGES);
  assert.equal(e.index.search('heavens azure', 4).length, 0, 'keyword search finds nothing');
  await withServer(geminiServer, async () => {
    const hits = await embeddings.search(e, 'heavens azure', ONE);
    assert.deepEqual(hits.map((h) => h.doc.members[0]), [e.chunks[0]]);
    assert.equal((await embeddings.search(e, 'zebra', ONE)).length, 0, 'a question with no concept scores about 0.5: under the floor');
    assert.ok((await embeddings.search(e, 'zebra', { ...ONE, embedMinScore: -1 })).length > 0, '-1 turns the floor off');
  });
});

test('embeddings: sections of only image descriptions are skipped, and a very long outline is embedded by top-level section', async () => {
  const figures = article(['Figure: a photo of the sky', 'The kitten and the feline.'], ['Gallery', 'Pets']);
  await withServer(geminiServer, async (calls) => {
    await embeddings.search(figures, 'kitten', ONE);
    assert.equal(calls[0].body.requests.length, 1, 'only the Pets section is embedded');
  });
  const texts = Array.from({ length: 70 }, (_, i) => `Passage ${i} about the sky and the atmosphere.`);
  const long = article(texts, texts.map((t, i) => `Part ${i % 7} › Sub ${i}`));
  await withServer(geminiServer, async (calls) => {
    await embeddings.search(long, 'sky', ONE);
    assert.equal(calls[0].body.requests.length, 7, '70 sections become the 7 top-level ones');
    assert.match(textOf(calls[0].body.requests[0]), /Includes: Sub 0, Sub 7/);
  });
});

test('embeddings: vectors are kept, so a second question embeds only the question', async () => {
  const e = article(PASSAGES);
  await withServer(geminiServer, async (calls) => {
    await embeddings.search(e, 'heavens azure', ONE);
    const first = calls.length;
    await embeddings.search(e, 'loan from the bank', ONE);
    assert.equal(calls.length, first + 1);
    assert.equal(calls.at(-1).body.requests.length, 1);
    const again = { page: e.page, chunks: e.chunks.map((c) => ({ ...c })), index: e.index }; // e.g. after the service worker restarted
    await embeddings.search(again, 'loan from the bank', ONE);
    assert.equal(calls.length, first + 1, 'the question was remembered too');
  });
});

test('embeddings: retrieve gives the passages of the best sections, best keyword match first, and keeps an exact match elsewhere', async () => {
  const texts = ['Rayleigh sunlight scattering.', 'Blue sky near the horizon.', 'The atmosphere is thin here.', 'The treasury and the bank.'];
  const e = article(texts, ['Sky', 'Sky', 'Sky', 'Money']);
  await withServer(geminiServer, async () => {
    const keyword = e.index.search('heavens atmosphere', 40);
    const out = await embeddings.retrieve(e, 'heavens atmosphere', keyword, ONE);
    assert.deepEqual(out.map((h) => h.doc.text), ['The atmosphere is thin here.', 'Rayleigh sunlight scattering.'], 'two passages of the Sky section, the one with the question\'s word first');
    const elsewhere = [{ doc: e.chunks[3], score: 9 }];
    const guarded = await embeddings.retrieve(e, 'heavens atmosphere', elsewhere, ONE);
    assert.equal(guarded[2].doc, e.chunks[3], 'the best keyword match is kept even though its section wasn\'t picked');
    assert.equal((await embeddings.retrieve(e, 'zebra', keyword, ONE)).length, 0, 'nothing related: empty, so the caller uses keywords');
    assert.equal(await embeddings.retrieve(e, 'x', keyword, { ...ONE, semanticSearch: false }), null);
  });
});

test('embeddings: reciprocal rank fusion puts items both lists like on top', () => {
  const [a, b, c] = ['a', 'b', 'c'].map((text) => ({ text }));
  const fused = embeddings.fuse([[{ doc: a }, { doc: b }], [{ doc: c }, { doc: b }]], 3);
  assert.equal(fused[0].doc, b);
});

test('embeddings: each model has its own daily budget, and new articles stop at 85% of it', async () => {
  const settings = { ...AUTO, embedDailyLimit: 10 }; // 8.5 for new articles; an article of 4 sections costs 4 + 1 per question
  const [a, b, c] = [article(PASSAGES), article(PASSAGES), article(PASSAGES)];
  await withServer(geminiServer, async (calls) => {
    await embeddings.search(a, 'heavens azure', settings);
    await embeddings.search(b, 'heavens azure', settings);
    const models = calls.map((x) => x.url.match(/models\/([^:]+)/)[1]);
    assert.deepEqual([...new Set(models.slice(0, 2))], ['gemini-embedding-001']);
    assert.ok(models.includes('gemini-embedding-2'), 'the second article didn\'t fit 001\'s share, so it went to the other model');
    await assert.rejects(embeddings.search(c, 'heavens azure', settings), (e) => e.soft === 'budget');
    const hits = await embeddings.search(a, 'loan', settings); // an embedded article keeps working: its question fits the rest of the budget
    assert.ok(Array.isArray(hits));
  });
  const usage = await embeddings.usage(settings);
  assert.deepEqual(usage.map((u) => u.model), ['gemini-embedding-001', 'gemini-embedding-2']);
  assert.ok(usage.every((u) => u.used > 0 && u.limit === 10));
});

test('embeddings: a question needs budget too, and an article keeps the model it was embedded with', async () => {
  const e = article(PASSAGES);
  await withServer(geminiServer, async (calls) => {
    await embeddings.search(e, 'heavens azure', { ...V2, embedDailyLimit: 5 }); // 4 sections + 1 question = 5
    await assert.rejects(embeddings.search(e, 'loan', { ...V2, embedDailyLimit: 5 }), (err) => err.soft === 'budget', 'a second question has no request left');
    calls.length = 0;
    await embeddings.search(e, 'loan', AUTO); // 001 is listed first and has budget, but this article's vectors are 2's
    assert.match(calls[0].url, /gemini-embedding-2/);
    assert.equal(calls.length, 1, 'only the question: the sections were not embedded again');
  });
});

test('embeddings: a rate limit is waited out for as long as the server says, and the batch is not lost', async () => {
  const e = article(PASSAGES);
  embeddings.timing.scale = 0.001;
  let limited = 0;
  try {
    await withServer((url, body) => {
      if (body.requests[0].taskType === 'RETRIEVAL_DOCUMENT' && limited++ < 2) return new Response(JSON.stringify({ error: { message: 'Quota exceeded. Please retry in 28.9s.' } }), { status: 429 });
      return geminiServer(url, body);
    }, async (calls) => {
      const hits = await embeddings.search(e, 'heavens azure', ONE);
      assert.equal(hits[0].doc.members[0], e.chunks[0]);
      assert.equal(calls.filter((c) => c.body.requests[0].taskType === 'RETRIEVAL_DOCUMENT').length, 3, 'two refusals, then it went through');
    });
  } finally {
    embeddings.timing.scale = 1;
  }
});

test('embeddings: sections still being embedded give a "not ready" error, and the job finishes in the background', async () => {
  const e = article(PASSAGES);
  embeddings.timing.scale = 0.001;
  embeddings.timing.waitMs = 30;
  let refuse = true;
  try {
    await withServer((url, body) => (refuse && body.requests[0].taskType === 'RETRIEVAL_DOCUMENT' ? new Response(JSON.stringify({ error: { message: 'Please retry in 40s.' } }), { status: 429 }) : geminiServer(url, body)), async (calls) => {
      await assert.rejects(embeddings.search(e, 'heavens azure', ONE), (err) => err.soft === 'pending' && /still embedding .* 0 of 4 sections/.test(err.message));
      assert.ok(!calls.some((c) => c.body.requests[0].taskType === 'RETRIEVAL_QUERY'), 'no request is spent on the question yet');
      refuse = false;
      await new Promise((r) => setTimeout(r, 120)); // the background job's next try (41 s × 0.001)
      const hits = await embeddings.search(e, 'heavens azure', ONE);
      assert.equal(hits[0].doc.members[0], e.chunks[0]);
    });
  } finally {
    embeddings.timing.scale = 1;
    embeddings.timing.waitMs = 6000;
  }
});

test('embeddings: a topic is assembled from its articles with one model, and an oversized one is refused', async () => {
  const a = article(PASSAGES.slice(0, 2));
  const b = article(PASSAGES.slice(2));
  const corpus = { chunks: [...a.chunks, ...b.chunks], entries: [a, b], index: new bm25.BM25([], () => '') };
  await withServer(geminiServer, async (calls) => {
    const hits = await embeddings.search(corpus, 'kitten', ONE);
    assert.equal(hits[0].doc.members[0], b.chunks[0]);
    assert.equal(new Set(calls.map((c) => c.url)).size, 1);
  });
  const many = Array.from({ length: 7 }, () => article(Array.from({ length: 60 }, (_, i) => `Passage ${i} about the sky.`)));
  const huge = { chunks: many.flatMap((x) => x.chunks), entries: many };
  await assert.rejects(embeddings.search(huge, 'x', ONE), (e) => e.soft === 'size' && /more than the 400/.test(e.message));
});

test('embeddings: a Gemini 404 names the embedding models the key can use', async () => {
  const e = article(PASSAGES);
  const real = globalThis.fetch;
  globalThis.fetch = async (url) =>
    String(url).includes('/models?')
      ? new Response(JSON.stringify({ models: [{ name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] }, { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-embedding-2', supportedGenerationMethods: ['embedContent'] }] }), { status: 200 })
      : new Response(JSON.stringify({ error: { message: 'models/gemini-embedding-002 is not found' } }), { status: 404 });
  try {
    await assert.rejects(embeddings.search(e, 'x', { ...AUTO, embedModel: 'gemini-embedding-002' }), /404: models\/gemini-embedding-002 is not found.*gemini-embedding-001, gemini-embedding-2\./);
  } finally {
    globalThis.fetch = real;
  }
});

test('embeddings: the settings test asks each model once', async () => {
  await withServer(geminiServer, async (calls) => {
    const results = await embeddings.test(AUTO);
    assert.deepEqual(results.map((r) => r.model), ['gemini-embedding-001', 'gemini-embedding-2']);
    assert.ok(results.every((r) => r.dims === 4));
    assert.equal(calls.length, 2);
  });
});

// ---------- In the agent ----------

const gemini = (settings) => ({ ...settings, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'm' });
function runFor(e, settings, steps = []) {
  const r = new agent.Run({ settings: gemini(settings), page: { lang: 'en', title: e.page.title, links: [] }, question: 'q', emit: (x) => steps.push(x.text) });
  r.current = e;
  r.toolTokens = 0;
  r.systemBase = '';
  return r;
}

test('agent: with semantic search on, search_article finds the passage keywords miss', async () => {
  const e = article(PASSAGES);
  const r = runFor(e, ONE);
  await withServer(geminiServer, async () => {
    const out = await r.tool('search_article', { query: 'heavens azure' });
    assert.match(out, /Rayleigh scattering/);
    assert.ok(r.trace.notes.some((x) => /semantic \(gemini-embedding-001, embedded just now\): 1 sections → [12] passages/.test(x)));
    await r.tool('search_article', { query: 'loan from the bank' });
    assert.ok(r.trace.notes.some((x) => /semantic \(gemini-embedding-001, stored vectors\): 1 sections/.test(x)), 'the second question used what the first one stored');
  });
});

test('agent: with semantic search off, nothing is sent anywhere', async () => {
  const e = article(PASSAGES);
  const r = runFor(e, { ...ONE, semanticSearch: false });
  await withServer(geminiServer, async (calls) => {
    const hits = await r.retrieve(e, 'sunlight atmosphere', 3);
    assert.equal(calls.length, 0);
    assert.equal(hits[0].doc, e.chunks[0]);
  });
});

test('agent: an unrelated question falls back to the keyword results', async () => {
  const e = article(PASSAGES);
  const r = runFor(e, ONE);
  await withServer(geminiServer, async () => {
    const hits = await r.retrieve(e, 'zebra daytime', 3);
    assert.equal(hits[0].doc, e.chunks[0], 'the keyword match, since no section was related enough');
    assert.ok(r.trace.notes.some((x) => /no section related enough/.test(x)));
  });
});

test('agent: a failing embedding service falls back to keywords, says so once, and is not retried at once', async () => {
  const e = article(PASSAGES);
  const steps = [];
  const r = runFor(e, ONE, steps);
  await withServer(() => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 }), async (calls) => {
    const hits = await r.retrieve(e, 'sunlight atmosphere', 3);
    assert.equal(hits[0].doc, e.chunks[0], 'keyword results are still returned');
    const sent = calls.length;
    await r.retrieve(e, 'bank loan', 3);
    assert.equal(calls.length, sent, 'nothing is sent again within the minute');
  });
  assert.equal(steps.filter((s) => /Semantic search unavailable/.test(s)).length, 1);
  assert.ok(r.trace.notes.some((x) => /API key not valid/.test(x)));
});

test('agent: not an error while sections are still being embedded or the day\'s budget is used up', async () => {
  const e = article(PASSAGES);
  const steps = [];
  const r = runFor(e, ONE, steps);
  embeddings.timing.scale = 0.001;
  embeddings.timing.waitMs = 20;
  try {
    await withServer(() => new Response(JSON.stringify({ error: { message: 'Please retry in 60s.' } }), { status: 429 }), async () => {
      assert.equal((await r.retrieve(e, 'sunlight atmosphere', 3))[0].doc, e.chunks[0]);
      await r.retrieve(e, 'bank loan', 3);
    });
  } finally {
    embeddings.timing.scale = 1;
    embeddings.timing.waitMs = 6000;
  }
  assert.equal(steps.filter((s) => /still building in the background/.test(s)).length, 1);
  assert.ok(r.trace.notes.some((x) => /not used \(pending\).*of 4 sections/.test(x)));
  // A budget of 1 per model that is already spent
  const spent = article(PASSAGES);
  const steps2 = [];
  const r2 = runFor(spent, { ...AUTO, embedDailyLimit: 1 }, steps2);
  await withServer(geminiServer, async () => {
    assert.equal((await r2.retrieve(spent, 'sunlight atmosphere', 3))[0].doc, spent.chunks[0]);
  });
  assert.equal(steps2.filter((s) => /budget is used up/.test(s)).length, 1);
  assert.ok(!steps.concat(steps2).some((s) => /unavailable/.test(s)), 'neither is reported as a failure');
});
