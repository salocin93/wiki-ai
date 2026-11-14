// Does semantic search find the right section when the question doesn't use the article's words?
//   node test/semantic-eval.mjs --bm25-only            keyword search only: no key, no quota
//   GEMINI_API_KEY=… node test/semantic-eval.mjs --only=Cat,Coffee   the real retrieval path (sections, with the budget and
//                                                      the similarity floor) next to keywords; two articles cost ~100 requests
//   add --no-gate to embed on every question (the old behaviour) and compare with the default, which embeds an article only when keywords look unsure
//   add --model=gemini-embedding-2 to use one model, --unrelated to also print the scores of off-topic questions (for the floor)
//   EMBED_URL=http://localhost:11434/v1 EMBED_MODEL=nomic-embed-text [EMBED_DOC_PREFIX=… EMBED_QUERY_PREFIX=…] for a local model
// The expected section is my judgment of where the answer sits, so treat the scores as a comparison between methods, not
// as ground truth. A hit means one of the 3 passages that would be read ahead is in that section. "semantic" is exactly what
// the extension does: the best sections' passages, or the keyword results when no section is related enough.
import { appSettings } from '../lib/settings.js';
import { embeddings } from '../lib/embeddings.js';
import { wiki } from '../lib/wiki.js';
import { SET, UNRELATED } from './semantic-questions.mjs';

const K = 3;
const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const bm25Only = process.argv.includes('--bm25-only');
const only = flag('only')?.split(',');
const env = process.env;
const settings = {
  ...appSettings.DEFAULTS,
  semanticSearch: true,
  apiKey: env.GEMINI_API_KEY || '',
  embedBaseUrl: env.EMBED_URL || '',
  embedModel: flag('model') || env.EMBED_MODEL || '',
  embedDocPrefix: env.EMBED_DOC_PREFIX || '',
  embedQueryPrefix: env.EMBED_QUERY_PREFIX || '',
  embedGate: !process.argv.includes('--no-gate'), // --no-gate: embed on every question, to compare with the gate
};
const useEmbeddings = !bm25Only && embeddings.configs(settings).length > 0 && !!(env.GEMINI_API_KEY || env.EMBED_URL);
if (!bm25Only && !useEmbeddings) console.error('No GEMINI_API_KEY or EMBED_URL: running keyword search only.\n');
embeddings.timing.waitMs = 15 * 60_000; // wait out the rate limit here instead of falling back

// A question's own embedding doesn't retry (in the extension it would rather fall back), so wait out a 429 here.
async function patient(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e.status !== 429 || attempt >= 6) throw e;
      console.log('  (rate limited, waiting 25 s)');
      await new Promise((r) => setTimeout(r, 25_000));
    }
  }
}

const stat = { keywords: { top1: 0, topK: 0 }, semantic: { top1: 0, topK: 0, fellBack: 0 }, gate: { skipped: 0, embedded: 0 } };
const scores = { hit: [], miss: [] };
const unrelatedTop = [];
let n = 0;
let passages = 0;
for (const [title, questions] of Object.entries(SET)) {
  if (only && !only.includes(title)) continue;
  const entry = await wiki.getIndexedPage('en', title, { html: false });
  console.log(`\n## ${entry.page.title} (${entry.chunks.length} passages)`);
  passages += entry.chunks.length;
  for (const [q, want] of questions) {
    n++;
    const keyword = entry.index.search(q, 40);
    const kwTop = keyword.slice(0, K);
    const mark = (hits) => (hits.some((h) => want.test(h.doc.section)) ? (want.test(hits[0].doc.section) ? '✔1' : '✔') : hits.length ? '✘' : '∅');
    const kwMark = mark(kwTop);
    stat.keywords.top1 += kwMark === '✔1' ? 1 : 0;
    stat.keywords.topK += kwMark.startsWith('✔') ? 1 : 0;
    let line = `  keywords ${kwMark.padEnd(2)}`;
    if (useEmbeddings) {
      // The gate decides from the keyword results whether this question is worth embedding the article for (per article, once).
      const gate = await embeddings.gate(entry, q, keyword, settings);
      if (!gate.use) stat.gate.skipped++;
      const meaning = gate.use ? await patient(() => embeddings.retrieve(entry, q, keyword, settings, { onStart: () => stat.gate.embedded++ })) : null; // onStart: this question had the article embedded
      const fellBack = !meaning?.length;
      const top = fellBack ? kwTop : meaning.slice(0, K);
      const m = mark(top);
      stat.semantic.top1 += m === '✔1' ? 1 : 0;
      stat.semantic.topK += m.startsWith('✔') ? 1 : 0;
      stat.semantic.fellBack += fellBack ? 1 : 0;
      if (!fellBack) scores[m.startsWith('✔') ? 'hit' : 'miss'].push(meaning[0].score);
      line += `  gate ${gate.use ? 'EMBED' : 'skip '} semantic ${m.padEnd(2)}${!gate.use ? ' (keywords)' : fellBack ? ' (no section related enough: keywords)' : ` (${meaning[0].score.toFixed(2)})`}`;
    }
    console.log(`${line.padEnd(78)} ${q}`);
  }
  if (useEmbeddings && process.argv.includes('--unrelated')) {
    const raw = { ...settings, embedMinScore: -1 };
    for (const q of UNRELATED) {
      const top = (await patient(() => embeddings.search(entry, q, raw, { k: 1 })))[0];
      unrelatedTop.push(top?.score || 0);
      console.log(`  unrelated: top section score ${(top?.score || 0).toFixed(2)}  ${q}`);
    }
  }
}
console.log(`\n${n} questions, ${passages} passages`);
console.log(`keywords  right section first: ${stat.keywords.top1}/${n}   in top ${K}: ${stat.keywords.topK}/${n}`);
if (useEmbeddings) {
  console.log(`gate ${settings.embedGate ? 'on' : 'off'}: ${stat.gate.skipped} of ${n} questions answered by keywords alone; ${stat.gate.embedded} article embedding${stat.gate.embedded === 1 ? '' : 's'} started`);
  console.log(`semantic  right section first: ${stat.semantic.top1}/${n}   in top ${K}: ${stat.semantic.topK}/${n}   fell back to keywords: ${stat.semantic.fellBack}`);
  const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(2) : '-');
  console.log(`best section score, when right: median ${med(scores.hit)} (min ${scores.hit.length ? Math.min(...scores.hit).toFixed(2) : '-'}); when wrong: median ${med(scores.miss)}${unrelatedTop.length ? `; unrelated questions: max ${Math.max(...unrelatedTop).toFixed(2)}` : ''}`);
  for (const u of await embeddings.usage(settings)) console.log(`requests this run — ${u.model}: ${u.used}`);
}
