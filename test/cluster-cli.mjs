// Builds a topic cluster outside the browser, then optionally asks a question about it:
//   node test/cluster-cli.mjs "House of Oldenburg" [model] ["question"]
// Reads LITELLM_MASTER_KEY (or LOCAL_LLM_API_KEY) from the environment. Link signals are approximated from the
// article HTML with regexes; the extension reads them from the real DOM.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const f of ['settings', 'cache', 'bm25', 'wiki', 'llm', 'agent', 'topics', 'cluster']) {
  vm.runInThisContext(readFileSync(new URL(`../lib/${f}.js`, import.meta.url), 'utf8'), { filename: `${f}.js` });
}
const W = globalThis.WikiAI;
const [title = 'House of Oldenburg', model, question] = process.argv.slice(2);
const lang = 'en';

const strip = (h) => h.replace(/<sup[\s\S]*?<\/sup>/g, '').replace(/<[^>]+>/g, '').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim();

async function pageLinks() {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=parse&prop=text&formatversion=2&format=json&origin=*&page=${encodeURIComponent(title)}`;
  const html = (await (await fetch(url)).json()).parse.text;
  const navStart = html.search(/<div[^>]*class="navbox/);
  const info = html.match(/<table class="infobox[\s\S]*?<\/table>/)?.index ?? -1;
  const infoEnd = info >= 0 ? info + html.slice(info).indexOf('</table>') : -1;
  const map = new Map();
  let section = 'Introduction';
  const re = /<h[234][^>]*>([\s\S]*?)<\/h[234]>|<a href="\/wiki\/([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (let m; (m = re.exec(html)); ) {
    if (m[1] !== undefined) {
      section = strip(m[1]);
      continue;
    }
    const target = decodeURIComponent(m[2]).replace(/_/g, ' ');
    if (/^[A-Za-z ]+:/.test(target) || target === title) continue;
    const at = m.index;
    const signals = [];
    if (navStart >= 0 && at > navStart) signals.push('navbox');
    if (info >= 0 && at > info && at < infoEnd) signals.push('infobox');
    const blockStart = Math.max(html.lastIndexOf('<p>', at), html.lastIndexOf('<li', at), html.lastIndexOf('<div role="note"', at));
    const block = html.slice(blockStart, html.indexOf('</', at + m[0].length) + 400);
    const text = strip(block).slice(0, 220);
    if (html.slice(blockStart, blockStart + 40).includes('role="note"') && /^Main articles?/i.test(text)) signals.push('main');
    const e = map.get(target) || { title: target, count: 0, context: '', sections: [], anchors: [], signals: [] };
    e.count++;
    e.context ||= signals.includes('navbox') ? 'Navigation box' : text;
    if (!signals.includes('navbox') && !e.sections.includes(section)) e.sections.push(section);
    for (const s of signals) if (!e.signals.includes(s)) e.signals.push(s);
    map.set(target, e);
  }
  return [...map.values()];
}

const settings = { ...W.settings.DEFAULTS, apiKey: process.env.LOCAL_LLM_API_KEY || process.env.LITELLM_MASTER_KEY, ...(model ? { model } : {}) };
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const links = await pageLinks();
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
