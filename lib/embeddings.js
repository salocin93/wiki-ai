// Semantic search (experimental): passages are embedded and ranked by cosine similarity, then fused with BM25.
// Two backends: Gemini's native batchEmbedContents (task types, 768 dimensions) and any OpenAI-compatible
// /embeddings endpoint (Ollama, LM Studio, llama.cpp, vLLM). Anything that goes wrong throws, and the caller
// falls back to keyword search, so a missing model or a rate limit never breaks an answer.
import { appSettings } from './settings.js';
import { cache } from './cache.js';

const GEMINI_MODEL = 'gemini-embedding-001';
const GEMINI_DIMS = 768; // the model's default is 3072; 768 loses little and is 4× smaller to store
const MAX_TEXT_CHARS = 2000; // a ~160-word passage is about 1,000
const BATCH = { gemini: 100, openai: 32 }; // Gemini's limit per call; local servers are happier with fewer
const TOPIC_CHUNK_CAP = 600; // ~150k tokens: beyond this, embedding a whole topic is too slow for a free quota
const RETRY_WAITS = [5, 15, 30]; // seconds, after "too many requests"
const FAIL_BACKOFF_MS = 60_000; // after a failure, keyword search only for this long instead of retrying every call
const QUERY_MEMO = 50;
const MARGIN = 0.12; // semantic hits more than this below the best one are dropped (cosines of one question sit close together)
// Below this a passage isn't related at all. Measured on gemini-embedding-001 (768 dimensions): unrelated questions top
// out at 0.47–0.50, vague but related ones start at 0.58. Other models score on other scales, so they get no floor
// until one is set in the settings (test/semantic-check.mjs prints the scores to calibrate with).
const GEMINI_MIN_SCORE = 0.55;

class EmbedError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason || new Error('Aborted'));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(undefined);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Where embeddings come from, or null when the feature is off or not set up.
 * An empty embedding endpoint means the chat endpoint (Gemini by default); the chat key is only sent there.
 * @param {Partial<Settings>} settings
 */
function config(settings) {
  if (!settings?.semanticSearch) return null;
  const baseUrl = (settings.embedBaseUrl || settings.baseUrl || '').trim().replace(/\/$/, '');
  if (!baseUrl) return null;
  const gemini = appSettings.isGemini({ baseUrl });
  const model = (settings.embedModel || '').trim() || (gemini ? GEMINI_MODEL : '');
  if (!model) return null;
  const host = hostOf(baseUrl);
  const key = (settings.embedApiKey || '').trim() || (host && host === hostOf(settings.baseUrl || '') ? settings.apiKey || '' : '');
  const docPrefix = settings.embedDocPrefix || '';
  const queryPrefix = settings.embedQueryPrefix || '';
  const set = Number(settings.embedMinScore) || 0;
  const minScore = set === 0 ? (gemini && model === GEMINI_MODEL ? GEMINI_MIN_SCORE : -1) : set;
  return { baseUrl, gemini, model, key, docPrefix, queryPrefix, minScore, id: [gemini ? 'gemini' : 'openai', host, model, docPrefix].join('|') };
}

async function postJson(url, headers, body, signal) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
    });
    if (res.ok) return res.json();
    const text = await res.text().catch(() => '');
    // A used-up daily quota won't come back by waiting.
    if ((res.status === 429 || res.status === 503) && attempt < RETRY_WAITS.length && !/per ?day|PerDay|daily/i.test(text)) {
      await sleep(RETRY_WAITS[attempt] * 1000, signal);
      continue;
    }
    let message = text;
    try {
      message = JSON.parse(text).error?.message || text;
    } catch {
      // not JSON: use the body as it is
    }
    throw new EmbedError(res.status, `${res.status}: ${message.slice(0, 300) || res.statusText}`);
  }
}

/** One request of at most BATCH texts → one vector each (not yet normalised). */
async function embedBatch(cfg, texts, kind, signal) {
  const problem = appSettings.endpointProblem(cfg.baseUrl);
  if (problem) throw new EmbedError(0, problem);
  const prefix = kind === 'query' ? cfg.queryPrefix : cfg.docPrefix;
  const inputs = texts.map((t) => prefix + t.slice(0, MAX_TEXT_CHARS));
  if (cfg.gemini) {
    const root = cfg.baseUrl.replace(/\/openai$/, ''); // …/v1beta/openai → …/v1beta
    const extra = { taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT', outputDimensionality: GEMINI_DIMS };
    const data = await postJson(
      `${root}/models/${cfg.model}:batchEmbedContents`,
      { 'x-goog-api-key': cfg.key },
      { requests: inputs.map((text) => ({ model: `models/${cfg.model}`, content: { parts: [{ text }] }, ...extra })) },
      signal
    );
    const out = (data.embeddings || []).map((e) => e.values);
    if (out.length !== texts.length || out.some((v) => !v?.length)) throw new EmbedError(0, 'Gemini returned a different number of embeddings than texts sent.');
    return out;
  }
  const data = await postJson(`${cfg.baseUrl}/embeddings`, cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}, { model: cfg.model, input: inputs }, signal);
  const out = (data.data || []).slice().sort((a, b) => a.index - b.index).map((d) => d.embedding);
  if (out.length !== texts.length || out.some((v) => !v?.length)) throw new EmbedError(0, 'The server returned a different number of embeddings than texts sent.');
  return out;
}

/** Unit-length vectors packed in one array, so a dot product is the cosine. */
function pack(vectors) {
  const dims = vectors[0]?.length || 0;
  const flat = new Float32Array(vectors.length * dims);
  vectors.forEach((v, i) => {
    if (v.length !== dims) throw new EmbedError(0, 'The model returned vectors of different sizes.');
    let norm = 0;
    for (let d = 0; d < dims; d++) norm += v[d] * v[d];
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dims; d++) flat[i * dims + d] = v[d] / norm;
  });
  return flat;
}

async function embedTexts(cfg, texts, kind, signal) {
  const vectors = [];
  const size = cfg.gemini ? BATCH.gemini : BATCH.openai;
  for (let i = 0; i < texts.length; i += size) vectors.push(...(await embedBatch(cfg, texts.slice(i, i + size), kind, signal)));
  return pack(vectors);
}

const chunkText = (c) => `${c.page} — ${c.section}\n${c.text}`;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

/**
 * The passages' vectors, in chunk order. Persisted in the article cache, keyed by model, revision and content, so
 * a service-worker restart or a second question costs nothing. `entry` is an indexed article ({page, chunks}) or a
 * topic corpus ({chunks, entries}).
 * @returns {Promise<Float32Array>}
 */
async function vectorsFor(entry, cfg, signal, onStart) {
  if (entry.entries) {
    if (entry.chunks.length > TOPIC_CHUNK_CAP) throw new EmbedError(0, `the topic has ${entry.chunks.length} passages, more than the ${TOPIC_CHUNK_CAP} embedded in this prototype`);
    const parts = await mapLimit(entry.entries, 4, (e) => vectorsFor(e, cfg, signal, onStart));
    const flat = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      flat.set(p, at);
      at += p.length;
    }
    return flat;
  }
  const known = entry.vecs;
  if (known && known.id === cfg.id && (!known.failedAt || Date.now() - known.failedAt < FAIL_BACKOFF_MS)) return known.promise;
  const chars = entry.chunks.reduce((n, c) => n + c.text.length, 0);
  const key = `emb:${cfg.id}:${entry.page.lang}:${entry.page.title}:${entry.page.revid || 0}:${entry.chunks.length}.${chars}`;
  const memo = { id: cfg.id, promise: null, failedAt: 0 };
  memo.promise = cache.wrap(key, async () => {
    onStart?.();
    return embedTexts(cfg, entry.chunks.map(chunkText), 'doc', signal);
  });
  entry.vecs = memo;
  memo.promise.catch(() => {
    if (signal?.aborted) entry.vecs = null; // the reader stopped it: not a failure to remember
    else memo.failedAt = Date.now();
  });
  return memo.promise;
}

const queryMemo = new Map();
async function queryVector(cfg, query, signal) {
  const key = `${cfg.id}|${query}`;
  if (queryMemo.has(key)) return queryMemo.get(key);
  const v = await embedTexts(cfg, [query], 'query', signal);
  queryMemo.set(key, v);
  if (queryMemo.size > QUERY_MEMO) queryMemo.delete(queryMemo.keys().next().value);
  return v;
}

/**
 * Passages ranked by meaning, best first, as {doc, score} like BM25.search. Returns null when semantic search is
 * off or not set up; throws when the embedding service fails.
 * @param {{chunks: Chunk[], page?: any, entries?: any[]}} entry
 * @param {string} query
 * @param {Partial<Settings>} settings
 * @param {{ signal?: AbortSignal, k?: number, onStart?: () => void }} [opts]
 */
async function search(entry, query, settings, { signal, k = 20, onStart } = {}) {
  const cfg = config(settings);
  if (!cfg || !entry.chunks.length) return null;
  const [vecs, q] = await Promise.all([vectorsFor(entry, cfg, signal, onStart), queryVector(cfg, query, signal)]);
  const dims = q.length;
  if (vecs.length !== entry.chunks.length * dims) throw new EmbedError(0, 'The stored vectors and the question have different sizes (was the model changed?).');
  const scored = entry.chunks.map((doc, i) => {
    let dot = 0;
    for (let d = 0; d < dims; d++) dot += vecs[i * dims + d] * q[d];
    return { doc, score: dot };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, k);
  return top.filter((h) => h.score >= cfg.minScore && h.score >= top[0].score - MARGIN);
}

/**
 * Reciprocal rank fusion: a passage ranked high by either list rises, one ranked high by both rises most.
 * Needs no score calibration between BM25 and cosine, which is why it's the default hybrid.
 * @param {{doc: Chunk, score: number}[][]} lists best first
 */
function fuse(lists, k, c = 60) {
  const total = new Map();
  for (const list of lists) list.forEach((h, rank) => total.set(h.doc, (total.get(h.doc) || 0) + 1 / (c + rank + 1)));
  return [...total].map(([doc, score]) => ({ doc, score })).sort((a, b) => b.score - a.score).slice(0, k);
}

/** Checks the settings with one real request, for the settings page. Returns the vector size. */
async function test(settings, signal) {
  const cfg = config({ ...settings, semanticSearch: true });
  if (!cfg) throw new EmbedError(0, 'Set an embedding model (or use a Gemini endpoint).');
  const v = await embedTexts(cfg, ['Rayleigh scattering makes the sky blue.'], 'doc', signal);
  return { model: cfg.model, dims: v.length };
}

const forget = () => queryMemo.clear();

export const embeddings = { config, search, fuse, test, forget, GEMINI_MODEL, TOPIC_CHUNK_CAP };
