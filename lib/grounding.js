// Checks an answer against what the model was shown, to catch details it filled in from memory.
// Hard details only: numbers and, where they can be compared, names. Each must appear in the sources.
import { textUtil } from './text.js';

const { CITE } = textUtil;
const ABBREV = /(?:^|[\s(])(?:\p{L}{1,2}|Mrs|Rev|Gen|Col|Capt|Sgt|Prof|vs|etc|ca|approx)$/iu; // "c.", "St.", "Dr.", initials

// Sentences of one line, as exact substrings (citations after the full stop stay with their sentence).
function sentences(line) {
  const out = [];
  const re = /[.!?]["”’)]*((?:\s*(?:\[[^\]]*\]|【[^】]*】))*)\s+(?=["“(*]*[\p{Lu}\d])/gu;
  let start = 0;
  for (const m of line.matchAll(re)) {
    if (ABBREV.test(line.slice(start, m.index))) continue;
    const end = m.index + m[0].trimEnd().length;
    out.push(line.slice(start, end));
    start = m.index + m[0].length;
  }
  if (line.slice(start).trim()) out.push(line.slice(start));
  return out;
}

// "1,835" and "1.835" (thousands) read as 1835; single digits are too often written out to compare.
const numbers = (text) =>
  (text.match(/\d+(?:[.,]\d+)*/g) || [])
    .map((n) => n.replace(/[.,](?=\d{3}(?!\d))/g, ''))
    .filter((n) => n.replace(/\D/g, '').length > 1);

// Capitalised words after the first word of the sentence, possessives dropped.
// Hyphenated words count by their parts: "Sunni-controlled" → Sunni, "Franco-Prussian" → Franco, Prussian.
function names(text) {
  const words = text.replace(/[*_`"“”]/g, '').match(/[\p{Lu}][\p{L}\p{M}'’]*\p{L}/gu) || [];
  const first = text.replace(/^[\s*_"“(]+/, '').match(/^[\p{L}\p{M}'’]+/u)?.[0];
  return words
    .filter((w, i) => !(i === 0 && w === first) && w.length > 2)
    .map((w) => w.replace(/['’]s$/, ''));
}

// Nationality words whose country is spelled differently. Regular ones (Iranian, Iraqi, Chinese) are found by their stem.
const COUNTRY = {
  american: ['united states', 'america', 'u.s.'],
  british: ['britain', 'united kingdom', 'england'],
  english: ['england', 'britain'],
  french: ['france'],
  dutch: ['netherlands', 'holland'],
  german: ['germany'],
  soviet: ['soviet union', 'ussr'],
  swiss: ['switzerland'],
  spanish: ['spain'],
  greek: ['greece'],
  danish: ['denmark'],
  swedish: ['sweden'],
  norwegian: ['norway'],
  polish: ['poland'],
  finnish: ['finland'],
  irish: ['ireland'],
  scottish: ['scotland'],
  welsh: ['wales'],
  portuguese: ['portugal'],
  filipino: ['philippines'],
  peruvian: ['peru'],
};
const DEMONYM = /(?:ians?|ans?|ese|ish|is?|ic|s)$/;

// answer: the model's markdown. seen: everything the model was given (sources, tool results, questions).
// exempt: text whose words never need a source (the question, the article title).
// passages: Map(source number → its text). With it, each sentence is also checked against the passages it
// cites (or, without a citation of its own, the next citation on its line), not only against everything.
// Returns the sentences to flag: { text, missing: [...], kind }, kind being
//   'missing'   details that are in no source,
//   'miscited'  details that are in the sources, but not in the passages the sentence cites,
//   'uncited'   a sentence with details but no citation (only with passages; not worth a rewrite).
function check(answer, seen, { exempt = '', compareNames = true, passages = null } = {}) {
  const hay = seen.toLowerCase();
  const hayNums = new Set(numbers(seen));
  const free = new Set([...numbers(exempt), ...names(exempt).map((w) => w.toLowerCase()), ...exempt.toLowerCase().split(/[^\p{L}\p{N}]+/u)]);
  const lines = answer
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''))
    .filter((l) => l.trim() && !/^#{1,6}\s/.test(l) && !/^\*\*[^*]+\*\*:?\s*$/.test(l.trim())); // headings, "**Causes**" lines too
  // Ages and spans worked out from two years in the answer ("36 years old", born 1815, died 1852).
  const years = (answer.match(/\b1\d{3}\b|\b20\d{2}\b/g) || []).map(Number);
  const span = (n) => n < 150 && years.some((a) => years.some((b) => b - a === Number(n) || b - a === Number(n) + 1));
  // Sums and differences of two sourced numbers in the answer ("22.59 − 21.45 = 1.14", "5 + 4 titles").
  const sourced = [...new Set(numbers(answer.replace(CITE, ' ')))].filter((n) => hayNums.has(n)).map(Number);
  const worked = (n) => {
    const v = Number(n.replace(',', '.'));
    return sourced.some((a) => sourced.some((b) => Math.abs(Math.abs(a - b) - v) < 1e-9 || Math.abs(a + b - v) < 1e-9));
  };

  const items = [];
  const citesIn = (text) => [...cited(text)].filter((n) => passages?.has(n));
  for (const line of lines) {
    // A bold label ("**Identity and Lineage:**") is a heading, not a claim: its years count, its words don't.
    const label = line.match(/^\*\*[^*]+(?::\*\*|\*\*\s*:)/)?.[0] || '';
    const labelWords = new Set(names(` ${label}`).map((w) => w.toLowerCase()));
    const inLine = [];
    for (const text of sentences(line)) {
      // Centuries are worked out from years: "20th century", "20. Jahrhundert".
      const bare = text.replace(CITE, ' ').replace(/\b\d{1,2}(?:st|nd|rd|th)[\s-]+centur|\b\d{1,2}\.\s*Jahrhundert/gi, ' ');
      const nums = numbers(bare).filter((n) => !free.has(n) && !span(n) && !worked(n));
      const caps = names(bare.replace(label, '')).filter((w) => !free.has(w.toLowerCase()) && !labelWords.has(w.toLowerCase()));
      inLine.push({ text, bare, nums, caps, cites: citesIn(text) });
    }
    // A sentence without a citation is covered by the next one on its line ("A. B [3].").
    inLine.forEach((x, i) => {
      if (!x.cites.length) x.cites = inLine.slice(i + 1).find((y) => y.cites.length)?.cites || [];
    });
    items.push(...inLine);
  }

  // A translated answer can't be compared word for word with the sources: then only numbers count.
  // Ordinary words tell: in the sources' language most of them appear somewhere in what the model read.
  const words = [...new Set(answer.replace(CITE, ' ').match(/(?<![\p{L}])[\p{Ll}]{4,}(?![\p{L}])/gu) || [])];
  const known = words.filter((w) => hay.includes(w)).length;
  const useNames = compareNames && (words.length < 5 || known / words.length >= 0.6);

  // The details of a sentence that a text (lowercased) doesn't contain.
  const absent = (x, text, textNums) => {
    const inText = (w) => {
      const l = w.toLowerCase();
      if (text.includes(l.slice(0, Math.max(5, l.length - 3)))) return true; // "Prizes", "Neoclassical" → "Neoclassicism"
      const stem = l.replace(DEMONYM, '');
      return (stem !== l && stem.length >= 4 && text.includes(stem)) || (COUNTRY[l.replace(/s$/, '')] || []).some((c) => text.includes(c)); // Iranian → Iran
    };
    // A first name counts when the surname after it is there ("Ronald Reagan", the text says "Reagan").
    const givenName = (w) => {
      const next = x.bare.match(new RegExp(`\\b${w}\\s+([\\p{Lu}][\\p{L}\\p{M}'’]*\\p{L})`, 'u'))?.[1];
      return !!next && inText(next);
    };
    return [...new Set([...x.nums.filter((n) => !textNums.has(n)), ...(useNames ? x.caps.filter((w) => !inText(w) && !givenName(w)) : [])])];
  };

  const flagged = [];
  for (const x of items) {
    const missing = absent(x, hay, hayNums);
    if (missing.length) {
      flagged.push({ text: x.text.trim(), missing, kind: 'missing' });
      continue;
    }
    if (!passages || (!x.nums.length && !x.caps.length)) continue;
    if (!x.cites.length) {
      // Its details are in the sources, so no rewrite; the reader still sees it has no source.
      flagged.push({ text: x.text.trim(), missing: [], kind: 'uncited' });
      continue;
    }
    const cited = x.cites.map((n) => passages.get(n)).join('\n');
    const notThere = absent(x, cited.toLowerCase(), new Set(numbers(cited)));
    if (notThere.length) flagged.push({ text: x.text.trim(), missing: notThere, kind: 'miscited', cites: x.cites });
  }
  return flagged;
}

// What the reader sees on hover.
const note = (f) =>
  f.kind === 'uncited'
    ? 'No source given for this sentence'
    : f.kind === 'miscited'
      ? `The cited source doesn't mention: ${f.missing.join(', ')}`
      : `Not found in the Wikipedia sources: ${f.missing.join(', ')}`;

// The source numbers a text cites.
function cited(text) {
  return new Set(textUtil.citedNumbers(text));
}

export const grounding = { check, note, sentences, cited };
