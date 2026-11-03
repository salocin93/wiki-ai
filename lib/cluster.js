// Builds a topic cluster from an article: rank real link candidates, let the model group them into themes
// (it picks candidate numbers, so it can't invent titles), then check every title against Wikipedia.
import { appSettings } from './settings.js';
import { linkRank } from './links.js';
import { llm } from './llm.js';
import { topics } from './topics.js';
import { wiki } from './wiki.js';

const MAX_PAGES = 60; // a technical ceiling; the model decides how many articles the subject needs
const TOKENS_PER_CANDIDATE = 45;
const TOKENS_PER_EXTRA = 8; // listed by title only
const estTokens = (s) => appSettings.estTokens(s);

// Every link that matters for the subject, judged against the article's own most important links:
// a focused article yields a few dozen candidates, a broad one well over a hundred.
// maxCandidates only guards the prompt size.
function rankCandidates(links, pageTitle, maxCandidates = 250) {
  const ranked = linkRank.rank(links, pageTitle);
  if (!ranked.length) return [];
  const top = ranked.slice(0, 5);
  const cutoff = Math.max(3, (top.reduce((n, x) => n + x.score, 0) / top.length) * 0.2);
  return ranked
    .filter((x) => x.score >= cutoff)
    .slice(0, maxCandidates)
    .map(({ link, score }) => ({ ...link, score }));
}

// Which linked articles mention the starting article themselves. Broad articles (a whole war, a country) are
// linked often but rarely mention it; the specific ones about its own work (the conference it led, its book)
// may be linked only once yet do. Those once-mentioned ones join as a short titles-only list.
async function linkedBack(lang, links, pageTitle, candidates, maxExtra, signal) {
  const inText = links.filter((l) => l.sections?.length);
  const stats = await wiki.linkStats(lang, [...new Set([...candidates.map((c) => c.title), ...inText.map((l) => l.title)])], pageTitle, signal).catch(() => new Map());
  const statOf = (t) => stats.get(wiki.normTitle(t));
  const kept = stats.size ? candidates.filter((c) => !statOf(c.title)?.disambiguation) : candidates;
  for (const c of kept) if (statOf(c.title)?.linksBack) c.signals = [...(c.signals || []), 'back'];
  const have = new Set(kept.map((c) => c.title));
  const extra = linkRank
    .rank(inText, pageTitle)
    .map(({ link }) => link)
    .filter((l) => {
      const st = statOf(l.title);
      return !have.has(l.title) && st?.linksBack && !st.disambiguation && st.length >= 4000; // stubs rarely help
    })
    .slice(0, maxExtra);
  return { candidates: kept, extra };
}

const articleWords = (current) => current.chunks.reduce((n, c) => n + c.text.split(/\s+/).length, 0);

function prompt(page, current, candidates, extra, settings) {
  const intro = current.chunks.filter((c) => c.section === 'Introduction').map((c) => c.text).join('\n');
  const outline = [...new Set(current.chunks.map((c) => c.section))].join('; ');
  const words = articleWords(current);
  const size = words > 8000 ? 'a long article, so likely a broad subject' : words < 1500 ? 'a short article, so likely a narrow subject' : 'a medium-length article';
  const lines = candidates.map((c, i) => {
    const where = (c.context || c.sections?.join(', ') || '').replace(/\s+/g, ' ').slice(0, 110);
    const tags = (c.signals || []).filter((s) => s !== 'hatnote');
    return `${i + 1}. ${c.title}${where ? ` — ${where}` : ''}${tags.length ? ` [${tags.join(', ')}]` : ''}`;
  });
  return [
    {
      role: 'system',
      content: 'You organize Wikipedia articles into a topic cluster for a reader exploring a subject. You choose only from the numbered candidate articles you are given. You reply with one JSON object and nothing else.',
    },
    {
      role: 'user',
      content: `Starting article: "${current.page.title}"

Introduction:
${intro.slice(0, 2400)}

Sections: ${outline.slice(0, 800)}
Length: about ${Math.round(words / 100) * 100} words, ${size}.
${page.categories?.length ? `Categories: ${page.categories.slice(0, 15).join('; ')}\n` : ''}
Candidate articles: the ${candidates.length} linked articles relevant to it (number. title — where the starting article links to it [navbox = listed in a navigation box, main = a section's main article, infobox = in the fact box, back = its own article mentions "${current.page.title}"]):
${lines.join('\n')}
${
extra.length
  ? `\nMore candidates, linked only once but whose own articles mention "${current.page.title}":\n${extra.map((l, i) => `${candidates.length + i + 1}. ${l.title}`).join('; ')}\n`
  : ''
}
Build a topic cluster around "${current.page.title}":
- Decide how many articles a reader needs to explore this subject well. Include every candidate that is central to it and leave out ones that are only loosely related: a narrow subject may need 8 articles, a broad one 40 or more (never more than ${MAX_PAGES}).
- Group them into as many themes as the subject really has (usually 3 to 8), each named in a few words. Prefer articles about the subject's own people, branches, places, events and ideas; skip generic articles (whole countries, languages, titles like "King", wars, eras, broad fields) unless the subject is mainly about them. Skip journals, publishers, universities, awards and timelines or lists: they are where the subject was published or honoured, not part of it.
- A broad subject (a war, a country, a field) needs its central people, events and consequences, even well-known ones: for a war, its leaders, its decisive battles and invasions, its atrocities and its aftermath.
- Use themes a reader would expect for this kind of article, so similar articles get comparable themes: a scientific concept → theory, discovery and history, applications, related phenomena; a person → life, work, people around them, legacy; an event → causes, course, key people, consequences; a place → geography, history, culture, economy. Put each article under the theme it is mainly about (an aftermath article under consequences, not under the sides involved).
- When a specific article and a broad one cover the same part of the subject, pick the specific one: the conference, treaty, book or reform the subject was part of, not the whole war or era around it. Articles marked "back" or listed under "More candidates" mention the subject themselves, a good sign they cover its own part.
- If an important theme has no fitting candidate, add a short Wikipedia search query for it under "search".
- Say what the topic's articles are mostly about, as "kind": "people" (people and their relations), "family" (a dynasty or family), "events" (wars, revolutions, a chain of events), "places", "works" (books, music, art, films), "ideas" (science, religion, philosophy, concepts), or "mixed" if none of these clearly dominates.

- Write the topic name, theme names and "why" sentences in ${appSettings.languageName(appSettings.answerLanguage(settings, page.lang) || page.lang)}.

Reply with exactly this JSON shape:
{"name": "short topic name", "kind": "people", "facets": [{"name": "theme name", "why": "one short sentence", "pages": [1, 2, 3]}], "search": [{"facet": "theme name", "query": "search words"}]}`,
    },
  ];
}

// What a topic's articles are mostly about; suggested questions fit it (content/phrases.js).
const TOPIC_KINDS = ['people', 'family', 'events', 'places', 'works', 'ideas', 'mixed'];

// The plan in the shape build() reads: {name, kind, facets: [{name, why, pages: [numbers]}], search: [{query, facet}]}.
// Anything else the model wrote (a list where an object belongs, numbers as strings) is fixed or left out.
function planShape(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('The plan is not a JSON object');
  const list = (x) => (Array.isArray(x) ? x.filter((v) => v != null) : []);
  const objects = (x) => list(x).filter((v) => typeof v === 'object' && !Array.isArray(v));
  return {
    name: typeof r.name === 'string' ? r.name : '',
    kind: TOPIC_KINDS.includes(r.kind) ? r.kind : 'mixed',
    facets: objects(r.facets).map((f) => ({
      name: String(f.name ?? ''),
      why: String(f.why ?? ''),
      pages: list(f.pages).map(Number).filter(Number.isInteger),
    })),
    search: objects(r.search).map((s) => ({ query: String(s.query ?? ''), facet: String(s.facet ?? '') })).filter((s) => s.query),
  };
}

async function plan({ settings, messages, emit, signal }) {
  const ask = (msgs) =>
    llm.chatWithFallback({
      settings,
      messages: msgs,
      maxTokens: 1500,
      json: true,
      signal,
      onFallback: (m) => emit({ type: 'topicProgress', text: `Main model unavailable, using ${m}` }),
    });
  let res = await ask(messages);
  try {
    return planShape(llm.parseJSON(res.content));
  } catch {
    emit({ type: 'topicProgress', text: 'Asking the model to fix its answer' });
    res = await ask([
      ...messages,
      { role: 'assistant', content: res.content },
      { role: 'user', content: 'That was not valid JSON. Reply again with only the JSON object.' },
    ]);
    try {
      return planShape(llm.parseJSON(res.content));
    } catch {
      // The parser's own message ("Expected ',' … at position 242") means nothing to the reader.
      throw new Error("Couldn't build the topic: the model's reply was garbled twice. Try again.");
    }
  }
}

async function build({ settings, page, emit, signal }) {
  const { lang } = page;
  emit({ type: 'topicProgress', text: 'Reading the article and its links' });
  const current = await wiki.getIndexedPage(lang, page.title, { html: false, signal }); // intro and outline are enough here
  const budget = appSettings.contextFor(settings, settings.model);
  const space = budget - 1500 - 1500; // minus answer and intro
  const room = Math.max(40, Math.floor((space * 0.8) / TOKENS_PER_CANDIDATE)); // a fifth stays free for the titles-only list
  const ranked = rankCandidates(page.links || [], current.page.title, room);
  if (ranked.length < 3) throw new Error('This article has too few links to build a topic from.');
  emit({ type: 'topicProgress', text: 'Checking which linked articles mention it' });
  const spare = space - ranked.length * TOKENS_PER_CANDIDATE;
  const { candidates, extra } = await linkedBack(lang, page.links || [], current.page.title, ranked, Math.max(0, Math.floor(spare / TOKENS_PER_EXTRA)), signal);

  emit({ type: 'topicProgress', text: `Asking the model to group ${candidates.length + extra.length} linked articles into themes` });
  const messages = prompt(page, current, candidates, extra, settings);
  if (estTokens(messages[1].content) > budget - 1500) messages[1].content = messages[1].content.slice(0, (budget - 1500) * 3.5);
  let result = await plan({ settings, messages, emit, signal });
  // A long article is a broad subject; a thin answer for one is usually the model cutting short, so ask once more.
  const picked = (r) => (r.facets || []).reduce((n, f) => n + (f.pages || []).length, 0);
  if (articleWords(current) > 8000 && picked(result) < 25 && candidates.length + extra.length >= 40) {
    emit({ type: 'topicProgress', text: 'Asking the model for a fuller topic' });
    const fuller = await plan({
      settings,
      signal,
      emit,
      messages: [
        ...messages,
        { role: 'assistant', content: JSON.stringify(result) },
        { role: 'user', content: `That is only ${picked(result)} articles for a broad subject. Add the central candidates you left out (people, events, ideas, consequences), aiming for 35 to 50 in all. Reply with the whole JSON object again.` },
      ],
    }).catch(() => null);
    if (fuller && picked(fuller) > picked(result)) result = fuller;
  }

  // Numbers → titles; search queries → top search hits.
  const facets = [];
  const picks = []; // {title, facet, why}
  for (const f of result.facets || []) {
    const name = String(f.name || '').trim();
    if (!name) continue;
    facets.push({ name, why: String(f.why || '').trim() });
    for (const n of f.pages || []) {
      const c = [...candidates, ...extra][Number(n) - 1];
      if (c) picks.push({ title: c.title, facet: name, why: c.context || '' });
    }
  }
  if (!facets.length) throw new Error('The model did not return any themes. Try again or use a larger model.');
  const searches = (result.search || []).slice(0, 5);
  if (searches.length) emit({ type: 'topicProgress', text: 'Searching Wikipedia for missing themes' });
  for (const s of searches) {
    const hits = await wiki.search(lang, String(s.query || ''), 2, signal).catch(() => []);
    const facet = facets.find((f) => f.name === s.facet)?.name || String(s.facet || 'More');
    if (!facets.some((f) => f.name === facet)) facets.push({ name: facet, why: '' });
    for (const t of hits) picks.push({ title: t, facet, why: `Found by searching "${s.query}"` });
  }

  emit({ type: 'topicProgress', text: 'Checking the articles exist' });
  const resolved = await wiki.resolveTitles(lang, [current.page.title, ...picks.map((p) => p.title)], signal);
  const seen = new Set([current.page.title]);
  const pages = [{ title: current.page.title, facet: null, why: 'Starting article', seed: true }];
  for (const p of picks) {
    const t = resolved.get(wiki.normTitle(p.title));
    if (!t || seen.has(t) || pages.length >= MAX_PAGES) continue;
    seen.add(t);
    pages.push({ ...p, title: t });
  }

  emit({ type: 'topicProgress', text: `Reading summaries of ${pages.length} articles` });
  const described = await wiki.describeMany(lang, pages.map((p) => p.title), signal).catch(() => new Map());
  pages.forEach((p) => {
    const d = described.get(p.title);
    Object.assign(p, { description: d?.description || '', summary: (d?.summary || '').slice(0, topics.SUMMARY_CHARS) });
  });
  // Where the subject was published or taught, not part of it (models pick these despite the prompt);
  // kept when the subject is itself a journal, publisher or university.
  const VENUE = /\b(journal|periodical|magazine|publish\w*|university|college)\b/i;
  if (!VENUE.test(pages[0].description)) {
    for (let i = pages.length - 1; i > 0; i--) if (VENUE.test(pages[i].description) || /^(List|Timeline|Outline|Index) of /.test(pages[i].title)) pages.splice(i, 1);
  }

  emit({ type: 'topicProgress', text: 'Mapping how the articles link to each other' });
  const titles = pages.map((p) => p.title);
  const edges = await wiki.linksBetween(lang, titles, titles, signal).catch(() => []);

  const topic = {
    id: `t_${Date.now().toString(36)}`,
    name: String(result.name || current.page.title).slice(0, 80),
    kind: result.kind,
    lang,
    seed: current.page.title,
    createdAt: Date.now(),
    facets: facets.filter((f) => pages.some((p) => p.facet === f.name)),
    pages,
    edges,
  };
  await topics.save(topic);
  await topics.setActive(topic.id);
  return topic;
}

export const cluster = { build, rankCandidates, linkedBack, prompt, planShape, TOPIC_KINDS };
