// Does a question get the right Wikipedia article in front of the model? A fixed set of questions, each with the
// article (and for questions about the page itself, the section) an answer should draw on.
//   node test/answer-eval.mjs                 what is read ahead before the model starts: no key, no quota
//   LLM_API_KEY=… node test/answer-eval.mjs --answers   real answers: which articles they cite, model calls, seconds
//   --only=named,drift   some kinds only;  --limit=2   the first questions of each kind;  --out=file.json   keep the results
// Kinds: own (about the page, in other words than its own), named (names another article), drift (about another subject
// without naming its article), back (leans on the question before it), lang (asked in, or on, another language),
// topic (asked inside a small topic).
// The expected articles are my judgment of where the answer sits, so read the scores as a comparison between two
// versions of the code, not as ground truth. Read-ahead scores say what the model starts from; a miss there can still
// become a hit in --answers when the model looks the article up itself, at the cost of a round or two.
import { writeFileSync } from 'node:fs';
import { agent } from '../lib/agent.js';
import { appSettings } from '../lib/settings.js';
import { textUtil } from '../lib/text.js';
import { topics } from '../lib/topics.js';
import { wiki } from '../lib/wiki.js';
import { pageLinks } from './page-links.mjs';

const BISMARCK = [{ role: 'user', content: 'Who was Otto von Bismarck?' }, { role: 'assistant', content: 'Otto von Bismarck was the Prussian statesman who led the unification of Germany [1].' }];
const BABBAGE = [{ role: 'user', content: 'Who was Charles Babbage?' }, { role: 'assistant', content: 'Charles Babbage was an English mathematician who designed mechanical computers [1].' }];
const CAFFEINE = [{ role: 'user', content: 'What is caffeine?' }, { role: 'assistant', content: 'Caffeine is a stimulant found in coffee beans [1].' }];

const TOPIC = {
  id: 'eval', updatedAt: 1, lang: 'en', name: 'Hanover and German unification', seed: 'George V of Hanover', edges: [],
  facets: [{ name: 'People', why: '' }, { name: 'Events', why: '' }, { name: 'States', why: '' }],
  pages: [
    { title: 'George V of Hanover', seed: true, facet: null },
    { title: 'Otto von Bismarck', facet: 'People' },
    { title: 'Austro-Prussian War', facet: 'Events' },
    { title: 'Congress of Vienna', facet: 'Events' },
    { title: 'Kingdom of Hanover', facet: 'States' },
    { title: 'German Confederation', facet: 'States' },
  ],
};

// [kind, article, question, expected articles (any of them), {section, history, lang, topic}]
const SET = [
  ['own', 'Ada Lovelace', 'who wrote the first algorithm meant for a machine', ['Ada Lovelace'], { section: /First published computer program/ }],
  ['own', 'Ada Lovelace', 'how did she die and at what age', ['Ada Lovelace'], { section: /Death/ }],
  ['own', 'Coffee', 'how do you remove the stimulant from the beans', ['Coffee'], { section: /Decaffeination/ }],
  ['own', 'Coffee', 'when did it reach Europe', ['Coffee'], { section: /History/ }],
  ['own', 'Photosynthesis', 'what share of sunlight ends up stored as chemical energy', ['Photosynthesis'], { section: /Efficiency/ }],

  ['named', 'George V of Hanover', 'Tell me more about Prussia', ['Prussia', 'Kingdom of Prussia']],
  ['named', 'George V of Hanover', 'What did Bismarck do after 1866?', ['Otto von Bismarck']],
  ['named', 'George V of Hanover', 'What happened at the Battle of Langensalza?', ['Battle of Langensalza (1866)']],
  ['named', 'George V of Hanover', 'What was decided at the Congress of Vienna?', ['Congress of Vienna']],
  ['named', 'George V of Hanover', 'How does photosynthesis work?', ['Photosynthesis']],
  ['named', 'Ada Lovelace', 'Who was Charles Babbage?', ['Charles Babbage']],
  ['named', 'Ada Lovelace', 'What was the Analytical Engine?', ['Analytical engine']],
  ['named', 'Ada Lovelace', 'Who was Grace Hopper?', ['Grace Hopper']],
  ['named', 'Coffee', 'What is caffeine?', ['Caffeine']],
  ['named', 'Coffee', 'How did the Boston Tea Party start?', ['Boston Tea Party']],
  ['named', 'World War I', 'What happened at Verdun?', ['Battle of Verdun']],
  ['named', 'Photosynthesis', 'What caused the Great Oxidation Event?', ['Great Oxidation Event']],

  ['drift', 'George V of Hanover', 'Who commanded the Prussian army in the war of 1866?', ['Helmuth von Moltke the Elder', 'Austro-Prussian War', 'Prussian Army']],
  ['drift', 'Ada Lovelace', 'Who built the first working programmable computer?', ['Konrad Zuse', 'Z3 (computer)', 'Computer', 'History of computing hardware']],
  ['drift', 'Coffee', 'How are tea leaves processed after picking?', ['Tea', 'Tea processing']],
  ['drift', 'Photosynthesis', 'How do animal cells get energy out of sugar?', ['Cellular respiration', 'Glycolysis']],

  ['back', 'George V of Hanover', 'And what happened to him afterwards?', ['Otto von Bismarck'], { history: BISMARCK }],
  ['back', 'Ada Lovelace', 'What did he build?', ['Charles Babbage', 'Difference engine', 'Analytical engine'], { history: BABBAGE }],
  ['back', 'Coffee', 'How does it affect sleep?', ['Caffeine'], { history: CAFFEINE }],

  ['lang', 'George V of Hanover', 'Was wurde auf dem Wiener Kongress beschlossen?', ['Congress of Vienna']],
  ['lang', 'Coffee', 'Wie wird das Koffein aus den Bohnen entfernt?', ['Coffee', 'Decaffeination'], { section: /Decaffeination|Introduction/ }],
  ['lang', 'Georg V. (Hannover)', 'Erzähl mir mehr über Preußen', ['Preußen', 'Königreich Preußen'], { lang: 'de' }],
  ['lang', 'Georg V. (Hannover)', 'Was geschah mit dem Königreich nach dem Krieg von 1866?', ['Königreich Hannover', 'Deutscher Krieg', 'Provinz Hannover'], { lang: 'de' }],
  ['lang', 'Café', "Qu'est-ce que la caféine ?", ['Caféine'], { lang: 'fr' }],

  ['topic', 'George V of Hanover', 'How did the German Confederation come to an end?', ['German Confederation', 'Austro-Prussian War'], { topic: TOPIC }],
  ['topic', 'George V of Hanover', 'What part did Bismarck play in the war of 1866?', ['Otto von Bismarck', 'Austro-Prussian War'], { topic: TOPIC }],
  ['topic', 'George V of Hanover', 'What territory did Hanover gain in 1815?', ['Kingdom of Hanover', 'Congress of Vienna'], { topic: TOPIC }],
];

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const answers = process.argv.includes('--answers');
const only = arg('only')?.split(',');
const limit = Number(arg('limit')) || Infinity;
if (answers && !process.env.LLM_API_KEY) throw new Error('--answers needs LLM_API_KEY');

const settings = { ...appSettings.DEFAULTS, ...(process.env.LLM_BASE_URL ? { baseUrl: process.env.LLM_BASE_URL, fallbackModel: '' } : {}), apiKey: process.env.LLM_API_KEY || '', answerLanguage: 'question' };
const linksOf = new Map();
const links = async (lang, title) => {
  const key = `${lang}:${title}`;
  if (!linksOf.has(key)) linksOf.set(key, await pageLinks(lang, title));
  return linksOf.get(key);
};

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const hit = (sources, expected, section) => sources.some((s) => expected.some((e) => same(e, s.page)) && (!section || section.test(s.section)));

async function one([kind, title, question, expected, { section, history = [], lang = 'en', topic = null } = {}]) {
  const sources = [];
  let trace = null;
  const page = { lang, title, links: await links(lang, title), visibleSection: 'Introduction', selection: null };
  const run = new agent.Run({ settings, page, topic, question, history, sources, emit: (e) => e.type === 'trace' && (trace = e.trace) });
  const t0 = Date.now();
  if (!answers) {
    run.visible = null;
    run.current = await wiki.getIndexedPage(lang, title, {});
    if (topic) run.corpus = await topics.corpus(topic);
    await run.hints();
    return { kind, title, question, ok: hit(sources, expected, section), pages: [...new Set(sources.map((s) => s.page))], ms: Date.now() - t0 };
  }
  let answer = '';
  let error = '';
  try {
    answer = await run.run();
  } catch (e) {
    error = e.message;
  }
  const cited = textUtil.citedNumbers(answer).map((n) => sources[n - 1]).filter(Boolean);
  return {
    kind, title, question, error,
    ok: hit(cited, expected, section),
    pages: [...new Set(cited.map((s) => s.page))],
    cited: cited.length,
    calls: trace?.calls.length || 0,
    lookups: trace?.tools.length || 0,
    ms: Date.now() - t0,
  };
}

const counts = new Map();
const results = [];
for (const item of SET) {
  const kind = item[0];
  if (only && !only.includes(kind)) continue;
  counts.set(kind, (counts.get(kind) || 0) + 1);
  if (counts.get(kind) > limit) continue;
  const r = await one(item).catch((e) => ({ kind, title: item[1], question: item[2], ok: false, pages: [], ms: 0, error: e.message }));
  results.push(r);
  const extra = answers ? ` | ${r.cited} cited, ${r.calls} model calls, ${r.lookups} lookups, ${(r.ms / 1000).toFixed(1)} s` : '';
  console.log(`${r.ok ? 'HIT ' : 'MISS'} ${kind.padEnd(5)} ${r.title}: ${r.question}\n       ${answers ? 'cited' : 'read ahead'}: ${r.pages.join('; ') || '(nothing)'}${extra}${r.error ? ` | ERROR ${r.error}` : ''}`);
}

console.log(`\n${answers ? 'Answers that cite an expected article' : 'Questions with an expected article read ahead'}:`);
const kinds = [...new Set(results.map((r) => r.kind))];
const avg = (list, key) => (list.reduce((n, r) => n + (r[key] || 0), 0) / Math.max(1, list.length)).toFixed(1);
for (const kind of [...kinds, 'all']) {
  const list = kind === 'all' ? results : results.filter((r) => r.kind === kind);
  const more = answers ? `   ${avg(list, 'cited')} cited, ${avg(list, 'calls')} model calls, ${(Number(avg(list, 'ms')) / 1000).toFixed(1)} s on average` : '';
  console.log(`  ${kind.padEnd(6)} ${list.filter((r) => r.ok).length}/${list.length}${more}`);
}
if (arg('out')) writeFileSync(arg('out'), JSON.stringify({ answers, results }, null, 2));
