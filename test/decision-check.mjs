// Is gemini-decision-1 (Google's Decisions API) fast and accurate enough to pick the sections a question needs?
//   node --env-file=.env test/decision-check.mjs                 latency: how long a call takes by number of questions and input size
//   node --env-file=.env test/decision-check.mjs --rank --only=Cat,Coffee
//                                                                ranking: the right section for questions worded differently from the
//                                                                article, next to keyword search (same questions as semantic-eval.mjs)
//   --layout=input|question|both   where the sections go (default both, to compare):
//                                    input:    all sections numbered in the shared input, one question per section ("section [7]")
//                                    question: the reader's question is the input, each section's text sits in its own question
//   --type=score|noul              a 0–3 rubric (default) or a yes/no probability per section
//   --words=90                     opening words of each section that are sent (90 is what embeddings use)
//   --unrelated                    also print the best section score of off-topic questions (for a floor)
// The free tier allows 200 requests and 50,000 tokens a minute and 10,000 requests a day; the script paces itself to stay
// under the token limit, so a full --rank run (39 questions, both layouts) takes several minutes. One article is one call
// per question and layout, about 5,000 tokens each at 90 words.
import { appSettings } from '../lib/settings.js';
import { wiki } from '../lib/wiki.js';
import { SET, UNRELATED } from './semantic-questions.mjs';

const MODEL = 'gemini-decision-1';
const URL = 'https://generativelanguage.googleapis.com/v1beta/decisions';
const TOKENS_PER_MINUTE = 45_000; // the free limit is 50,000
const K = 3; // passages read ahead, as in semantic-eval.mjs
const PER_SECTION = 2; // as in lib/embeddings.js
const LEVELS = [
  'Unrelated: about a different aspect of the subject.',
  'Loosely related: the same broad theme, but it would not answer the question.',
  'Likely relevant: covers the aspect asked about and may hold the answer.',
  'Directly answers: this is the section where the answer is.',
];

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error('Set GEMINI_API_KEY (node --env-file=.env test/decision-check.mjs).');
  process.exit(1);
}
const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = flag('only')?.split(',');
const layouts = (flag('layout') || 'both') === 'both' ? ['input', 'question'] : [flag('layout')];
const type = flag('type') === 'noul' ? 'noul' : 'score';
const words = Number(flag('words')) || 90;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);

// ---------- The call, paced to the free tier's tokens per minute ----------

const spent = []; // [time, tokens] of the last minute
let calls = 0;
async function decide(input, questions) {
  const body = JSON.stringify({ model: MODEL, input, questions });
  const estimate = appSettings.estTokens(body);
  for (;;) {
    const now = Date.now();
    while (spent.length && now - spent[0][0] > 60_000) spent.shift();
    if (!spent.length || spent.reduce((n, s) => n + s[1], 0) + estimate <= TOKENS_PER_MINUTE) break;
    const wait = 60_000 - (now - spent[0][0]) + 500;
    console.log(`  (pacing: waiting ${Math.ceil(wait / 1000)} s for the per-minute token limit)`);
    await sleep(wait);
  }
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    const res = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body });
    const text = await res.text();
    const ms = performance.now() - t0;
    calls++;
    if (res.status === 429 && attempt < 4) {
      console.log(`  (429, waiting 30 s: ${text.replace(/\s+/g, ' ').slice(0, 160)})`);
      await sleep(30_000);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 400)}`);
    const json = JSON.parse(text);
    const tokens = json.usage?.total_input_tokens ?? json.usage?.total_tokens ?? estimate;
    spent.push([Date.now(), tokens]);
    return { answers: json.answers || {}, usage: json.usage || {}, tokens, ms, estimate };
  }
}

// ---------- Sections, as the extension would send them ----------

// One unit per section: its heading path and opening words (the same unit embeddings use), with its passages.
function unitsOf(entry, n = words) {
  const groups = new Map();
  for (const c of entry.chunks) groups.set(c.section, [...(groups.get(c.section) || []), c]);
  return [...groups]
    .map(([section, members]) => ({ section, members, body: (members.find((c) => !/^Figure:/.test(c.text))?.text || '').split(/\s+/).slice(0, n).join(' ') }))
    .filter((u) => u.body);
}

const sectionList = (units) => units.map((u, i) => `[${i}] ${u.section}\n${u.body}`).join('\n\n');

function request(title, units, q, layout) {
  const ask = type === 'noul' ? { type: 'noul' } : { type: 'score', criteria: LEVELS };
  const questions = {};
  if (layout === 'input') {
    for (let i = 0; i < units.length; i++) {
      const what = type === 'noul' ? `Does section [${i}] contain the facts needed to answer the reader's question?` : `How well does section [${i}] answer the reader's question?`;
      questions[`s${i}`] = { ...ask, instructions: `A reader of the Wikipedia article "${title}" asks: "${q}"\n${what}` };
    }
    return { input: `Sections of the Wikipedia article "${title}", each with its number, heading and opening words:\n\n${sectionList(units)}`, questions };
  }
  for (let i = 0; i < units.length; i++) {
    const what = type === 'noul' ? "Does this section contain the facts needed to answer the reader's question?" : "How well does this section answer the reader's question?";
    questions[`s${i}`] = { ...ask, instructions: `A section of the article, with its heading and opening words:\n${units[i].section}\n${units[i].body}\n\n${what}` };
  }
  return { input: `A reader of the Wikipedia article "${title}" asks: "${q}"`, questions };
}

const valueOf = (a) => (a?.type === 'noul' ? a.noul : a?.type === 'score' ? a.score : -1);

// ---------- Latency ----------

async function latency() {
  const title = only?.[0] || 'Cat';
  const entry = await wiki.getIndexedPage('en', title, { html: false });
  const q = 'how well can they see in the dark';
  console.log(`Latency on "${entry.page.title}" (${type} questions, sections in the shared input). Each row is 3 calls.\n`);
  console.log('questions  words/section  input tokens  est. tokens  median ms  min ms  max ms');
  const row = async (units, count) => {
    const req = request(entry.page.title, units, q, 'input');
    // More questions than sections: the same ones again under new keys. Fewer: the first ones.
    const questions = {};
    const keys = Object.keys(req.questions);
    for (let i = 0; i < count; i++) questions[`q${i}`] = req.questions[keys[i % keys.length]];
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await decide(req.input, questions));
    const ms = runs.map((r) => r.ms);
    const cols = [count, units[0] ? Math.round(median(units.map((u) => u.body.split(/\s+/).length))) : 0, runs[0].tokens, runs[0].estimate, Math.round(median(ms)), Math.round(Math.min(...ms)), Math.round(Math.max(...ms))];
    console.log(cols.map((c, i) => String(c).padStart([9, 15, 14, 13, 11, 8, 8][i])).join(''));
    return runs[0];
  };
  const units = unitsOf(entry);
  const first = await row(units, 1);
  console.log(`\n  first answer, as returned: ${JSON.stringify(first.answers.q0)}`);
  console.log(`  usage, as returned: ${JSON.stringify(first.usage)}\n`);
  await row(units, 10);
  await row(units, units.length);
  await row(units, 200);
  await row(unitsOf(entry, 30), units.length);
  await row(unitsOf(entry, 250), units.length);
  console.log(`\n${units.length} sections. ${calls} calls made.`);
}

// ---------- Ranking ----------

async function rank() {
  const stat = { keywords: { top1: 0, topK: 0 } };
  for (const l of layouts) stat[l] = { top1: 0, topK: 0, first: 0, ms: [], tokens: [], hit: [], miss: [], unrelated: [] };
  let n = 0;
  for (const [title, questions] of Object.entries(SET)) {
    if (only && !only.includes(title)) continue;
    const entry = await wiki.getIndexedPage('en', title, { html: false });
    const units = unitsOf(entry);
    console.log(`\n## ${entry.page.title} (${units.length} sections, ${entry.chunks.length} passages)`);
    for (const [q, want] of questions) {
      n++;
      const keyword = entry.index.search(q, 40);
      const mark = (hits) => (hits.some((h) => want.test(h.section)) ? (want.test(hits[0].section) ? '✔1' : '✔') : hits.length ? '✘' : '∅');
      const kw = mark(keyword.slice(0, K).map((h) => h.doc));
      stat.keywords.top1 += kw === '✔1' ? 1 : 0;
      stat.keywords.topK += kw.startsWith('✔') ? 1 : 0;
      let line = `  keywords ${kw.padEnd(2)}`;
      for (const layout of layouts) {
        const req = request(entry.page.title, units, q, layout);
        const r = await decide(req.input, req.questions);
        const ranked = units.map((u, i) => ({ u, v: valueOf(r.answers[`s${i}`]) })).sort((a, b) => b.v - a.v);
        // The passages that would be read ahead, as lib/embeddings.js builds them: two per section, best keyword match
        // first, and the best keyword match anywhere kept in third place.
        const kwScore = new Map(keyword.map((h) => [h.doc, h.score]));
        const out = ranked.slice(0, 8).flatMap(({ u }) => u.members.slice().sort((a, b) => (kwScore.get(b) || 0) - (kwScore.get(a) || 0)).slice(0, PER_SECTION));
        if (keyword[0] && !out.includes(keyword[0].doc)) out.splice(2, 0, keyword[0].doc);
        const m = mark(out.slice(0, K));
        const place = ranked.findIndex((x) => want.test(x.u.section)) + 1; // where the right section came, by itself
        const s = stat[layout];
        s.top1 += m === '✔1' ? 1 : 0;
        s.topK += m.startsWith('✔') ? 1 : 0;
        s.first += place === 1 ? 1 : 0;
        s.ms.push(r.ms);
        s.tokens.push(r.tokens);
        s[place === 1 ? 'hit' : 'miss'].push(ranked[0].v);
        line += `  ${layout} ${m.padEnd(2)} (best ${ranked[0].v.toFixed(2)}, right section #${place || '-'}, ${Math.round(r.ms)} ms)`;
      }
      console.log(`${line}  ${q}`);
    }
    if (process.argv.includes('--unrelated')) {
      for (const q of UNRELATED) {
        let line = '  unrelated:';
        for (const layout of layouts) {
          const req = request(entry.page.title, units, q, layout);
          const r = await decide(req.input, req.questions);
          const best = Math.max(...units.map((_, i) => valueOf(r.answers[`s${i}`])));
          stat[layout].unrelated.push(best);
          line += ` ${layout} best ${best.toFixed(2)}`;
        }
        console.log(`${line}  ${q}`);
      }
    }
  }
  console.log(`\n${n} questions, ${type} questions, ${words} words per section, ${calls} calls`);
  console.log(`keywords                 passages: right section first ${stat.keywords.top1}/${n}, in top ${K} ${stat.keywords.topK}/${n}`);
  const range = (a) => (a.length ? `median ${median(a).toFixed(2)}, min ${Math.min(...a).toFixed(2)}, max ${Math.max(...a).toFixed(2)}` : '-');
  for (const l of layouts) {
    const s = stat[l];
    console.log(`sections in the ${l.padEnd(8)} passages: right section first ${s.top1}/${n}, in top ${K} ${s.topK}/${n}; right section ranked first ${s.first}/${n}`);
    console.log(`  per call: median ${Math.round(median(s.ms))} ms (max ${Math.round(Math.max(...s.ms))}), median ${Math.round(median(s.tokens))} input tokens`);
    console.log(`  best section's ${type}: when it is the right one: ${range(s.hit)}; when it is not: ${range(s.miss)}${s.unrelated.length ? `; unrelated questions: ${range(s.unrelated)}` : ''}`);
  }
}

await (process.argv.includes('--rank') ? rank() : latency());
