// Checks lib/grounding.js on answers seen from real models: node test/grounding-check.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

vm.runInThisContext(readFileSync(new URL('../lib/text.js', import.meta.url), 'utf8'), { filename: 'text.js' });
vm.runInThisContext(readFileSync(new URL('../lib/grounding.js', import.meta.url), 'utf8'), { filename: 'grounding.js' });
const G = globalThis.WikiAI.grounding;

const seen = `[1] Ada Lovelace › Introduction
Augusta Ada King, Countess of Lovelace (née Byron; 10 December 1815 – 27 November 1852) was an English mathematician. She married William King in 1835. King was made Earl of Lovelace in 1838. In 1843 she translated an article by Luigi Menabrea. Neoclassicism. Nobel Prize.
[2] Iran–Iraq War › Introduction
Iraq feared that Shia unrest would spread under Sunni rule. Iran and the United States clashed in the Gulf. France sold Exocet missiles. Reagan was elected in 1980.`;
const exempt = 'Whom did Ada Lovelace marry? Ada Lovelace';
const flags = (answer, opts = {}) => G.check(answer, seen, { exempt, ...opts }).map((f) => f.missing.join(','));

const cases = [
  // [answer, expected flags (the missing details of each flagged sentence), name]
  ['Ada Lovelace married **William King** in 1835 [1]. He became Earl of Lovelace in 1838 [1].', [], 'supported'],
  ['She married William King in 1835 [1]. They moved to Paris in 1799 and met Charles Dickens [1].', ['1799,Paris,Charles,Dickens'], 'invented details'],
  ['She married William King in 1835.\n\n- Her translation of Menabrea appeared in 1843 [1].', [], 'no citation, but every detail is in the sources'],
  ['Iraq was backed by:\n- The United States\n- France\n- North Korea', ['Korea'], 'list of names without citations'],
  ['Tensions rose with the election of Ronald Reagan [2].', [], 'first name before a known surname'],
  ['She met Charles Dickens [1].', ['Charles,Dickens'], 'invented first name and surname'],
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
  ['Shia unrest worried the Sunni-controlled government [2].', [], 'hyphenated word: its parts count'],
  ['The Austro-Prussian war followed [2].', ['Austro,Prussian'], 'invented hyphenated name'],
  ['Iranian and Iraqi forces fought; 37 American sailors died on a ship with French missiles [2].', ['37'], 'nationality words'],
  ['Later, Brazilian ships joined in [2].', ['Brazilian'], 'nationality with no country in the sources'],
];

// With the passages by number, each sentence is checked against the passages it cites: "kind missing,details".
const [p1, p2] = seen.split(/\n(?=\[2\])/).map((t) => t.replace(/^\[\d\] /, ''));
const passages = new Map([[1, p1], [2, p2]]);
const kinds = (answer) => G.check(answer, seen, { exempt, passages }).map((f) => `${f.kind} ${f.missing.join(',')}`.trim());
cases.push(
  ['She married William King in 1835 [1].', [], 'cited passage says it', { passages }],
  ['She married William King in 1835 [2].', ['miscited 1835,William,King'], 'cited to a passage that does not say it', { passages }],
  ['Reagan was elected in 1980 [1][2].', [], 'one of two cited passages says it', { passages }],
  ['She married William King in 1835. King became Earl of Lovelace in 1838 [1].', [], 'covered by the next citation on its line', { passages }],
  ['She married William King in 1835.', ['uncited'], 'no citation anywhere on the line', { passages }],
  ['She married William King in 1835 [9].', ['uncited'], 'a number that is no source counts as none', { passages }],
);

let failed = 0;
for (const [answer, expected, name, opts] of cases) {
  if (opts?.passages) {
    const got = kinds(answer);
    try {
      assert.deepEqual(got, expected);
      console.log(`ok   ${name}`);
    } catch {
      failed++;
      console.log(`FAIL ${name}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    }
    continue;
  }
  try {
    assert.deepEqual(flags(answer, opts), expected);
    console.log(`ok   ${name}`);
  } catch {
    failed++;
    console.log(`FAIL ${name}: got ${JSON.stringify(flags(answer, opts))}, expected ${JSON.stringify(expected)}`);
  }
}
process.exit(failed ? 1 : 0);
