// Runs the agent outside the browser: node test/agent-cli.mjs "Article title" "question" [model]
// Reads LITELLM_MASTER_KEY (or LOCAL_LLM_API_KEY) from the environment.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pageLinks } from './page-links.mjs';

for (const f of ['settings', 'cache', 'bm25', 'wiki', 'llm', 'links', 'agent']) {
  vm.runInThisContext(readFileSync(new URL(`../lib/${f}.js`, import.meta.url), 'utf8'), { filename: `${f}.js` });
}
const W = globalThis.WikiAI;
const [title = 'Ada Lovelace', question = 'Who was her mother and what did she do?', model] = process.argv.slice(2);
const lang = 'en';

const links = await pageLinks(lang, title);

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
