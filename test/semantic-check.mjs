// Live check of semantic search against real Wikipedia and a real embedding model. Not part of npm test (needs a key or a server).
//   GEMINI_API_KEY=… node test/semantic-check.mjs [article title] [question …]
//   EMBED_URL=http://localhost:11434/v1 EMBED_MODEL=nomic-embed-text EMBED_DOC_PREFIX='search_document: ' EMBED_QUERY_PREFIX='search_query: ' node test/semantic-check.mjs
// Prints, for questions worded differently from the article, what keyword search finds, what meaning finds, and the
// fused result, plus the cosine scores (they tell where MARGIN in lib/embeddings.js should sit for that model).
import { appSettings } from '../lib/settings.js';
import { embeddings } from '../lib/embeddings.js';
import { wiki } from '../lib/wiki.js';

const env = process.env;
const settings = {
  ...appSettings.DEFAULTS,
  semanticSearch: true,
  apiKey: env.GEMINI_API_KEY || '',
  embedBaseUrl: env.EMBED_URL || '',
  embedModel: env.EMBED_MODEL || '',
  embedDocPrefix: env.EMBED_DOC_PREFIX || '',
  embedQueryPrefix: env.EMBED_QUERY_PREFIX || '',
};
if (!embeddings.config(settings) || (!env.EMBED_URL && !env.GEMINI_API_KEY)) {
  console.error('Set GEMINI_API_KEY, or EMBED_URL and EMBED_MODEL.');
  process.exit(1);
}

const title = process.argv[2] || 'Roman concrete';
const QUESTIONS = {
  'Roman concrete': ['why have ancient harbours survived underwater', 'what made the buildings crack-resistant over centuries', 'who wrote about the recipe', 'how did builders cope with earthquakes'],
};
const asked = process.argv.slice(3); // questions after the title replace the built-in ones
const questions = asked.length ? asked : QUESTIONS[title] || ['a question in your own words'];

const entry = await wiki.getIndexedPage('en', title, { html: false });
console.log(`${entry.page.title}: ${entry.chunks.length} passages\n`);
const started = Date.now();
await embeddings.search(entry, 'warm up', settings); // embeds the passages once
console.log(`embedding the passages + one question took ${Date.now() - started} ms\n`);

const show = (label, hits) => console.log(`  ${label}:\n${hits.map((h) => `    ${h.score.toFixed(3)}  ${h.doc.section} — ${h.doc.text.slice(0, 90).replace(/\n/g, ' ')}…`).join('\n') || '    (nothing)'}`);
for (const q of questions) {
  console.log(`Q: ${q}`);
  const keyword = entry.index.search(q, 20);
  const meaning = await embeddings.search(entry, q, settings, { k: 20 });
  show('keywords', keyword.slice(0, 3));
  show('meaning', meaning.slice(0, 3));
  show('fused', embeddings.fuse([keyword, meaning], 3));
  console.log();
}
