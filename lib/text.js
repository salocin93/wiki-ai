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

// Model text without em dashes (or their cousin, the horizontal bar). Asking isn't enough: models overuse them and copy
// them from the passages. Each becomes what the sentence needs: mostly a comma, an en dash between numbers.
const noLongDash = (text) =>
  (text || '').replace(/[ \t]*[—―]+[ \t]*/g, (match, at, all) => {
    const line = all.slice(all.lastIndexOf('\n', at - 1) + 1, at);
    const before = line.slice(-1);
    const after = all.charAt(at + match.length);
    if (before === '|' && after === '|') return ' - '; // a table's empty cell
    if (!line.trim() || !after || after === '\n') return ''; // opens or ends the line
    if (/\d/.test(before) && /\d/.test(after)) return '–'; // a range: 1803—1815
    if (/^\s*(?:[-*•]\s+|\d+[.)]\s+)?\*\*[^*]+\*\*$/.test(line)) return ': '; // **Term** — what it is
    if (/[.,;:!?]/.test(before)) return ' ';
    if (/[.,;:!?)]/.test(after)) return '';
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(before)) return '，';
    return ', ';
  });

const articleUrl = (lang, title) => `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;

// A title whose bracket names which one of several things it is ("Imperial Guard (Russia)", "Treaty of Paris (1763)",
// "Georgia (U.S. state)"). Its bare name ("Imperial Guard") is shared with the others, so a mention of it can't be taken
// for this article. A descriptive bracket ("Mercury (planet)", "Theo van Gogh (art dealer)") is different: the bare name
// is how people write it, and the page they are reading settles which one is meant.
const qualifiedByName = (title) => /\((?:\p{Lu}|\p{N})[^)]*\)$/u.test(title || '');

export const textUtil = { esc, CITE, citedNumbers, plain, noLongDash, articleUrl, qualifiedByName };
