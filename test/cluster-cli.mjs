// Builds a topic cluster outside the browser, then optionally asks a question about it:
//   node test/cluster-cli.mjs "House of Oldenburg" [model] ["question"]
// Reads LLM_API_KEY, and optionally LLM_BASE_URL (default: Gemini), from the environment. Link signals are approximated from the
// article HTML with regexes; the extension reads them from the real DOM.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const f of ['settings', 'storage', 'cache', 'bm25', 'tables', 'wiki', 'llm', 'links', 'grounding', 'agent', 'topics', 'cluster']) {
  vm.runInThisContext(readFileSync(new URL(`../lib/${f}.js`, import.meta.url), 'utf8'), { filename: `${f}.js` });
}
const W = globalThis.WikiAI;
const [title = 'House of Oldenburg', model, question] = process.argv.slice(2);
const lang = 'en';

import { pageLinks } from './page-links.mjs';

const settings = { ...W.settings.DEFAULTS, ...(process.env.LLM_BASE_URL ? { baseUrl: process.env.LLM_BASE_URL, fallbackModel: "" } : {}), apiKey: process.env.LLM_API_KEY, ...(model ? { model } : {}), ...(process.env.ANSWER_LANG ? { answerLanguage: process.env.ANSWER_LANG } : {}) };
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const links = await pageLinks(lang, title);
console.log(`[${ts()}] ${links.length} links, ${links.filter((l) => l.signals.includes('navbox')).length} in navboxes`);
const emit = (e) => e.text && console.log(`[${ts()}] ${e.text}`);

const topic = await W.cluster.build({ settings, page: { lang, title, links, categories: [] }, emit });
console.log(`\n[${ts()}] TOPIC "${topic.name}": ${topic.pages.length} articles, ${topic.edges.length} links between them`);
for (const f of topic.facets) {
  console.log(`\n## ${f.name}${f.why ? ` — ${f.why}` : ''}`);
  for (const p of topic.pages.filter((x) => x.facet === f.name)) console.log(`  - ${p.title}${p.description ? ` (${p.description})` : ''}`);
}

if (question) {
  const sources = [];
  console.log(`\nQUESTION: ${question}`);
  const answer = await W.agent.run({
    settings, topic, question, history: [], sources,
    page: { lang, title, links, visibleSection: 'Introduction', selection: null },
    emit: (e) => (e.type === 'status' || e.type === 'step') && !/Reading topic articles \(\d+\/\d+\)/.test(e.text || '') && console.log(`[${ts()}] ${e.text}`),
  });
  console.log(`\n[${ts()}] ANSWER:\n${answer}\n`);
  const cited = [...new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))];
  for (const n of cited) {
    const s = sources[n - 1];
    console.log(s ? `[${n}] ${s.page} › ${s.section}` : `[${n}] INVALID`);
  }
}
