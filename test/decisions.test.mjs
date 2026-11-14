// Tests for section ranking with a fake Decisions API: node --test test/decisions.test.mjs (or npm test).
// The fake rates a section 3 when it shares a concept with the reader's question and 0 otherwise, so a question can
// match a section that shares no word with it, which is what keyword search can't do.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../lib/agent.js';
import { appSettings } from '../lib/settings.js';
import { bm25 } from '../lib/bm25.js';
import { decisions } from '../lib/decisions.js';

const CONCEPTS = [
  ['sky', 'heavens', 'azure', 'sunlight', 'atmosphere', 'scattering'],
  ['money', 'bank', 'loan', 'coins', 'treasury'],
  ['cat', 'feline', 'kitten', 'whiskers'],
];
const concepts = (text) => CONCEPTS.map((words) => words.some((w) => text.toLowerCase().split(/\W+/).includes(w)));
const server = (url, body) => {
  const asked = concepts(body.input);
  const answers = {};
  for (const [key, q] of Object.entries(body.questions)) {
    const score = concepts(q.instructions).some((has, i) => has && asked[i]) ? 3 : 0;
    answers[key] = { type: 'score', score, confidence: 0.9, probabilities: {} };
  }
  return { answers, usage: { total_input_tokens: 1234, total_output_tokens: 0 } };
};

// Replaces fetch for the duration of fn; `handler(url, body, headers)` returns the JSON to answer with, or a Response.
async function withServer(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, headers: init.headers });
    const out = await handler(String(url), body, init);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

const ON = { ...appSettings.DEFAULTS, apiKey: 'chat-key', sectionRanking: true };

beforeEach(() => {
  decisions.forget();
  decisions.timing.timeoutMs = 2500;
});

let n = 0;
function article(texts) {
  const title = `Article ${++n}`;
  const chunks = texts.map((text, i) => ({ lang: 'en', page: title, section: `S${i}`, text }));
  return { page: { lang: 'en', title, revid: 1 }, chunks, index: new bm25.BM25(chunks, (c) => `${c.section} ${c.text}`) };
}
const PASSAGES = [
  'Rayleigh scattering of sunlight in the atmosphere gives the daytime its colour.',
  'The treasury issued coins and the bank gave a loan.',
  'A kitten is a young feline with whiskers.',
];

test('off by default, and only on the Gemini API with a key', () => {
  assert.equal(decisions.available(appSettings.DEFAULTS), false);
  assert.equal(decisions.available(ON), true);
  assert.equal(decisions.available({ ...ON, apiKey: '' }), false);
  assert.equal(decisions.available({ ...ON, baseUrl: 'http://localhost:11434/v1' }), false);
});

test('one call rates every section and finds the one keywords miss', async () => {
  const e = article(PASSAGES);
  const q = 'why are the heavens azure';
  const keyword = e.index.search(q, 40);
  assert.equal(keyword.length, 0);
  await withServer(server, async (calls) => {
    const out = await decisions.retrieve(e, q, keyword, ON);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/decisions');
    assert.equal(calls[0].headers['x-goog-api-key'], 'chat-key');
    assert.equal(calls[0].body.model, 'gemini-decision-1');
    assert.match(calls[0].body.input, /asks: "why are the heavens azure"/);
    assert.deepEqual(Object.keys(calls[0].body.questions), ['s0', 's1', 's2']);
    assert.equal(calls[0].body.questions.s0.criteria.length, 4);
    assert.equal(out.length, 1);
    assert.match(out[0].doc.text, /Rayleigh/);
    assert.equal(out.sections, 1);
    assert.equal(out.tokens, 1234);
  });
});

test('no section related enough: empty, so the caller uses keywords', async () => {
  const e = article(PASSAGES);
  await withServer(server, async () => {
    const out = await decisions.retrieve(e, 'who won the world cup', [], ON);
    assert.equal(out.length, 0);
  });
});

test('the best keyword match is kept even when its section is not picked', async () => {
  const e = article(PASSAGES);
  const q = 'heavens azure, and the loan';
  const keyword = e.index.search(q, 40);
  await withServer(server, async () => {
    const out = await decisions.retrieve(e, q, keyword, { ...ON });
    assert.ok(out.some((h) => /Rayleigh/.test(h.doc.text)));
    assert.ok(out.some((h) => /loan/.test(h.doc.text)));
  });
});

test('switched off or on another provider: null and no request', async () => {
  const e = article(PASSAGES);
  await withServer(server, async (calls) => {
    assert.equal(await decisions.retrieve(e, 'heavens', [], { ...ON, sectionRanking: false }), null);
    assert.equal(await decisions.retrieve(e, 'heavens', [], { ...ON, baseUrl: 'https://example.com/v1' }), null);
    assert.equal(calls.length, 0);
  });
});

test('a failed call throws, and nothing is sent for the next minute', async () => {
  const e = article(PASSAGES);
  const busy = () => new Response(JSON.stringify({ error: { code: 429, message: 'Quota exceeded' } }), { status: 429 });
  await withServer(busy, async (calls) => {
    await assert.rejects(decisions.retrieve(e, 'heavens', [], ON), /HTTP 429: Quota exceeded/);
    await assert.rejects(decisions.retrieve(e, 'heavens', [], ON), /failed less than a minute ago/);
    assert.equal(calls.length, 1);
  });
});

test('a slow reply is given up on', async () => {
  const e = article(PASSAGES);
  decisions.timing.timeoutMs = 30;
  const slow = (url, body, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  await withServer(slow, async () => {
    await assert.rejects(decisions.retrieve(e, 'heavens', [], ON), /no reply within 30 ms/);
  });
});

test('too many sections for one call, or too many tokens this minute: refused before any request', async () => {
  const big = article(Array.from({ length: 400 }, (_, i) => `Section ${i} about coins. ${'word '.repeat(80)}`));
  const counting = (url, body) => ({ ...server(url, body), usage: { total_input_tokens: 17_000 } }); // what 60 such sections cost
  await withServer(counting, async (calls) => {
    await assert.rejects(decisions.retrieve(big, 'coins', [], ON), (err) => err.soft === 'size');
    assert.equal(calls.length, 0);
    // Not a failure: other articles are still ranked.
    const mid = article(Array.from({ length: 60 }, (_, i) => `Section ${i} about coins. ${'word '.repeat(80)}`));
    let sent = 0;
    await assert.rejects(async () => {
      for (; sent < 20; sent++) await decisions.retrieve(mid, 'coins', [], ON);
    }, (err) => err.soft === 'pace');
    assert.ok(sent >= 1 && calls.length === sent);
  });
});

test('agent: search_article uses section ranking, and falls back to keywords when the call fails', async () => {
  const run = (e) => {
    const r = new agent.Run({ settings: ON, page: { lang: 'en', title: e.page.title, links: [] }, question: 'q', emit: () => {} });
    Object.assign(r, { current: e, toolTokens: 0, systemBase: '' });
    return r;
  };
  const e = article(PASSAGES);
  await withServer(server, async () => {
    const r = run(e);
    assert.match(await r.tool('search_article', { query: 'heavens azure' }), /Rayleigh scattering/);
    assert.ok(r.trace.notes.some((x) => /^section ranking \(gemini-decision-1, \d+ ms, 1234 tokens\): 1 sections → 1 passages/.test(x)), r.trace.notes.join('\n'));
  });
  decisions.forget();
  await withServer(() => new Response('nope', { status: 500 }), async () => {
    const r = run(e);
    assert.match(await r.tool('search_article', { query: 'kitten whiskers' }), /young feline/);
    assert.ok(r.trace.notes.some((x) => /^section ranking not used: HTTP 500/.test(x)), r.trace.notes.join('\n'));
  });
});
