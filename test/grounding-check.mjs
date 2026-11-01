// Checks lib/grounding.js on answers seen from real models: node test/grounding-check.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

vm.runInThisContext(readFileSync(new URL('../lib/grounding.js', import.meta.url), 'utf8'), { filename: 'grounding.js' });
const G = globalThis.WikiAI.grounding;

const seen = `[1] Ada Lovelace › Introduction
Augusta Ada King, Countess of Lovelace (née Byron; 10 December 1815 – 27 November 1852) was an English mathematician. She married William King in 1835. King was made Earl of Lovelace in 1838. In 1843 she translated an article by Luigi Menabrea. Neoclassicism. Nobel Prize.`;
const exempt = 'Whom did Ada Lovelace marry? Ada Lovelace';
const flags = (answer, opts = {}) => G.check(answer, seen, { exempt, ...opts }).map((f) => (f.missing.length ? f.missing.join(',') : 'uncited'));

const cases = [
  // [answer, expected flags (missing details, or "uncited"), name]
  ['Ada Lovelace married **William King** in 1835 [1]. He became Earl of Lovelace in 1838 [1].', [], 'supported'],
  ['She married William King in 1835 [1]. They moved to Paris in 1799 and met Charles Dickens [1].', ['1799,Paris,Charles,Dickens'], 'invented details'],
  ['She married William King in 1835.\n\n- Her translation of Menabrea appeared in 1843 [1].', ['uncited'], 'no citation'],
  ['She was 40 years old when she died [1].', ['40'], 'wrong age'],
  ['She was 36 years old when she died.\n\nShe was born in 1815 and died in 1852 [1].', [], 'age worked out from years'],
  ['In the 20th century, she married William King [1].', [], 'century'],
  ['*   **Identity and Lineage:** Augusta Ada King was born in 1815 [1].', [], 'bold label, colon inside'],
  ['*   **Vision of Computing**: Unlike many, Lovelace translated Menabrea [1].', [], 'first word after a label'],
  ['*   **University of Bern (1799–1815):** She lectured there [1].', ['1799'], 'years in a label still count'],
  ['**Political and Ideological Factors**\n- **Social Factors**\n* She married William King in 1835 [1].', [], 'bold-only heading lines'],
  ['She won the Nobel Prizes:\n1. **Physics** [1]', [], 'list introduction'],
  ['It shaped the Neoclassical style [1].', [], 'word form differs from the source'],
  ["The sources don't say whether she met Dickens.", [], 'name from the question', { exempt: `${exempt} Did she meet Dickens?` }],
  [
    'Sie heiratete Wilhelm König im Jahr 1835, nachdem sie einander kennengelernt hatten [1]. Später wurde er zum Grafen von Lovelace ernannt, nämlich 1838 [1]. Ihre bekannteste Arbeit war eine Übersetzung eines Artikels von Menabrea [1].',
    [],
    'translated answer: numbers only',
  ],
  ['She was born c. 1815 [1]. St. James was nearby [1].', ['James'], 'abbreviations don\'t end sentences'],
];

let failed = 0;
for (const [answer, expected, name, opts] of cases) {
  try {
    assert.deepEqual(flags(answer, opts), expected);
    console.log(`ok   ${name}`);
  } catch {
    failed++;
    console.log(`FAIL ${name}: got ${JSON.stringify(flags(answer, opts))}, expected ${JSON.stringify(expected)}`);
  }
}
process.exit(failed ? 1 : 0);
