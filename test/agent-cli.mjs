// Runs the agent outside the browser: node test/agent-cli.mjs "Article title" "question" [model]
// Reads LITELLM_MASTER_KEY (or LOCAL_LLM_API_KEY) from the environment.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const f of ['settings', 'cache', 'bm25', 'wiki', 'llm', 'agent']) {
  vm.runInThisContext(readFileSync(new URL(`../lib/${f}.js`, import.meta.url), 'utf8'), { filename: `${f}.js` });
}
const W = globalThis.WikiAI;
const [title = 'Ada Lovelace', question = 'Who was her mother and what did she do?', model] = process.argv.slice(2);
const lang = 'en';

// The extension gets links with context sentences from the page DOM; here we only have titles.
const res = await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&prop=links&pllimit=max&plnamespace=0&format=json&formatversion=2&origin=*&titles=${encodeURIComponent(title)}`);
// Approximate the DOM's context sentences: the first sentence of the article text that mentions the title.
const { chunks } = await W.wiki.getIndexedPage(lang, title);
const sentences = chunks.flatMap((c) => c.text.match(/[^.!?]+[.!?]+/g) || []);
const links = ((await res.json()).query.pages[0].links || []).map((l) => {
  const name = l.title.replace(/ \(.*\)$/, '');
  return { title: l.title, count: 1, context: (sentences.find((x) => x.includes(name)) || '').trim(), sections: [] };
});

const settings = { ...W.settings.DEFAULTS, apiKey: process.env.LOCAL_LLM_API_KEY || process.env.LITELLM_MASTER_KEY, ...(model ? { model } : {}) };
const sources = [];
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const answer = await W.agent.run({
  settings,
  page: { lang, title, links, visibleSection: 'Introduction', selection: null },
  question,
  history: [],
  sources,
  emit: (e) => {
    if (e.type === 'status' || e.type === 'step') console.log(`[${ts()}] ${e.type}: ${e.text}`);
    if (e.type === 'error') console.log('ERROR', e.message);
  },
});
console.log(`\n[${ts()}] ANSWER:\n${answer}\n`);
const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
for (const n of cited) {
  const s = sources[n - 1];
  console.log(s ? `[${n}] ${s.page} › ${s.section}: ${s.text.slice(0, 90)}…` : `[${n}] INVALID citation`);
}
