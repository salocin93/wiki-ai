// Section ranking (experimental): Google's Decisions API (gemini-decision-1) rates every section of an article against
// the reader's question in one call, with no text generated, and keyword search (BM25) picks the passages inside the
// best ones. Gemini only. Anything that goes wrong throws or returns null, and the caller falls back to embeddings or
// keyword search, so a timeout, a rate limit or a missing model never breaks an answer.
//
// Measured with test/decision-check.mjs on 39 questions worded differently from their article (6 articles): the right
// section came first for 36 and was among the 3 passages read ahead for all 39 (keywords: 18 and 28). A call took a
// median of 0.8 s (1.9 s at most) and about 6,000 input tokens. Putting each section in its own question, with the
// reader's question as the shared input, was faster than numbering the sections in the input and told related from
// unrelated questions apart more clearly, so that is the layout here.
import { appSettings } from './settings.js';
import { embeddings } from './embeddings.js';

const MODEL = 'gemini-decision-1';
const URL = 'https://generativelanguage.googleapis.com/v1beta/decisions';
const TIMEOUT_MS = 2500; // a question waits this long, then uses what it would have used without this
const FAIL_BACKOFF_MS = 60_000; // after a failure, no calls for this long instead of retrying on every search
// The free tier allows 50,000 input tokens a minute (and 200 requests a minute, 10,000 a day, which this never nears).
const MINUTE_TOKENS = 45_000;
const MAX_CALL_TOKENS = 20_000; // a whole topic's sections don't fit: those use embeddings or keywords
const SECTIONS_RANKED = 8; // sections kept for a question
// Scores are 0 to 3 (the levels below). On the 39 questions the best section of a related question scored 2.33 to 2.97,
// and of an unrelated one ("what is the capital of Australia" on Great Barrier Reef) 0.68 at most.
const MIN_SCORE = 1.5;
const LEVELS = [
  'Unrelated: about a different aspect of the subject.',
  'Loosely related: the same broad theme, but it would not answer the question.',
  'Likely relevant: covers the aspect asked about and may hold the answer.',
  'Directly answers: this is the section where the answer is.',
];

class DecisionError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {'pace' | 'size'} [soft] expected, not a failure: this minute's tokens are used up / too many sections for one call
   */
  constructor(status, message, soft) {
    super(message);
    this.status = status;
    this.soft = soft;
  }
}

// Adjustable so tests don't wait.
const timing = { timeoutMs: TIMEOUT_MS };
/** @type {{ spent: [number, number][], failedAt: number }} tokens sent in the last minute, and when a call last failed */
const state = { spent: [], failedAt: 0 };
const forget = () => Object.assign(state, { spent: [], failedAt: 0 });

/** Whether section ranking can run with these settings: switched on, on the Gemini API, with a key. */
const available = (settings) => !!settings?.sectionRanking && appSettings.isGemini(settings) && !!settings.apiKey;

/**
 * One Decisions API call: every question is answered against the shared input, independently of the others.
 * @param {Partial<Settings>} settings
 * @param {string} input
 * @param {Record<string, {type: 'noul' | 'choice' | 'score', instructions: string, criteria?: any}>} questions keys of letters, digits, _ and -
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{answers: Record<string, any>, tokens: number, ms: number}>}
 */
async function decide(settings, input, questions, { signal } = {}) {
  const now = Date.now();
  if (now - state.failedAt < FAIL_BACKOFF_MS) throw new DecisionError(0, 'a call failed less than a minute ago');
  const body = JSON.stringify({ model: MODEL, input, questions });
  const estimate = appSettings.estTokens(body);
  if (estimate > MAX_CALL_TOKENS) throw new DecisionError(0, `about ${estimate} tokens, more than the ${MAX_CALL_TOKENS} one call may use`, 'size');
  state.spent = state.spent.filter(([at]) => now - at < 60_000);
  if (state.spent.reduce((n, [, t]) => n + t, 0) + estimate > MINUTE_TOKENS) throw new DecisionError(0, "this minute's tokens are used up", 'pace');
  const spend = /** @type {[number, number]} */ ([now, estimate]); // counted before the reply, so calls side by side see each other
  state.spent.push(spend);
  const limit = AbortSignal.timeout(timing.timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey || '' },
      body,
      signal: signal ? AbortSignal.any([signal, limit]) : limit,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.replace(/\s+/g, ' ').slice(0, 300);
      try {
        message = JSON.parse(text).error?.message || message;
      } catch {
        // not JSON: the text itself is the message
      }
      throw new DecisionError(res.status, `HTTP ${res.status}: ${message}`);
    }
    const json = JSON.parse(text);
    const tokens = json.usage?.total_input_tokens ?? estimate;
    spend[1] = tokens;
    return { answers: json.answers || {}, tokens, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    if (signal?.aborted) throw e; // the reader stopped the answer: not a failure of the service
    state.failedAt = Date.now();
    if (e instanceof DecisionError) throw e;
    throw new DecisionError(0, limit.aborted ? `no reply within ${timing.timeoutMs} ms` : e.message);
  }
}

/**
 * The sections of an article (or of every article of a topic) that a question needs, best first, rated 0 to 3.
 * Empty when none is related enough.
 * @param {{chunks: Chunk[], page?: any, entries?: any[]}} entry
 * @param {string} query
 * @param {Partial<Settings>} settings
 * @param {{ signal?: AbortSignal }} [opts]
 */
async function search(entry, query, settings, opts = {}) {
  const units = embeddings.unitsOf(entry);
  const meta = { model: MODEL, ms: 0, tokens: 0 };
  if (!units.length) return Object.assign([], meta);
  const subject = entry.entries ? 'a group of related Wikipedia articles' : `the Wikipedia article "${entry.page.title}"`;
  const questions = {};
  units.forEach((u, i) => {
    const heading = entry.entries ? `${u.page} › ${u.section}` : u.section;
    questions[`s${i}`] = {
      type: 'score',
      instructions: `A section of ${entry.entries ? 'one of the articles' : 'the article'}, with its heading and opening words:\n${heading}\n${u.body}\n\nHow well does this section answer the reader's question?`,
      criteria: LEVELS,
    };
  });
  const r = await decide(settings, `A reader of ${subject} asks: "${query}"`, questions, opts);
  const scored = units.map((doc, i) => ({ doc, score: r.answers[`s${i}`]?.type === 'score' ? Number(r.answers[`s${i}`].score) || 0 : 0 }));
  scored.sort((a, b) => b.score - a.score);
  return Object.assign(
    scored.slice(0, SECTIONS_RANKED).filter((h) => h.score >= MIN_SCORE),
    { model: MODEL, ms: r.ms, tokens: r.tokens },
  );
}

/**
 * Passages for a question, led by the sections the decision model rates best: in each, the passages that match the
 * question's words best, with the best keyword match anywhere kept (as embeddings.retrieve does). Empty when no section
 * is related enough, null when section ranking is off or not possible here; the caller then uses what it used before.
 * @param {{chunks: Chunk[], page?: any, entries?: any[]}} entry
 * @param {string} query
 * @param {{doc: Chunk, score: number}[]} keyword BM25 results for the same question
 * @param {Partial<Settings>} settings
 * @param {{ signal?: AbortSignal }} [opts]
 */
async function retrieve(entry, query, keyword, settings, opts = {}) {
  if (!available(settings) || !entry.chunks.length) return null;
  const sections = await search(entry, query, settings, opts);
  return Object.assign(embeddings.passagesIn(sections, keyword), { model: sections.model, sections: sections.length, ms: sections.ms, tokens: sections.tokens });
}

export const decisions = { available, decide, search, retrieve, forget, timing, DecisionError, MODEL, MIN_SCORE };
