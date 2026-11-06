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

// A title whose bracket names which one of several things it is ("Imperial Guard (Russia)", "Treaty of Paris (1763)",
// "Georgia (U.S. state)"). Its bare name ("Imperial Guard") is shared with the others, so a mention of it can't be taken
// for this article. A descriptive bracket ("Mercury (planet)", "Theo van Gogh (art dealer)") is different: the bare name
// is how people write it, and the page they are reading settles which one is meant.
const qualifiedByName = (title) => /\((?:\p{Lu}|\p{N})[^)]*\)$/u.test(title || '');

export const textUtil = { esc, CITE, citedNumbers, plain, articleUrl, qualifiedByName };
