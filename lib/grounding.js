// Checks an answer against what the model was shown, to catch details it filled in from memory.
// Hard details only: numbers and, where they can be compared, names. Each must appear in the sources.
import { textUtil } from './text.js';

const { CITE } = textUtil;
const ABBREV = /(?:^|[\s(])(?:\p{L}{1,2}|Mrs|Rev|Gen|Col|Capt|Sgt|Prof|vs|etc|ca|approx)$/iu; // "c.", "St.", "Dr.", initials

// Markdown table lines. A row is one claim: its cells are read together and it is kept or left out whole.
const isTableRow = (line) => /^\s*\|.*\|/.test(line);
const isTableRule = (line) => /^\s*\|\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/.test(line);

// Sentences of one line, as exact substrings (citations after the full stop stay with their sentence).
function sentences(line) {
  if (isTableRow(line)) return [line];
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

// Ordinary words that are capitalised when they lead a name. The name's other words carry the detail: a passage on
// the fighting at Leipzig backs "Battle of Leipzig" without the word "battle", and "Battle of Hastings" still
// fails on Hastings. Other leading words stay details: "closing in on Paris" doesn't back "Treaty of Paris".
const EVENT_WORD = /^(?:battle|siege|war|campaign|invasion)s?$/i;

// Capitalised words after the first word of the sentence, possessives dropped.
// Hyphenated words count by their parts: "Sunni-controlled" → Sunni, "Franco-Prussian" → Franco, Prussian.
function names(text) {
  const words = text.replace(/[*_`"“”]/g, '').match(/[\p{Lu}][\p{L}\p{M}'’]*\p{L}/gu) || [];
  const first = text.replace(/^[\s*_"“(]+/, '').match(/^[\p{L}\p{M}'’]+/u)?.[0];
  return words
    .filter((w, i) => !(i === 0 && w === first) && w.length > 2)
    .map((w) => w.replace(/['’]s$/, ''))
    .filter((w) => !EVENT_WORD.test(w));
}

// Nationality words whose country is spelled differently. Regular ones (Iranian, Iraqi, Chinese) are found by their stem.
const COUNTRY = {
  __proto__: null, // an answer's word "Constructor" is looked up here
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
// The same the other way round: a passage saying "French" backs "France". Also the country's other names.
const PLACE = { __proto__: null, 'united kingdom': ['britain'], britain: ['united kingdom'], 'united states': ['america', 'u.s.'] };
for (const [demonym, places] of Object.entries(COUNTRY)) for (const p of places) (PLACE[p] ||= []).push(demonym);
const TWO_WORD_PLACES = Object.keys(PLACE).filter((p) => p.includes(' '));

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
    .filter((l, i, all) => !(isTableRow(l) && isTableRule(all[i + 1] || ''))) // a table's header row names its columns, it claims nothing
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
      if (stem !== l && stem.length >= 4 && text.includes(stem)) return true; // Iranian → Iran
      return [...(COUNTRY[l.replace(/s$/, '')] || []), ...(PLACE[l] || [])].some((c) => text.includes(c));
    };
    // A first name counts when the surname after it is there ("Ronald Reagan", the text says "Reagan").
    const givenName = (w) => {
      const next = x.bare.match(new RegExp(`\\b${w}\\s+([\\p{Lu}][\\p{L}\\p{M}'’]*\\p{L})`, 'u'))?.[1];
      return !!next && inText(next);
    };
    // "French Empire" says no more than "France" when the name before "Empire" is there.
    const stateOf = (w) => {
      const before = /^empire$/i.test(w) && x.bare.match(/([\p{Lu}][\p{L}\p{M}'’]*\p{L})\s+Empire\b/u)?.[1];
      return !!before && inText(before);
    };
    // "United Kingdom" as a whole, when the text calls it Britain.
    const lower = x.bare.toLowerCase();
    const place = TWO_WORD_PLACES.filter((p) => lower.includes(p) && PLACE[p].some((a) => text.includes(a))).flatMap((p) => p.split(' '));
    const namedElsewhere = (w) => place.includes(w.toLowerCase());
    return [...new Set([...x.nums.filter((n) => !textNums.has(n)), ...(useNames ? x.caps.filter((w) => !inText(w) && !givenName(w) && !stateOf(w) && !namedElsewhere(w)) : [])])];
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

// The answer without the given sentences (exact substrings of it), and without list items or spaces they leave
// behind. A table row goes with its line, so the rest stays one table; a table with no rows left goes whole.
function withoutSentences(answer, texts) {
  let out = answer;
  const rows = new Set(texts.filter(isTableRow).map((t) => t.trim()));
  for (const t of texts) if (!isTableRow(t)) out = out.replace(t, '');
  const lines = out.split('\n').filter((l) => !rows.has(l.trim()));
  const noRows = (i) => !isTableRow(lines[i] || '');
  const kept = rows.size ? lines.filter((l, i) => !(isTableRule(l) && noRows(i + 1)) && !(isTableRule(lines[i + 1] || '') && noRows(i + 2))) : lines;
  return kept
    .map((l) => l.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, ''))
    .filter((l) => !/^\s*(?:[-*•]|\d+[.)])\s*$/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// A rewrite that opens by saying what it is doing ("Let's check the passages for each battle."), without that line.
// English only. The first paragraph must announce a check of the sources, so an answer's own opening stays.
const CHECK_TALK = /^(?:let['’]s|let me|i['’]ll|i will|i need to|i should|i must|now,? i)\b.*\b(?:check|verify|confirm|review|examine|go through|look (?:at|through))\b.*\b(?:passages?|sources?|citations?|backing|backed|supported)\b[^\n]*$/i;
function withoutCheckTalk(text) {
  const first = text.trimStart().split(/\n\s*\n/)[0];
  const rest = text.trimStart().slice(first.length).trim();
  return CHECK_TALK.test(first) && /[\p{L}\p{N}]/u.test(rest) ? rest : text;
}

export const grounding = { check, note, sentences, cited, withoutSentences, withoutCheckTalk };
