// Section names at the end of an article (references, external links, "See also"), in the languages Wikipedia is
// most read in. Shared by the service worker (which leaves these sections out of the searchable text) and the
// content script (where links in them don't count as mentions in the article's own text).
// Reference lists and links out: never searched or cited.
const SKIPPED = [
  // en
  'references', 'external links', 'notes', 'further reading', 'bibliography', 'sources', 'citations', 'footnotes',
  'notes and references', 'works cited', 'general and cited references', 'general references', 'literature',
  'primary sources', 'secondary sources',
  // de
  'einzelnachweise', 'weblinks', 'literatur', 'anmerkungen', 'quellen', 'fußnoten', 'belege', 'weiterführende literatur',
  // fr
  'références', 'notes et références', 'liens externes', 'bibliographie', 'sources', 'articles connexes',
  // es
  'referencias', 'enlaces externos', 'bibliografía', 'notas', 'fuentes', 'notas y referencias',
  // it
  'note', 'bibliografia', 'collegamenti esterni', 'fonti',
  // nl
  'referenties', 'externe links', 'bronnen', 'noten', 'literatuur', 'bronnen, noten en/of referenties',
  // pt
  'referências', 'ligações externas', 'notas e referências', 'fontes',
  // pl, sv, da, nb, fi, cs
  'przypisy', 'linki zewnętrzne', 'referenser', 'externa länkar', 'källor', 'noter', 'eksterne henvisninger',
  'litteratur', 'eksterne lenker', 'lähteet', 'aiheesta muualla', 'kirjallisuutta', 'odkazy', 'reference', 'externí odkazy',
  // ru, uk
  'примечания', 'литература', 'ссылки', 'примітки', 'джерела', 'посилання',
];
// Lists of related articles: kept as text, but their links are a list, not mentions.
const SEE_ALSO = ['see also', 'siehe auch', 'voir aussi', 'véase también', 'voci correlate', 'zie ook', 'ver também', 'zobacz też', 'se även', 'se også', 'katso myös', 'viz též', 'см. также', 'див. також'];

const skipped = new Set(SKIPPED);
const backMatter = [...SKIPPED, ...SEE_ALSO];
const lower = (name) => (name || '').trim().toLowerCase();

// A section to leave out of the article's searchable text.
const isSkipped = (name) => skipped.has(lower(name));

// Any end-of-article section, including "See also" ("References and notes" counts by its start).
const isBackMatter = (name) => {
  const n = lower(name);
  return backMatter.some((b) => n === b || (n.startsWith(b) && !/\p{L}/u.test(n[b.length])));
};
const isSeeAlso = (name) => SEE_ALSO.includes(lower(name));

// Which heading the reader is at, given how far each one is from the top of the window, in page order; -1 for none.
// Normally the last one in the top third. But a heading right at the top wins over those below it: that's where a
// link to a section lands, and a short section's next heading ("See also") is often in the top third already.
const TOP_OF_WINDOW_PX = 120; // room for Wikipedia's sticky header
function readingIndex(tops, windowHeight) {
  let current = -1;
  let atTop = -1;
  for (let i = 0; i < tops.length && tops[i] < windowHeight * 0.35; i++) {
    current = i;
    if (tops[i] >= 0 && tops[i] < TOP_OF_WINDOW_PX) atTop = i;
  }
  return atTop >= 0 ? atTop : current;
}

export const sectionNames = { isSkipped, isBackMatter, isSeeAlso, readingIndex, TOP_OF_WINDOW_PX };
