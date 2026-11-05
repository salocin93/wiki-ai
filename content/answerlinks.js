// Links in answers, as Wikipedia has them: the first mention of an article becomes a link to it. Found by matching
// titles in the finished answer, so the model can't invent a link, and no request is spent.
const MAX_LINKS = 8;

const short = (title) => title.replace(/ \([^)]*\)$/, '');
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blank = (m) => ' '.repeat(m.length);

// Where a link must not go: headings, code, citations, formulas already taken out, and mentions of the article itself
// (or "World War" would link inside "World War I").
function masked(text, self) {
  let out = text
    .replace(/^#{1,6}\s.*$/gm, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/\[[^\]\n]*\]|【[^】\n]*】/g, blank)
    .replace(/\d+/g, blank);
  if (self) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(short(self))}(?![\\p{L}\\p{N}])`, 'gu'), blank);
  return out;
}

// One article per name: "Treaty of Versailles" beats "Treaty of Versailles (1871)", and a bracketed title only
// counts by its short name when nothing else has that name.
function named(candidates, self) {
  const groups = new Map();
  for (const c of candidates) {
    const name = short(c.title);
    if (name === short(self || '')) continue;
    // "Bolsonaro" on Jair Bolsonaro's article is the article's own subject, not the family-name page it links to.
    if (!/\s/.test(name) && short(self || '').split(/\s+/).includes(name)) continue;
    if (!groups.has(name)) groups.set(name, []);
    if (!groups.get(name).some((x) => x.title === c.title)) groups.get(name).push(c);
  }
  const out = [];
  for (const [name, list] of groups) {
    const article = list.find((c) => c.title === name) || (list.length === 1 ? list[0] : null);
    if (article) out.push({ name, article });
  }
  return out.sort((a, b) => b.name.length - a.name.length);
}

const capital = (word) => /^\p{Lu}/u.test(word || '');

// A single word is only safe mid-sentence and on its own: "Church" opening a sentence is just a word, and "Kwame" in
// "Zohran Kwame Mamdani", "Kwame's Kolumnalu" or "Church of England" is part of a longer name.
function standsAlone(text, start, end) {
  const before = text.slice(0, start).replace(/[\s*_"“(]+$/, '');
  if (!before || /[.!?:;\n--]$/.test(before)) return false;
  const previous = before.match(/[\p{L}\p{N}'’.-]+$/u)?.[0];
  const after = text.slice(end);
  const next = after.match(/^(?:['’]s)?\s+(?:(?:of|the|de|von|van)\s+)?([\p{L}\p{N}'’.-]+)/u)?.[1];
  return !capital(previous) && !capital(next);
}

// Where each article is first mentioned: [{start, end, title, lang}] in reading order. Whole words only. Titles are
// matched as written, apart from the first letter of a title of several words ("trench warfare").
function spans(text, candidates, self = '') {
  const clear = masked(text, self);
  const taken = [];
  for (const { name, article } of named(candidates, self)) {
    const words = name.split(/\s+/).length;
    if (words === 1 && (name.length < 4 || !capital(name))) continue;
    const first = words > 1 && /^\p{L}/u.test(name) ? `[${escapeRe(name[0].toLowerCase())}${escapeRe(name[0].toUpperCase())}]${escapeRe(name.slice(1))}` : escapeRe(name);
    for (const m of clear.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${first}(?![\\p{L}\\p{N}])`, 'gu'))) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some((x) => start < x.end && x.start < end)) continue;
      if (words === 1 && !standsAlone(clear, start, end)) continue;
      taken.push({ start, end, title: article.title, lang: article.lang });
      break;
    }
  }
  return taken.sort((a, b) => a.start - b.start).slice(0, MAX_LINKS);
}

// The articles an answer should link to, to save with it.
function find(text, candidates, self = '') {
  return spans(text, candidates, self).map(({ title, lang }) => ({ title, lang }));
}

export const answerLinks = { find, spans, MAX_LINKS };
