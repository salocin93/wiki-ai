// What kind of subject an article is about (a person, a place, an event …), so the panel can suggest questions
// that fit it. Read from Wikidata: the item's "instance of" (P31) values and the classes above them (P279), which
// works the same for every Wikipedia language. Wikidata is fine-grained ("commune of France", "battle"), so each
// broad type is a few classes high enough in the hierarchy to catch those.
import { cache } from './cache.js';

// In priority order: Paris is both a settlement and a public body, and the settlement wins. "dated" isn't a class:
// it's an item with a point in time or a start time (P585, P580), which tells an event (a fire, an earthquake,
// a space mission) from a process (photosynthesis); both are "occurrences" in Wikidata.
/** @type {Array<[string, string[]]>} */
const TYPES = [
  ['person', ['Q5', 'Q15632617']], // human, fictional human
  ['place', ['Q486972', 'Q56061', 'Q271669', 'Q811979', 'Q82794', 'Q6256', 'Q6999']], // settlement, administrative area, landform, structure, region, country, astronomical object
  ['event', ['Q13418847', 'Q178561', 'Q198', 'Q350604', 'Q3839081', 'Q1656682']], // historical event, battle, war, armed conflict, disaster, planned event
  ['work', ['Q17537576', 'Q47461344', 'Q2188189', 'Q838948']], // creative work, written work, musical work, work of art
  ['religion', ['Q178885', 'Q9174', 'Q24334685']], // deity, religion, mythical entity
  ['group', ['Q43229', 'Q164950', 'Q13417114', 'Q16334295']], // organisation, dynasty, noble family, group of humans
  ['dated', []],
  // Not Wikidata's "concept" itself: nearly everything is one, and walking up that far makes the query slow.
  ['concept', ['Q3249551', 'Q11862829', 'Q2996394', 'Q2465832']], // process, academic discipline, biological process, branch of science
];
const ARTICLE_TYPES = ['person', 'place', 'event', 'work', 'religion', 'group', 'concept', 'other'];

const TIMEOUT_MS = 10_000;
const QID = /^Q\d{1,12}$/;

function sparql(qid) {
  const classes = TYPES.flatMap(([type, ids]) => ids.map((id) => `(wd:${id} "${type}")`)).join(' ');
  // Walk up from the item ("forward"): walking down from a class as broad as "creative work" takes too long.
  return `SELECT DISTINCT ?type WHERE {
    { wd:${qid} wdt:P31 ?c . ?c wdt:P279* ?cls . hint:Prior hint:gearing "forward" . VALUES (?cls ?type) { ${classes} } }
    UNION { wd:${qid} wdt:P585|wdt:P580 ?when . BIND("dated" AS ?type) }
  }`;
}

// The first type in priority order among those the query found ("dated" counts as an event), or 'other'.
function pick(found) {
  const first = TYPES.map(([type]) => type).find((t) => found.includes(t));
  return first === 'dated' ? 'event' : first || 'other';
}

// The type of a Wikidata item, cached like Wikipedia responses. Throws if Wikidata can't be reached, so a failure
// isn't cached; the panel then keeps its general questions.
async function articleType(qid, signal) {
  if (!QID.test(qid || '')) return 'other';
  return cache.wrap(`type1:${qid}`, async () => {
    const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql(qid))}`;
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) throw new Error(`Wikidata returned ${res.status}`);
    const data = await res.json();
    return pick((data.results?.bindings || []).map((b) => b.type?.value));
  });
}

export const articleTypes = { ARTICLE_TYPES, articleType, pick, sparql };
