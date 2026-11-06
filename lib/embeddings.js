// Semantic search (experimental): an article is embedded one text per section (its heading and opening words), and a
// question is matched to the best sections by cosine similarity. Keyword search (BM25) picks the passages inside them
// and stays the fallback. Two backends: Gemini's native batchEmbedContents (gemini-embedding-001 with task types,
// gemini-embedding-2 with text prefixes; 768 dimensions) and any OpenAI-compatible /embeddings endpoint (Ollama,
// LM Studio, llama.cpp, vLLM). Anything that goes wrong throws, and the caller falls back to keyword search, so a
// missing model, a rate limit or a used-up quota never breaks an answer.
//
// Why sections: Gemini's free tier counts every text as a request (100 a minute, 1,000 a day per model), and an article
// has ~70 passages but ~35 sections. Measured on 14 hard questions, sections found the right place as often as passages.
// Both Gemini models have their own free quota, so an article is embedded with whichever has budget left (vectors of
// different models can't be compared, so a question always uses the model its article was embedded with).
//
// Embedding can take longer than a reader will wait, so it runs as a background job that saves each batch as it
// finishes. A question waits a few seconds for it, then uses keyword search; later questions find the vectors ready.
import { appSettings } from './settings.js';
import { cache } from './cache.js';
import { storage } from './storage.js';

const GEMINI_MODELS = ['gemini-embedding-001', 'gemini-embedding-2']; // each has its own free quota
const GEMINI_DIMS = 768; // the models' default is 3072; 768 loses little and is 4× smaller to store
const MAX_TEXT_CHARS = 2000;
const UNIT_WORDS = 90; // opening words of a section that are embedded with its heading
const MAX_UNITS = 60; // articles with more sections are embedded by top-level section instead
const TOPIC_UNIT_CAP = 400; // sections in a whole topic: beyond this the free daily budget would be mostly gone
const BATCH = { gemini: 50, openai: 32 }; // a rate limit counts texts, so smaller batches save progress sooner
const SECTIONS_RANKED = 8; // sections kept for a question
const PER_SECTION = 2; // passages taken from each, best keyword match first
const RETRY_WAITS = [5, 15, 30]; // seconds, after "too many requests" when the server doesn't say how long
const MAX_RETRIES = { job: 8, test: 2, query: 0 }; // a background job keeps trying; a question gives up at once
const MAX_RETRY_WAIT = 65; // seconds: a per-minute quota is back within one
const FAIL_BACKOFF_MS = 60_000; // after a failure, keyword search only for this long instead of retrying every call
const QUERY_MEMO = 50;
const MAX_JOBS = 40;
const FREE_DAILY = 1000; // Gemini free tier, per model
const NEW_ARTICLE_SHARE = 0.85; // new articles stop at this share of the day's budget; the rest keeps questions working
const MARGIN = 0.12; // sections more than this below the best one are dropped (cosines of one question sit close together)
// Below this a section isn't related at all. Measured with test/semantic-eval.mjs (768 dimensions, sections, Coffee and Cat):
//   gemini-embedding-001: unrelated questions top out at 0.53, right sections start at 0.61 → 0.55
//   gemini-embedding-2:   unrelated up to 0.56, right sections start at 0.69 → 0.62 (one article, so provisional)
// Other models score on other scales, so they get no floor until one is set in the settings.
const MIN_SCORES = { 'gemini-embedding-001': 0.55, 'gemini-embedding-2': 0.62 };
const FIGURE = /^Figure:/;

// Adjustable so tests don't wait: how long a question waits for sections still being embedded, and a factor on all sleeps.
const timing = { waitMs: 6000, scale: 1 };

class EmbedError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {'pending' | 'budget' | 'size'} [soft] expected, not a failure: still being made / quota used up / too big to embed
   */
  constructor(status, message, soft) {
    super(message);
    this.status = status;
    this.soft = soft;
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
    }, ms * timing.scale);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const isV2 = (cfg) => cfg.gemini && /^gemini-embedding-2/.test(cfg.model);

/**
 * Where embeddings come from: one entry per model that may be used, or none when the feature is off or not set up.
 * An empty embedding endpoint means the chat endpoint, and on Gemini an empty model means both Gemini models (each with
 * its own free quota). The chat key is only sent to the chat endpoint's host.
 * @param {Partial<Settings>} settings
 */
function configs(settings) {
  if (!settings?.semanticSearch) return [];
  const baseUrl = (settings.embedBaseUrl || settings.baseUrl || '').trim().replace(/\/$/, '');
  if (!baseUrl) return [];
  const gemini = appSettings.isGemini({ baseUrl });
  const explicit = (settings.embedModel || '').trim();
  const models = explicit ? [explicit] : gemini ? GEMINI_MODELS : [];
  const host = hostOf(baseUrl);
  const key = (settings.embedApiKey || '').trim() || (host && host === hostOf(settings.baseUrl || '') ? settings.apiKey || '' : '');
  const docPrefix = settings.embedDocPrefix || '';
  const queryPrefix = settings.embedQueryPrefix || '';
  const setScore = Number(settings.embedMinScore) || 0;
  const setLimit = Number(settings.embedDailyLimit) || 0;
  const limit = setLimit < 0 ? Infinity : setLimit > 0 ? setLimit : gemini ? FREE_DAILY : Infinity;
  return models.map((model) => ({
    baseUrl,
    gemini,
    model,
    key,
    docPrefix,
    queryPrefix,
    limit,
    minScore: setScore !== 0 ? setScore : gemini ? (MIN_SCORES[model] ?? -1) : -1,
    id: [gemini ? 'gemini' : 'openai', host, model, docPrefix, 'sections'].join('|'),
  }));
}

/** The first model that may be used, or null. */
const config = (settings) => configs(settings)[0] || null;

// "Not found" for a Gemini model: ask which embedding models the key can use, so the message names the right one
// instead of leaving a guess (the names change between releases).
async function explainMissingModel(cfg, message, signal) {
  try {
    const root = cfg.baseUrl.replace(/\/openai$/, '');
    const res = await fetch(`${root}/models?pageSize=200`, { headers: { 'x-goog-api-key': cfg.key }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
    if (!res.ok) return message;
    const names = ((await res.json()).models || [])
      .filter((m) => (m.supportedGenerationMethods || []).some((x) => /embed/i.test(x)))
      .map((m) => m.name.replace(/^models\//, ''));
    if (!names.length) return message;
    return `${message} Embedding models for this key: ${names.join(', ')}.`;
  } catch {
    return message;
  }
}

// How long a server asks to wait: Gemini's "Please retry in 28.9s" / "retryDelay": "28s", or Retry-After.
function retryAfter(text, res) {
  const said = Number(text.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/)?.[1] || text.match(/retry in (\d+(?:\.\d+)?)s/i)?.[1] || res.headers.get('retry-after'));
  return Number.isFinite(said) && said > 0 ? Math.min(Math.ceil(said) + 1, MAX_RETRY_WAIT) : 0;
}

async function postJson(url, headers, body, signal, { retries = 0, onNotFound } = /** @type {{ retries?: number, onNotFound?: (message: string) => Promise<string> }} */ ({})) {
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
    if ((res.status === 429 || res.status === 503) && attempt < retries && !/per ?day|PerDay|daily/i.test(text)) {
      await sleep((retryAfter(text, res) || RETRY_WAITS[Math.min(attempt, RETRY_WAITS.length - 1)]) * 1000, signal);
      continue;
    }
    let message = text;
    try {
      message = JSON.parse(text).error?.message || text;
    } catch {
      // not JSON: use the body as it is
    }
    message = `${res.status}: ${message.slice(0, 300) || res.statusText}`;
    throw new EmbedError(res.status, res.status === 404 && onNotFound ? await onNotFound(message) : message);
  }
}

/** One request of at most one batch of texts → one vector each (not yet normalised). */
async function embedBatch(cfg, texts, kind, signal, retries) {
  const problem = appSettings.endpointProblem(cfg.baseUrl);
  if (problem) throw new EmbedError(0, problem);
  const prefix = kind === 'query' ? cfg.queryPrefix : cfg.docPrefix;
  const inputs = texts.map((t) => prefix + t.slice(0, MAX_TEXT_CHARS));
  if (cfg.gemini) {
    const root = cfg.baseUrl.replace(/\/openai$/, ''); // …/v1beta/openai → …/v1beta
    // gemini-embedding-2 has no task type: the task is part of the text (see docText / queryText).
    const extra = isV2(cfg) ? { outputDimensionality: GEMINI_DIMS } : { taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT', outputDimensionality: GEMINI_DIMS };
    const data = await postJson(
      `${root}/models/${cfg.model}:batchEmbedContents`,
      { 'x-goog-api-key': cfg.key },
      { requests: inputs.map((text) => ({ model: `models/${cfg.model}`, content: { parts: [{ text }] }, ...extra })) },
      signal,
      { retries, onNotFound: (message) => explainMissingModel(cfg, message, signal) }
    );
    const out = (data.embeddings || []).map((e) => e.values);
    if (out.length !== texts.length || out.some((v) => !v?.length)) throw new EmbedError(0, 'Gemini returned a different number of embeddings than texts sent.');
    return out;
  }
  const data = await postJson(`${cfg.baseUrl}/embeddings`, cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}, { model: cfg.model, input: inputs }, signal, { retries });
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

const batchSize = (cfg) => (cfg.gemini ? BATCH.gemini : BATCH.openai);

async function embedTexts(cfg, texts, kind, signal, retries) {
  const vectors = [];
  const size = batchSize(cfg);
  for (let i = 0; i < texts.length; i += size) vectors.push(...(await embedBatch(cfg, texts.slice(i, i + size), kind, signal, retries)));
  return pack(vectors);
}

// ---------- What is embedded ----------

/**
 * One unit per section: its heading and opening words. A section made only of image descriptions is skipped. An article
 * with very many sections is embedded by top-level section instead, listing the subsections' names.
 * An indexed article is {page, chunks}; a topic corpus is {chunks, entries} and has the units of all its articles.
 * @returns {{ page: string, section: string, body: string, members: Chunk[] }[]}
 */
function unitsOf(entry) {
  if (entry.entries) return entry.entries.flatMap(unitsOf);
  if (entry.units) return entry.units;
  const opening = (chunks, words) => (chunks.find((c) => !FIGURE.test(c.text))?.text || '').split(/\s+/).slice(0, words).join(' ');
  const group = (keyOf) => {
    const groups = new Map();
    for (const c of entry.chunks) groups.set(keyOf(c), [...(groups.get(keyOf(c)) || []), c]);
    return groups;
  };
  const page = entry.page.title;
  let units = [...group((c) => c.section)].map(([section, members]) => ({ page, section, body: opening(members, UNIT_WORDS), members })).filter((u) => u.body);
  if (units.length > MAX_UNITS) {
    units = [...group((c) => c.section.split(' › ')[0])]
      .map(([section, members]) => {
        const subs = [...new Set(members.map((c) => c.section.split(' › ').slice(1).join(' › ')).filter(Boolean))];
        const first = opening(members, 60);
        return { page, section, body: first && `${subs.length ? `Includes: ${subs.join(', ')}. ` : ''}${first}`, members };
      })
      .filter((u) => u.body);
  }
  entry.units = units;
  return units;
}

// gemini-embedding-2 takes the task as text: documents as "title: … | text: …", questions as "task: search result | query: …".
const docText = (cfg, u) => (isV2(cfg) ? `title: ${u.page} — ${u.section} | text: ${u.body}` : `${u.page} — ${u.section}\n${u.body}`);
const queryText = (cfg, q) => (isV2(cfg) ? `task: search result | query: ${q}` : q);

const concat = (parts) => {
  const flat = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    flat.set(p, at);
    at += p.length;
  }
  return flat;
};

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

// ---------- Daily budget ----------

// Free quotas reset at midnight Pacific time. The count is per model and kept across restarts.
const BUDGET_KEY = 'embedBudget';
const pacificDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
async function today() {
  const stored = await storage.get(BUDGET_KEY);
  return stored?.day === pacificDay() ? stored : { day: pacificDay(), counts: {} };
}
const used = async (model) => (await today()).counts[model] || 0;
const spend = (model, n) =>
  storage.locked(BUDGET_KEY, async () => {
    const b = await today();
    b.counts[model] = (b.counts[model] || 0) + n;
    await storage.set(BUDGET_KEY, b);
  });

/** Requests used today per model, for the settings page. */
async function usage(settings) {
  return Promise.all(configs({ ...settings, semanticSearch: true }).map(async (cfg) => ({ model: cfg.model, used: await used(cfg.model), limit: cfg.limit })));
}

// ---------- Background jobs ----------

/** Background embedding jobs by cache key: article + revision + model. Not tied to the question that started one. */
const jobs = new Map();

const baseKey = (entry, cfg) => {
  const units = unitsOf(entry);
  const chars = units.reduce((n, u) => n + u.body.length, 0);
  return `emb:${cfg.id}:${entry.page.lang}:${entry.page.title}:${entry.page.revid || 0}:${units.length}.${chars}`;
};

function startJob(entry, cfg, base) {
  const units = unitsOf(entry);
  const texts = units.map((u) => docText(cfg, u));
  const size = batchSize(cfg);
  const job = { total: Math.ceil(texts.length / size), done: 0, size, count: texts.length, value: null, error: null, failedAt: 0, promise: null };
  job.promise = (async () => {
    const parts = [];
    for (let b = 0; b < job.total; b++) {
      // Each batch is kept as soon as it's made, so a rate-limit wait, a closed tab or a restarted service worker
      // doesn't throw the finished ones away.
      parts.push(
        await cache.wrap(`${base}:${b}`, async () => {
          const slice = texts.slice(b * size, (b + 1) * size);
          const vectors = await embedTexts(cfg, slice, 'doc', undefined, MAX_RETRIES.job);
          await spend(cfg.model, slice.length);
          return vectors;
        })
      );
      job.done = b + 1;
    }
    job.value = concat(parts);
    return job.value;
  })();
  job.promise.catch((e) => {
    job.error = e;
    job.failedAt = Date.now();
  });
  jobs.set(base, job);
  while (jobs.size > MAX_JOBS) {
    const old = [...jobs].find(([, j]) => j.value || j.error);
    if (!old) break;
    jobs.delete(old[0]);
  }
  return job;
}

// Resolves with the job's vectors, or fails with a "not ready" error after timing.waitMs. The job carries on.
function waitFor(job, title, signal) {
  return new Promise((resolve, reject) => {
    const finish = (fn) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(signal.reason || new Error('Aborted')));
    const timer = setTimeout(() => finish(() => reject(new EmbedError(0, `still embedding “${title}” in the background: ${Math.min(job.done * job.size, job.count)} of ${job.count} sections`, 'pending'))), timing.waitMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    job.promise.then((v) => finish(() => resolve(v)), (e) => finish(() => reject(e)));
  });
}

// Whether an article's vectors for this model are stored (or being made right now).
async function cachedFully(entry, cfg) {
  const base = baseKey(entry, cfg);
  const job = jobs.get(base);
  if (job && !job.error) return true;
  const batches = Math.ceil(unitsOf(entry).length / batchSize(cfg));
  for (let b = 0; b < batches; b++) if ((await cache.get(`${base}:${b}`)) === undefined) return false;
  return true;
}

// The model to embed with: one that already has these articles (a question must use the model its article was embedded
// with), else the one with the most budget to spare; new articles stop at NEW_ARTICLE_SHARE of the day's budget.
async function pickConfig(entries, cfgs) {
  let best = null;
  for (const cfg of cfgs) {
    let need = 0;
    for (const e of entries) if (!(await cachedFully(e, cfg))) need += unitsOf(e).length;
    if (need === 0) return cfg;
    const left = cfg.limit * NEW_ARTICLE_SHARE - (await used(cfg.model));
    if (need <= left && (!best || left > best.left)) best = { cfg, left };
  }
  if (best) return best.cfg;
  throw new EmbedError(0, `today's embedding budget is used up (${cfgs.map((c) => `${c.model}: ${Number.isFinite(c.limit) ? c.limit : '∞'}`).join(', ')} a day)`, 'budget');
}

/**
 * The sections' vectors, in unit order. Persisted in the article cache per batch, keyed by model, revision and content,
 * so a service-worker restart or a second question costs nothing. Throws a `soft` 'pending' error while still being made.
 * @returns {Promise<Float32Array>}
 */
async function vectorsFor(entry, cfg, signal, onStart) {
  if (entry.entries) return concat(await mapLimit(entry.entries, 4, (e) => vectorsFor(e, cfg, signal, onStart)));
  const base = baseKey(entry, cfg);
  let job = jobs.get(base);
  if (job?.value) return job.value;
  if (job?.error && Date.now() - job.failedAt < FAIL_BACKOFF_MS) throw job.error;
  if (!job || job.error) {
    // Say "embedding" only when there is something to embed, not when the batches are already stored.
    if ((await cache.get(`${base}:0`)) === undefined) onStart?.();
    job = startJob(entry, cfg, base);
  }
  return waitFor(job, entry.page.title, signal);
}

const queryMemo = new Map();
async function queryVector(cfg, query, signal) {
  const key = `${cfg.id}|${query}`;
  if (queryMemo.has(key)) return queryMemo.get(key);
  if ((await used(cfg.model)) >= cfg.limit) throw new EmbedError(0, `today's ${cfg.model} budget is used up`, 'budget');
  const v = await embedTexts(cfg, [queryText(cfg, query)], 'query', signal, MAX_RETRIES.query);
  await spend(cfg.model, 1);
  queryMemo.set(key, v);
  if (queryMemo.size > QUERY_MEMO) queryMemo.delete(queryMemo.keys().next().value);
  return v;
}

// ---------- Search ----------

/**
 * Sections ranked by meaning, best first, as {doc: unit, score}. Returns null when semantic search is off or not set
 * up; throws when the embedding service fails, or a `soft` error when the sections aren't embedded yet, the day's budget
 * is used up or the topic is too large.
 * @param {{chunks: Chunk[], page?: any, entries?: any[]}} entry
 * @param {string} query
 * @param {Partial<Settings>} settings
 * @param {{ signal?: AbortSignal, k?: number, onStart?: () => void }} [opts]
 */
async function search(entry, query, settings, { signal, k = SECTIONS_RANKED, onStart } = {}) {
  const cfgs = configs(settings);
  if (!cfgs.length || !entry.chunks.length) return null;
  const units = unitsOf(entry);
  if (!units.length) return Object.assign([], { model: cfgs[0].model });
  if (entry.entries && units.length > TOPIC_UNIT_CAP) {
    throw new EmbedError(0, `the topic has ${units.length} sections, more than the ${TOPIC_UNIT_CAP} that fit a free daily budget`, 'size');
  }
  const cfg = await pickConfig(entry.entries || [entry], cfgs);
  const vecs = await vectorsFor(entry, cfg, signal, onStart);
  const q = await queryVector(cfg, query, signal); // after the sections: no request is spent on a question that can't be ranked yet
  const dims = q.length;
  if (vecs.length !== units.length * dims) throw new EmbedError(0, 'The stored vectors and the question have different sizes (was the model changed?).');
  const scored = units.map((doc, i) => {
    let dot = 0;
    for (let d = 0; d < dims; d++) dot += vecs[i * dims + d] * q[d];
    return { doc, score: dot };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, k);
  return Object.assign(top.filter((h) => h.score >= cfg.minScore && h.score >= top[0].score - MARGIN), { model: cfg.model });
}

/**
 * Passages for a question, led by meaning: the best sections, and in each the passages that match the question's words best
 * (or the first ones). The best keyword match is kept even when its section wasn't picked, so an exact name or date is never
 * lost. Empty when nothing is related, null when semantic search is off; the caller then uses the keyword results.
 * @param {{chunks: Chunk[], page?: any, entries?: any[]}} entry
 * @param {{doc: Chunk, score: number}[]} keyword BM25 results for the same question
 * @param {Partial<Settings>} settings
 * @param {{ signal?: AbortSignal, onStart?: () => void }} [opts]
 */
async function retrieve(entry, query, keyword, settings, opts = {}) {
  const sections = await search(entry, query, settings, opts);
  if (!sections) return null;
  const score = new Map(keyword.map((h) => [h.doc, h.score]));
  const out = [];
  for (const s of sections) {
    const ranked = s.doc.members.slice().sort((a, b) => (score.get(b) || 0) - (score.get(a) || 0));
    for (const doc of ranked.slice(0, PER_SECTION)) out.push({ doc, score: s.score });
  }
  const best = keyword[0];
  if (out.length && best && !out.some((h) => h.doc === best.doc)) out.splice(Math.min(2, out.length), 0, { doc: best.doc, score: best.score });
  return Object.assign(out, { model: sections.model, sections: sections.length });
}

/**
 * Reciprocal rank fusion of ranked lists (kept for comparisons: on the test questions a meaning-led ranking beat it).
 * @param {{doc: any, score: number}[][]} lists best first
 */
function fuse(lists, k, c = 60) {
  const total = new Map();
  for (const list of lists) list.forEach((h, rank) => total.set(h.doc, (total.get(h.doc) || 0) + 1 / (c + rank + 1)));
  return [...total].map(([doc, score]) => ({ doc, score })).sort((a, b) => b.score - a.score).slice(0, k);
}

/** Checks the settings with one real request per model, for the settings page. */
async function test(settings, signal) {
  const cfgs = configs({ ...settings, semanticSearch: true });
  if (!cfgs.length) throw new EmbedError(0, 'Set an embedding model (or use a Gemini endpoint).');
  const sample = { page: 'Rayleigh scattering', section: 'Introduction', body: 'The sky is blue because air scatters short wavelengths of sunlight more.' };
  const out = [];
  for (const cfg of cfgs) {
    try {
      const v = await embedTexts(cfg, [docText(cfg, sample)], 'doc', signal, MAX_RETRIES.test);
      await spend(cfg.model, 1);
      out.push({ model: cfg.model, dims: v.length });
    } catch (e) {
      out.push({ model: cfg.model, error: e.message });
    }
  }
  return out;
}

const forget = () => {
  queryMemo.clear();
  jobs.clear();
};

export const embeddings = { config, configs, search, retrieve, fuse, test, usage, forget, timing, resetBudget: () => storage.remove(BUDGET_KEY), GEMINI_MODELS, TOPIC_UNIT_CAP };
