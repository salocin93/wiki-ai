// Builds a topic cluster from an article: rank real link candidates, let the model group them into themes
// (it picks candidate numbers, so it can't invent titles), then check every title against Wikipedia.
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});
  const MAX_PAGES = 60; // a technical ceiling; the model decides how many articles the subject needs
  const TOKENS_PER_CANDIDATE = 45;
  const TOKENS_PER_EXTRA = 8; // listed by title only
  const estTokens = (s) => Math.ceil((s || '').length / 3.5);

  // Every link that matters for the subject, judged against the article's own most important links:
  // a focused article yields a few dozen candidates, a broad one well over a hundred.
  // maxCandidates only guards the prompt size.
  function rankCandidates(links, pageTitle, maxCandidates = 250) {
    const ranked = W.links.rank(links, pageTitle);
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
  async function linkedBack(lang, links, pageTitle, candidates, maxExtra) {
    const inText = links.filter((l) => l.sections?.length);
    const stats = await W.wiki.linkStats(lang, [...new Set([...candidates.map((c) => c.title), ...inText.map((l) => l.title)])], pageTitle).catch(() => new Map());
    const statOf = (t) => stats.get(W.wiki.normTitle(t));
    const kept = stats.size ? candidates.filter((c) => !statOf(c.title)?.disambiguation) : candidates;
    for (const c of kept) if (statOf(c.title)?.linksBack) c.signals = [...(c.signals || []), 'back'];
    const have = new Set(kept.map((c) => c.title));
    const extra = W.links
      .rank(inText, pageTitle)
      .map(({ link }) => link)
      .filter((l) => {
        const st = statOf(l.title);
        return !have.has(l.title) && st?.linksBack && !st.disambiguation && st.length >= 4000; // stubs rarely help
      })
      .slice(0, maxExtra);
    return { candidates: kept, extra };
  }

  function prompt(page, current, candidates, extra, settings) {
    const intro = current.chunks.filter((c) => c.section === 'Introduction').map((c) => c.text).join('\n');
    const outline = [...new Set(current.chunks.map((c) => c.section))].join('; ');
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
${page.categories?.length ? `Categories: ${page.categories.slice(0, 15).join('; ')}\n` : ''}
Candidate articles: the ${candidates.length} linked articles relevant to it (number. title — where the starting article links to it [navbox = listed in a navigation box, main = a section's main article, infobox = in the fact box, back = its own article mentions "${current.page.title}"]):
${lines.join('\n')}
${
  extra.length
    ? `\nMore candidates, linked only once but whose own articles mention "${current.page.title}":\n${extra.map((l, i) => `${candidates.length + i + 1}. ${l.title}`).join('; ')}\n`
    : ''
}
Build a topic cluster around "${current.page.title}":
- Decide how many articles a reader needs to explore this subject well. Include every candidate that is central to it and leave out ones that are only loosely related: a narrow subject may need 8 articles, a broad one 40 (never more than ${MAX_PAGES}).
- Group them into as many themes as the subject really has (usually 3 to 8), each named in a few words. Prefer articles about the subject's own people, branches, places, events and ideas; skip generic articles (whole countries, languages, titles like "King", wars, eras, broad fields) unless the subject is mainly about them.
- When a specific article and a broad one cover the same part of the subject, pick the specific one: the conference, treaty, book or reform the subject was part of, not the whole war or era around it. Articles marked "back" or listed under "More candidates" mention the subject themselves, a good sign they cover its own part.
- If an important theme has no fitting candidate, add a short Wikipedia search query for it under "search".

- Write the topic name, theme names and "why" sentences in ${W.settings.languageName(W.settings.answerLanguage(settings, page.lang) || page.lang)}.

Reply with exactly this JSON shape:
{"name": "short topic name", "facets": [{"name": "theme name", "why": "one short sentence", "pages": [1, 2, 3]}], "search": [{"facet": "theme name", "query": "search words"}]}`,
      },
    ];
  }

  async function plan({ settings, messages, emit, signal }) {
    const ask = (msgs) =>
      W.llm.chatWithFallback({
        settings,
        messages: msgs,
        maxTokens: 1500,
        json: true,
        signal,
        onFallback: (m) => emit({ type: 'topicProgress', text: `Main model unavailable, using ${m}` }),
      });
    let res = await ask(messages);
    try {
      return W.llm.parseJSON(res.content);
    } catch {
      emit({ type: 'topicProgress', text: 'Asking the model to fix its answer' });
      res = await ask([
        ...messages,
        { role: 'assistant', content: res.content },
        { role: 'user', content: 'That was not valid JSON. Reply again with only the JSON object.' },
      ]);
      try {
        return W.llm.parseJSON(res.content);
      } catch {
        // The parser's own message ("Expected ',' … at position 242") means nothing to the reader.
        throw new Error("Couldn't build the topic: the model's reply was garbled twice. Try again.");
      }
    }
  }

  async function build({ settings, page, emit, signal }) {
    const { lang } = page;
    emit({ type: 'topicProgress', text: 'Reading the article and its links' });
    const current = await W.wiki.getIndexedPage(lang, page.title, { tables: false }); // intro and outline are enough here
    const budget = W.settings.contextFor(settings, settings.model);
    const space = budget - 1500 - 1500; // minus answer and intro
    const room = Math.max(40, Math.floor((space * 0.8) / TOKENS_PER_CANDIDATE)); // a fifth stays free for the titles-only list
    const ranked = rankCandidates(page.links || [], current.page.title, room);
    if (ranked.length < 3) throw new Error('This article has too few links to build a topic from.');
    emit({ type: 'topicProgress', text: 'Checking which linked articles mention it' });
    const spare = space - ranked.length * TOKENS_PER_CANDIDATE;
    const { candidates, extra } = await linkedBack(lang, page.links || [], current.page.title, ranked, Math.max(0, Math.floor(spare / TOKENS_PER_EXTRA)));

    emit({ type: 'topicProgress', text: `Asking the model to group ${candidates.length + extra.length} linked articles into themes` });
    const messages = prompt(page, current, candidates, extra, settings);
    if (estTokens(messages[1].content) > budget - 1500) messages[1].content = messages[1].content.slice(0, (budget - 1500) * 3.5);
    const result = await plan({ settings, messages, emit, signal });

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
      const hits = await W.wiki.search(lang, String(s.query || ''), 2).catch(() => []);
      const facet = facets.find((f) => f.name === s.facet)?.name || String(s.facet || 'More');
      if (!facets.some((f) => f.name === facet)) facets.push({ name: facet, why: '' });
      for (const t of hits) picks.push({ title: t, facet, why: `Found by searching "${s.query}"` });
    }

    emit({ type: 'topicProgress', text: 'Checking the articles exist' });
    const resolved = await W.wiki.resolveTitles(lang, [current.page.title, ...picks.map((p) => p.title)]);
    const seen = new Set([current.page.title]);
    const pages = [{ title: current.page.title, facet: null, why: 'Starting article', seed: true }];
    for (const p of picks) {
      const t = resolved.get(W.wiki.normTitle(p.title));
      if (!t || seen.has(t) || pages.length > MAX_PAGES) continue;
      seen.add(t);
      pages.push({ ...p, title: t });
    }

    emit({ type: 'topicProgress', text: `Reading summaries of ${pages.length} articles` });
    const described = await W.wiki.mapLimit(pages, 6, (p) => W.topics.describe(lang, p.title));
    pages.forEach((p, i) => Object.assign(p, described[i]));

    emit({ type: 'topicProgress', text: 'Mapping how the articles link to each other' });
    const titles = pages.map((p) => p.title);
    const edges = await W.wiki.linksBetween(lang, titles, titles).catch(() => []);

    const topic = {
      id: `t_${Date.now().toString(36)}`,
      name: String(result.name || current.page.title).slice(0, 80),
      lang,
      seed: current.page.title,
      createdAt: Date.now(),
      facets: facets.filter((f) => pages.some((p) => p.facet === f.name)),
      pages,
      edges,
    };
    await W.topics.save(topic);
    await W.topics.setActive(topic.id);
    return topic;
  }

  W.cluster = { build, rankCandidates, linkedBack, prompt };
})(globalThis);
