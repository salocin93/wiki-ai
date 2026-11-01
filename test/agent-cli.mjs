// Runs the agent outside the browser: node test/agent-cli.mjs "Article title" "question" [model]
// Reads LLM_API_KEY, and optionally LLM_BASE_URL (default: Gemini), from the environment. THINKING=1 leaves the model's thinking on.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pageLinks } from './page-links.mjs';

for (const f of ['settings', 'cache', 'bm25', 'wiki', 'llm', 'links', 'grounding', 'agent']) {
  vm.runInThisContext(readFileSync(new URL(`../lib/${f}.js`, import.meta.url), 'utf8'), { filename: `${f}.js` });
}
const W = globalThis.WikiAI;
// Print every source check, including the ones that lead to a retry.
const check = W.grounding.check;
W.grounding.check = (...args) => {
  const flagged = check(...args);
  console.log(`[grounding] ${flagged.length ? flagged.map((f) => `\n  - ${W.grounding.note(f)}: "${f.text}"`).join('') : 'all supported'}`);
  return flagged;
};
const [title = 'Ada Lovelace', question = 'Who was her mother and what did she do?', model] = process.argv.slice(2);
const lang = process.env.WIKI_LANG || 'en'; // e.g. WIKI_LANG=de for German Wikipedia

const links = await pageLinks(lang, title);

const settings = { ...W.settings.DEFAULTS, ...(process.env.LLM_BASE_URL ? { baseUrl: process.env.LLM_BASE_URL, fallbackModel: "" } : {}), apiKey: process.env.LLM_API_KEY, ...(model ? { model } : {}), ...(process.env.ANSWER_LANG ? { answerLanguage: process.env.ANSWER_LANG } : {}), ...(process.env.THINKING ? { disableThinking: false } : {}) };
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
    if (e.type === 'done') console.log(`[${ts()}] FOLLOW-UPS:\n${(e.followups || []).map((q) => `  - ${q}`).join('\n') || '  (none)'}`);
  },
});
console.log(`\n[${ts()}] ANSWER:\n${answer}\n`);
const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
for (const n of cited) {
  const s = sources[n - 1];
  console.log(s ? `[${n}] ${s.page} › ${s.section}: ${s.text.slice(0, 90)}…` : `[${n}] INVALID citation`);
}
