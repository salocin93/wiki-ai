// Small text helpers shared by the service worker, the panel and the options page.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Citations in model text: [3], [2, 5], [Source 3] and 【3】.
const CITE = /(?:\[|【)\s*(?:sources?\s*)?(\d{1,3}(?:\s*[,;]\s*(?:sources?\s*)?\d{1,3})*)\s*(?:\]|】)/gi;

// The source numbers cited in a text, each once, in order of first use.
const citedNumbers = (text) => [...new Set([...(text || '').matchAll(CITE)].flatMap((m) => m[1].match(/\d+/g).map(Number)))];

// Markdown emphasis and code marks removed, for text shown plainly (question buttons, spoken announcements).
const plain = (t) =>
  t
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1');

const articleUrl = (lang, title) => `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;

export const textUtil = { esc, CITE, citedNumbers, plain, articleUrl };
