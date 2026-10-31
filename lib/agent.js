// The tool-calling loop: the model reads the article and linked articles on demand and cites numbered sources.
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});

  const estTokens = (s) => Math.ceil((s || '').length / 3.5);
  const fn = (name, description, properties, required) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  });
  const str = (description) => ({ type: 'string', description });

  const TOOLS = [
    fn('search_article', 'Keyword search in the current article. Returns the most relevant passages, each with a source number.',
      { query: str('A few keywords, e.g. "education military academy"') }, ['query']),
    fn('read_section', 'Read a whole section of the current article, by its name from the outline.',
      { section: str('Section name as written in the outline') }, ['section']),
    fn('find_linked_articles', 'Find articles that the current article links to and that are relevant to a topic. Returns their titles and the sentence where each link appears. Use this when the current article only mentions something briefly.',
      { query: str('Topic keywords') }, ['query']),
    fn('linked_article_summary', 'Get the short introduction of another Wikipedia article.',
      { title: str('Exact article title') }, ['title']),
    fn('search_linked_article', 'Keyword search inside another Wikipedia article, for details its introduction does not cover.',
      { title: str('Exact article title'), query: str('A few keywords') }, ['title', 'query']),
  ];

  const RECOMMEND_TOOL = fn(
    'recommend_reading',
    'Recommend which linked articles are most worth reading next. Ranks them by how central they are to the current article (in the introduction, a section\'s main article, the fact box, its own navigation box, linked often, linking back), by substance, and by the section the reader is looking at, spread across different aspects. Use it for "what should I read next" questions.',
    { focus: str('Optional theme to focus the recommendations on') },
    []
  );

  // "What should I read next" style questions get ranked recommendations instead of a keyword search over links.
  const READ_NEXT = /\b(read(ing)? next|read after|should i read|worth reading|recommend|suggest(ions?)? (for )?(reading|articles?)|what else (to|should)|where (should|do) i (go|continue)|learn more|further reading|related articles?|dig deeper)\b/i;

  const TOPIC_TOOLS = [
    fn('search_topic', 'Keyword search across all articles in the topic cluster at once. Returns the best passages from several articles, each with a source number. Optionally limit it to one theme.',
      { query: str('A few keywords'), theme: str('Optional theme name from the topic map') }, ['query']),
    fn('topic_connections', 'Show how one article in the topic links to the other topic articles, with the sentences that connect them.',
      { title: str('Article title from the topic map') }, ['title']),
  ];

  // At most perPage passages per article, so one long article can't crowd out the rest.
  function diverse(hits, k, perPage = 2) {
    const count = new Map();
    const out = [];
    for (const { doc } of hits) {
      const n = count.get(doc.page) || 0;
      if (n >= perPage) continue;
      count.set(doc.page, n + 1);
      out.push(doc);
      if (out.length >= k) break;
    }
    return out;
  }

  const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Names a question might use for an article: its title, its link text, and short forms
  // ("Christian I of Denmark" → "Christian I", "Elimar I, Count of Oldenburg" → "Elimar I").
  // Single words are left out: "Christian" or "Holstein" alone are too ambiguous.
  function namesFor(title, anchors = []) {
    const base = title.replace(/\s*\(.*\)$/, '').trim();
    const short = base.split(',')[0].replace(/\s+of\s+\p{Lu}[^,]*$/u, '').trim();
    return [...new Set([base, short, ...anchors].map((n) => n.trim()))].filter((n) => n.split(/\s+/).length >= 2);
  }

  // An answer that sends the reader elsewhere or gives up, instead of looking in the linked articles.
  const DEFERRAL = /\b((does not|doesn't|do not|don't) (contain|mention|include|provide|cover|say|give)|not (mentioned|covered|included|provided|detailed)|no (specific |further )?(details|information)|(would|will|may|might) need to (read|consult|check|look)|(refer|turn) to the (article|page)|read the (article|page) (on|about))/i;

  const shortName = (t) => t.replace(/\s*\(.*\)$/, '');

  const linkText = (l) => `${l.title} ${l.title} ${(l.anchors || []).join(' ')} ${l.context} ${l.sections.join(' ')}`;

  const linkLabel = (l) => (l.anchors?.length ? `${l.title} (linked as "${l.anchors[0]}")` : l.title);

  class Run {
    constructor({ settings, page, topic, question, history, sources, emit, signal }) {
      this.settings = settings;
      this.topic = topic || null; // active topic cluster, if any
      this.page = page; // {lang, title, url, links, categories, visibleSection: {name, path, text}, selection}
      this.question = question;
      this.history = history || [];
      this.sources = sources || []; // shared with the UI across the conversation
      this.emit = emit;
      this.signal = signal;
      this.model = settings.model;
    }

    get budget() {
      return W.settings.contextFor(this.settings, this.model);
    }

    // Registers a passage as a citable source and returns its number.
    cite(chunk, current) {
      const key = `${chunk.lang}|${chunk.page}|${chunk.section}|${chunk.text.slice(0, 80)}`;
      let src = this.sources.find((s) => s.key === key);
      if (!src) {
        src = { n: this.sources.length + 1, key, lang: chunk.lang, page: chunk.page, section: chunk.section, text: chunk.text, current };
        this.sources.push(src);
      }
      return src.n;
    }

    format(chunks, maxTokens) {
      const current = (c) => c.page === this.current.page.title;
      const out = [];
      let used = 0;
      for (const c of chunks) {
        const block = `[${this.cite(c, current(c))}] ${c.page} › ${c.section}\n${c.text}`;
        if (used && used + estTokens(block) > maxTokens) {
          out.push('(more text omitted; search with narrower keywords)');
          break;
        }
        out.push(block);
        used += estTokens(block);
      }
      return out.join('\n\n');
    }

    get toolBudget() {
      return Math.max(1200, Math.floor(this.budget * 0.15));
    }

    async tool(name, args) {
      const { lang } = this.page;
      if (/linked_article|search_topic|topic_connections/.test(name)) this.usedOther = true;
      switch (name) {
        case 'search_article': {
          const hits = this.current.index.search(args.query || '', 4).map((h) => h.doc);
          return hits.length ? this.format(hits, this.toolBudget) : 'No matches. Try different keywords or read_section.';
        }
        case 'read_section': {
          const want = (args.section || '').toLowerCase().trim();
          const paths = [...new Set(this.current.chunks.map((c) => c.section))];
          const path =
            paths.find((p) => p.toLowerCase() === want) ||
            paths.find((p) => p.toLowerCase().split(' › ').pop() === want) ||
            paths.find((p) => p.toLowerCase().includes(want));
          if (!want || !path) return `No section "${args.section}". Sections: ${paths.join('; ')}`;
          const chunks = this.current.chunks.filter((c) => c.section === path || c.section.startsWith(path + ' › '));
          return this.format(chunks, this.toolBudget * 1.5);
        }
        case 'find_linked_articles': {
          const links = this.page.links || [];
          if (!links.length) return 'This article has no links to search.';
          const hits = this.searchLinks(args.query || '', 8);
          if (!hits.length) return 'No linked articles match. Try other keywords.';
          return hits.map(({ doc: l }) => `- ${linkLabel(l)} — "${l.context.slice(0, 220)}"`).join('\n');
        }
        case 'linked_article_summary': {
          const s = await W.wiki.getSummary(lang, args.title || '');
          const text = [s.description, s.extract].filter(Boolean).join('. ');
          return this.format([{ lang, page: s.title, section: 'Introduction', text }], this.toolBudget);
        }
        case 'search_linked_article': {
          const other = await W.wiki.getIndexedPage(lang, args.title || '');
          let hits = other.index.search(args.query || '', 4).map((h) => h.doc);
          if (!hits.length) hits = other.chunks.slice(0, 2);
          return this.format(hits, this.toolBudget);
        }
        case 'search_topic': {
          if (!this.corpus) return 'No topic is active. Use search_article instead.';
          const theme = (args.theme || '').toLowerCase().trim();
          let hits = this.corpus.index.search(args.query || '', 60);
          if (theme) hits = hits.filter((h) => (this.corpus.facetOf.get(h.doc.page) || '').toLowerCase().includes(theme));
          const docs = diverse(hits, 6);
          return docs.length ? this.format(docs, this.toolBudget) : 'No matches in the topic. Try other keywords or drop the theme.';
        }
        case 'topic_connections':
          return this.connections(args.title || '');
        case 'recommend_reading':
          return this.recommend(args.focus || '');
        default:
          return `Unknown tool ${name}.`;
      }
    }

    // Keyword search over links, re-ranked so central links win over ones that only share a word.
    searchLinks(query, k) {
      const links = this.page.links || [];
      this.linkIndex ||= new W.bm25.BM25(links, linkText);
      const title = this.current.page.title;
      return this.linkIndex
        .search(query, 30)
        .map((h) => ({ doc: h.doc, score: h.score + 0.4 * W.links.importance(h.doc, title, this.visible?.name, W.links.boxSizes(links)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    }

    // Ranked reading suggestions from this article's links. Each comes with the sentence where this article
    // mentions it (citable), its Wikipedia description, and plain reasons, so the model can explain the pick.
    async recommend(focus = '') {
      const links = this.page.links || [];
      if (!links.length) return 'This article has no links to recommend.';
      const title = this.current.page.title;
      const vis = this.visible?.name;
      let pool = W.links.rank(links, title, { focusSection: vis }).slice(0, 45);
      if (focus.trim()) {
        this.linkIndex ||= new W.bm25.BM25(links, linkText);
        const rel = new Map(this.linkIndex.search(focus, 40).map((h) => [h.doc.title, h.score]));
        const max = Math.max(1, ...rel.values());
        pool = [...pool, ...[...rel.keys()].filter((t) => !pool.some((p) => p.link.title === t)).map((t) => ({ link: links.find((l) => l.title === t), score: 0 }))]
          .map((p) => ({ ...p, score: p.score + 6 * ((rel.get(p.link.title) || 0) / max) }))
          .filter((p) => rel.has(p.link.title) || p.score > 6);
      }
      const stats = await W.wiki.linkStats(this.page.lang, pool.map((p) => p.link.title), title).catch(() => new Map());
      const scored = [];
      for (const p of pool) {
        const st = stats.get(W.wiki.normTitle(p.link.title));
        if (stats.size && (!st || st.disambiguation)) continue;
        let score = p.score;
        if (st?.linksBack) score += 1.5;
        if (st) score += st.length > 40000 ? 2 : st.length > 15000 ? 1 : st.length < 4000 ? -2 : 0;
        scored.push({ ...p, st, score });
      }
      scored.sort((a, b) => b.score - a.score);

      // When reading a specific section, its own links get a group of their own so the intro's links don't drown them.
      const reading = vis && vis !== 'Introduction' ? scored.filter((p) => p.link.sections?.includes(vis)).slice(0, 4) : [];
      const taken = new Set(reading.map((p) => p.link.title));

      // Spread the rest over different parts of the article: at most two per section (or navigation box).
      const perGroup = new Map();
      const central = [];
      for (const p of scored) {
        const l = p.link;
        if (taken.has(l.title)) continue;
        const group = l.sections?.find((x) => x !== 'Introduction') || l.navboxes?.[0] || 'Introduction';
        if ((perGroup.get(group) || 0) >= 2) continue;
        perGroup.set(group, (perGroup.get(group) || 0) + 1);
        central.push(p);
        if (central.length >= (reading.length ? 5 : 8)) break;
      }
      if (!central.length && !reading.length) return 'No good recommendations found among the links.';

      // Each pick's own introduction, so the model can say what the reader will learn there (and cite it).
      const picks = [...central, ...reading];
      const summaries = await W.wiki.mapLimit(picks, 6, (p) => W.wiki.getSummary(this.page.lang, p.link.title).catch(() => null));
      picks.forEach((p, i) => (p.summary = summaries[i]));

      const inTopic = new Set(this.topic?.pages.map((p) => p.title) || []);
      const line = ({ link: l, st, summary }) => {
        const first = l.context?.split(' … ')[0] || '';
        // Real sentences only: chart boxes and fact-box rows make poor quotes.
        const sentence = first && !/^(Navigation box|Infobox|Listed under)/.test(first) && first.split(/\s+/).length >= 6 ? first : '';
        const cite = sentence ? `[${this.cite({ lang: this.page.lang, page: title, section: l.sections?.[0] || 'Introduction', text: sentence }, true)}] ` : '';
        const why = [W.links.reasons(l, title), st?.linksBack ? 'links back to this article' : '', st ? `${Math.round(st.length / 1000)} KB article` : '']
          .filter(Boolean)
          .join('; ');
        const ex = summary?.extract || '';
        const intro = ex.length > 420 ? ex.slice(0, 420).replace(/\s+\S*$/, '…') : ex;
        const introCite = intro ? `[${this.cite({ lang: this.page.lang, page: summary.title, section: 'Introduction', text: intro }, false)}] ` : '';
        return `- ${linkLabel(l)}${st?.description ? ` — ${st.description}` : ''}${inTopic.has(l.title) ? ' (already in the topic)' : ''}
  Ranked for: ${why}${sentence ? `\n  ${cite}This article mentions it: "${sentence.slice(0, 200)}"` : ''}${intro ? `\n  ${introCite}Its own introduction: ${intro}` : ''}`;
      };
      let out = `Recommended articles to read next from "${title}"${focus ? ` (focus: ${focus})` : ''}.`;
      if (central.length) out += `\n\nMost central to the article:\n${central.map(line).join('\n')}`;
      if (reading.length) out += `\n\nFrom the section the reader is looking at ("${vis}"):\n${reading.map(line).join('\n')}`;
      return out;
    }

    // Links between one topic article and the others, each with the sentence that makes the link (citable).
    connections(title) {
      if (!this.topic || !this.corpus) return 'No topic is active.';
      const want = title.toLowerCase().trim();
      const page =
        this.topic.pages.find((p) => p.title.toLowerCase() === want) ||
        this.topic.pages.find((p) => p.title.toLowerCase().includes(want) || want.includes(p.title.toLowerCase()));
      if (!page) return `"${title}" is not in the topic. Articles: ${this.topic.pages.map((p) => p.title).join('; ')}`;
      const t = page.title;
      const lines = [];
      const sentence = (from, to) => {
        const chunks = this.corpus.byPage.get(from)?.chunks || [];
        const name = shortName(to).toLowerCase();
        for (const c of chunks) {
          const s = (c.text.match(/[^.!?]+[.!?]+/g) || [c.text]).find((x) => x.toLowerCase().includes(name));
          if (s) return { chunk: c, text: s.trim() };
        }
        return null;
      };
      const seen = new Set();
      for (const [from, to] of this.topic.edges) {
        if ((from !== t && to !== t) || seen.has(`${from}|${to}`)) continue;
        seen.add(`${from}|${to}`);
        const s = sentence(from, to);
        const cite = s ? `[${this.cite(s.chunk, s.chunk.page === this.current.page.title)}] ` : '';
        lines.push(`- ${cite}${from} → ${to}${s ? `: "${s.text.slice(0, 240)}"` : ' (linked, no sentence found)'}`);
        if (lines.length >= 14) break;
      }
      return lines.length ? `Links between "${t}" and other topic articles:\n${lines.join('\n')}` : `"${t}" has no links to other articles in the topic.`;
    }

    describe(name, args) {
      switch (name) {
        case 'search_article': return `Searching this article for “${args.query}”`;
        case 'read_section': return `Reading section “${args.section}”`;
        case 'find_linked_articles': return `Looking for linked articles about “${args.query}”`;
        case 'linked_article_summary': return `Reading the introduction of “${args.title}”`;
        case 'search_linked_article': return `Searching “${args.title}” for “${args.query}”`;
        case 'search_topic': return `Searching the topic${args.theme ? ` (${args.theme})` : ''} for “${args.query}”`;
        case 'topic_connections': return `Tracing how “${args.title}” connects to the topic`;
        case 'recommend_reading': return args.focus ? `Ranking linked articles to read next about “${args.focus}”` : 'Ranking linked articles to read next';
        default: return name;
      }
    }

    systemPrompt() {
      const { page } = this;
      const c = this.current;
      const outline = [...new Set(c.chunks.map((x) => x.section))].join('\n');
      const lead = this.format(c.chunks.filter((x) => x.section === 'Introduction'), this.budget * 0.12);

      // The section on screen, preferably as the page shows it (charts and tables included), else from the extract.
      let reading = '';
      const vis = this.visible;
      if (vis?.name && vis.name !== 'Introduction') {
        const maxChars = Math.floor(this.budget * 0.12 * 3.5);
        let chunks = [];
        if (vis.text?.trim()) {
          chunks = [{ lang: page.lang, page: c.page.title, section: vis.path, text: vis.text.slice(0, maxChars) }];
        } else {
          chunks = c.chunks.filter((x) => x.section.split(' › ').pop() === vis.name);
        }
        reading = chunks.length
          ? `\n\nThe reader is currently looking at the section "${vis.path}". Questions about "this section" or "what I'm reading" mean this section. Its content as shown on the page (charts, family trees and lists are flattened to text; in a family-tree chart each line is usually one generation, with parallel lines of descent side by side):\n${this.format(chunks, this.budget * 0.12)}`
          : `\n\nThe reader is currently looking at the section "${vis.path}", which has no readable text.`;
      }

      const topic = this.topicMap();
      return `You are a research companion built into the reader's browser. They are reading the Wikipedia article "${c.page.title}" (${page.lang}.wikipedia.org).${topic ? `\nThey are exploring a topic that spans several articles; see the topic map below.` : ''}

Rules:
- Answer only from the passages and tool results in this conversation; never fill gaps from memory, not even with well-known facts.
- When this article lacks the details, open the relevant linked article yourself (search_linked_article or linked_article_summary) before answering. Never tell the reader to go and read an article you could open. Only say the information isn't available after you have searched the relevant articles.
- Cite every factual claim with its source number in square brackets, like [3] or [2][5]. Only use numbers shown next to passages in this conversation; never cite tool names or article titles in brackets.
- Check the article first (search_article, read_section). If it only mentions a person, place or concept briefly, use find_linked_articles, then linked_article_summary or search_linked_article.
- For "what should I read next" questions, use recommend_reading (if its results are already below, use those). Pick 3 to 5 articles that cover different aspects, including at least one from the section the reader is looking at when that group is listed. For each, say in one or two sentences what the reader will learn there and how it connects to this article, citing its introduction and the sentence where this article mentions it. Don't mention link counts, article sizes or other ranking details. Prefer articles that are central to this subject over articles that are merely listed alongside it.
- When the question is mainly about something other than "${c.page.title}" (a relative, a place, an event, a concept), always read that subject's own article before answering, even if this article mentions it.
- Reply with the answer only: don't write out your reasoning, plans or drafts.
- Be concise: a few short paragraphs or a list. Use **bold** sparingly. Answer in the language of the question.
- End every answer with 3 follow-up questions the reader could ask next, in exactly this format (they are shown as buttons, not text):
<followups>
- first question?
- second question?
- third question?
</followups>
  Make them specific (name the people, places, events or articles involved), answerable from Wikipedia, and different from each other: one going deeper into your answer, one about a related linked article or theme, one broader.${
        topic
          ? `
- Topic questions: use search_topic to search all topic articles at once. When a question covers several themes, people, places or countries, call search_topic once for each of them (with the theme when it fits) before answering. Use topic_connections to explain how articles relate. Say which article each part of your answer comes from.`
          : ''
      }
${topic}
Article outline:
${outline}

Introduction of the article:
${lead}${reading}`;
    }

    // Compact map of the topic: themes and their articles with one-line descriptions.
    topicMap() {
      const t = this.topic;
      if (!t) return '';
      const limit = this.budget * 0.12;
      const lines = [`\nTopic map: "${t.name}" (${t.pages.length} articles)`];
      const seed = t.pages.find((p) => p.seed);
      if (seed) lines.push(`Starting article: ${seed.title}${seed.description ? ` — ${seed.description}` : ''}`);
      for (const f of t.facets) {
        lines.push(`## ${f.name}${f.why ? ` — ${f.why}` : ''}`);
        for (const p of t.pages.filter((x) => x.facet === f.name)) lines.push(`- ${p.title}${p.description ? ` — ${p.description.slice(0, 90)}` : ''}`);
      }
      let out = '';
      for (const l of lines) {
        if (estTokens(out + l) > limit) {
          out += '(more articles omitted)\n';
          break;
        }
        out += l + '\n';
      }
      return out;
    }

    // Articles the question names: linked articles, topic articles and pages cited earlier in this chat.
    mentionedArticles(text) {
      const current = this.current.page.title;
      const names = new Map(); // lowercased name → title
      const add = (t, anchors) => {
        if (!t || t === current) return;
        for (const n of namesFor(t, anchors)) if (!names.has(n.toLowerCase())) names.set(n.toLowerCase(), t);
      };
      for (const l of this.page.links || []) add(l.title, l.anchors);
      for (const p of this.topic?.pages || []) add(p.title);
      for (const src of this.sources) if (!src.current) add(src.page);
      const found = [];
      for (const [name, t] of [...names].sort((a, b) => b[0].length - a[0].length)) {
        if (found.some((f) => f.title === t || f.name.includes(name))) continue;
        if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(name)}($|[^\\p{L}\\p{N}])`, 'iu').test(text)) found.push({ name, title: t });
        if (found.length >= 3) break;
      }
      return found.map((f) => f.title);
    }

    // Other articles cited in the previous answer, for follow-ups like "what was his role…".
    recentPages() {
      const last = [...this.history].reverse().find((m) => m.role === 'assistant');
      const nums = [...(last?.content || '').matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
      const pages = nums.map((n) => this.sources[n - 1]).filter((src) => src && !src.current).map((src) => src.page);
      return [...new Set(pages)].slice(0, 3);
    }

    // Passages from the articles a question is about, read before the model starts.
    async otherArticleHints(query) {
      const about = this.mentionedArticles(query);
      const targets = about.length ? about : this.recentPages();
      this.aboutArticles = targets;
      let out = '';
      for (const t of targets) {
        const e = await W.wiki.getIndexedPage(this.page.lang, t).catch(() => null);
        if (!e) continue;
        this.emit({ type: 'step', text: `Reading “${e.page.title}”` });
        let hits = e.index.search(query, 3).map((h) => h.doc);
        if (!hits.some((c) => c.section === 'Introduction')) hits = [e.chunks[0], ...hits].filter(Boolean).slice(0, 3);
        const why = about.length ? 'the question is about it' : 'cited in the previous answer';
        out += `\n\nPassages from "${e.page.title}" (${why}):\n${this.format(hits, (this.budget * 0.14) / targets.length)}`;
      }
      return out;
    }

    // Retrieval done up front, so even small models start from relevant text and know which links exist.
    async hints() {
      const sel = this.page.selection?.text || '';
      const query = `${this.question} ${sel.slice(0, 300)}`;
      if (READ_NEXT.test(this.question)) {
        this.emit({ type: 'step', text: 'Ranking linked articles to read next' });
        return `\n\n${await this.recommend()}`;
      }
      const other = await this.otherArticleHints(query);
      const passages = this.corpus
        ? diverse(this.corpus.index.search(query, 30), other ? 3 : 4, 1)
        : this.current.index
            .search(query, other ? 2 : 3)
            .map((h) => h.doc)
            .filter((c) => c.section !== 'Introduction');
      const from = this.corpus ? 'the topic articles' : `"${this.current.page.title}"`;
      let out = other + (passages.length ? `\n\nPassages from ${from} that may help:\n${this.format(passages, this.budget * 0.1)}` : '');
      const links = this.page.links || [];
      if (links.length) {
        const hits = this.searchLinks(query, 5);
        if (hits.length) {
          out += `\n\nLinked articles that may be relevant (read them with linked_article_summary or search_linked_article):\n`;
          out += hits.map(({ doc: l }) => `- ${linkLabel(l)}${l.context ? ` — "${l.context.slice(0, 160)}"` : ''}`).join('\n');
        }
      }
      return out;
    }

    async userMessage() {
      const sel = this.page.selection;
      const question = sel?.text
        ? `About this passage I selected${sel.section ? ` (section "${sel.section}")` : ''}:\n"""${sel.text.slice(0, 1500)}"""\n\n${this.question}`
        : this.question;
      const hints = await this.hints();
      return hints ? `${question}\n\n---\nContext gathered automatically:${hints}` : question;
    }

    // Fallback when the answer came without a <followups> block: one short extra request.
    async suggestFollowups(answer) {
      const t = this.topic;
      const related = W.links
        .rank(this.page.links || [], this.current.page.title, { focusSection: this.visible?.name })
        .slice(0, 8)
        .map((x) => x.link.title);
      const context = [
        `Article: "${this.current.page.title}"`,
        t ? `Topic: "${t.name}" with themes: ${t.facets.map((f) => f.name).join('; ')}` : '',
        related.length ? `Closely linked articles: ${related.join('; ')}` : '',
      ].filter(Boolean);
      const res = await W.llm.chatWithFallback({
        settings: this.settings,
        model: this.model,
        maxTokens: 250,
        signal: this.signal,
        messages: [
          { role: 'system', content: "You suggest follow-up questions for someone reading Wikipedia. Reply with only 3 questions, one per line, each starting with '- '." },
          {
            role: 'user',
            content: `${context.join('\n')}\n\nQuestion: ${this.question}\n\nAnswer: ${answer.slice(0, 1800)}\n\nSuggest 3 follow-up questions: one going deeper into the answer, one about a related article or theme listed above, one broader. Name the specific people, places or events.`,
          },
        ],
      });
      return W.llm.listItems(res.content);
    }

    // Keeps the prompt inside the budget: shrinks old tool results first, then drops old turns.
    fit(messages) {
      const limit = this.budget - this.settings.maxAnswerTokens;
      const total = () => messages.reduce((n, m) => n + estTokens(m.content) + estTokens(JSON.stringify(m.tool_calls || '')), 0);
      for (const m of messages) {
        if (total() <= limit) return;
        if (m.role === 'tool' && !m.shrunk && m.content.length > 300) {
          m.content = m.content.slice(0, 300) + '\n(older tool result shortened to save space)';
          m.shrunk = true;
        }
      }
      while (total() > limit && messages.length > 2 && messages[1].history) messages.splice(1, 1);
    }

    async complete(messages, tools) {
      const call = (model, noWait) =>
        W.llm.chat({
          settings: this.settings,
          model,
          noWait,
          // Models that reason before answering (e.g. Gemma) need room for both.
          maxTokens: (/gemma/i.test(model) ? Math.max(this.settings.maxAnswerTokens, 4000) : this.settings.maxAnswerTokens) * (this.retriedEmpty ? 2 : 1),
          messages: messages.map(({ shrunk, history, ...m }) => m),
          tools,
          signal: this.signal,
          onUpdate: (u) => this.emit({ type: 'stream', ...u }),
          onWait: (sec) => this.emit({ type: 'status', text: `Rate limit reached, trying again in ${sec} s` }),
        });
      // Unavailable (503) or rate-limited (429): switch to the fallback model for the rest of this answer.
      // Free tiers count quota per model, so switching beats waiting.
      const fallback = this.settings.fallbackModel;
      const canSwitch = !!fallback && this.model !== fallback;
      try {
        return await call(this.model, canSwitch);
      } catch (e) {
        if (!canSwitch || (e.status !== 503 && e.status !== 429)) throw e;
        const why = e.status === 429 ? `${this.model} is at its rate limit` : 'Main model unavailable';
        this.model = fallback;
        this.emit({ type: 'status', text: `${why}, using ${fallback}` });
        this.fit(messages);
        return call(fallback, false);
      }
    }

    async run() {
      const { lang, title } = this.page;
      const v = this.page.visibleSection;
      this.visible = typeof v === 'string' ? { name: v, path: v, text: '' } : v || null;
      this.emit({ type: 'status', text: 'Reading the article' });
      this.current = await W.wiki.getIndexedPage(lang, title);
      if (this.topic) {
        this.corpus = await W.topics.corpus(this.topic, (done, total) =>
          this.emit({ type: 'status', text: `Reading topic articles (${done}/${total})` })
        );
      }
      const tools = this.topic ? [...TOPIC_TOOLS, RECOMMEND_TOOL, ...TOOLS] : [RECOMMEND_TOOL, ...TOOLS];

      const messages = [
        { role: 'system', content: this.systemPrompt() },
        ...this.history.slice(-8).map((m) => ({ role: m.role, content: m.content, history: true })),
        { role: 'user', content: await this.userMessage() },
      ];
      this.emit({ type: 'sources', sources: this.sources });
      this.emit({ type: 'status', text: `Asking ${this.model}` });

      // Free tiers allow few requests per minute, so fewer research rounds there.
      const maxSteps = W.settings.isGemini(this.settings) ? Math.min(this.settings.maxSteps, 3) : this.settings.maxSteps;
      for (let step = 0; ; step++) {
        const last = step >= maxSteps;
        if (last) messages.push({ role: 'user', content: 'Answer now using the sources you have, with citations.' });
        this.fit(messages);
        const res = await this.complete(messages, last ? undefined : tools);
        // All reasoning and no answer (the reply ran out of room while thinking): ask once more, directly.
        if (!res.toolCalls.length && !/[\p{L}\p{N}]/u.test(res.content || '') && !this.retriedEmpty) {
          this.retriedEmpty = true;
          this.emit({ type: 'status', text: 'Asking for the answer' });
          this.emit({ type: 'stream', answer: '', reasoning: res.reasoning || '' });
          messages.push({ role: 'user', content: 'Write your answer to my question now, directly, without planning or deliberating.' });
          continue;
        }
        if (!res.toolCalls.length && !last && !this.retried && !this.usedOther && DEFERRAL.test(res.content || '')) {
          const targets = this.aboutArticles?.length ? this.aboutArticles : this.searchLinks(this.question, 2).map((h) => h.doc.title);
          if (targets.length) {
            this.retried = true;
            this.emit({ type: 'status', text: `Looking in ${targets.map((t) => `“${t}”`).join(' and ')}` });
            this.emit({ type: 'stream', answer: '' });
            messages.push({ role: 'assistant', content: res.content });
            messages.push({
              role: 'user',
              content: `Don't send me to another article: open it yourself. Use search_linked_article on ${targets.map((t) => `"${t}"`).join(' and ')} (and other linked articles if needed), then answer my question with citations.`,
            });
            continue;
          }
        }
        if (!res.toolCalls.length) {
          const answer = res.content || 'The model returned an empty answer.';
          this.emit({ type: 'stream', answer });
          this.emit({ type: 'sources', sources: this.sources });
          let followups = W.llm.parseFollowups(res.raw || '');
          if (followups.length < 2 && res.content) {
            this.emit({ type: 'status', text: 'Suggesting follow-up questions' });
            followups = await this.suggestFollowups(answer).catch(() => []);
          }
          this.followups = followups;
          this.emit({ type: 'done', answer, model: this.model, followups });
          return answer;
        }
        this.emit({ type: 'stream', answer: '' }); // drop any text written before the tool call
        messages.push({ role: 'assistant', content: res.content || '', tool_calls: res.toolCalls });
        for (const tc of res.toolCalls) {
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {}
          this.emit({ type: 'step', text: this.describe(tc.function.name, args) });
          let out;
          try {
            out = await this.tool(tc.function.name, args);
          } catch (e) {
            out = `Tool failed: ${e.message}`;
          }
          messages.push({ role: 'tool', tool_call_id: tc.id, content: out });
        }
        this.emit({ type: 'sources', sources: this.sources });
      }
    }
  }

  W.agent = { run: (opts) => new Run(opts).run(), TOOLS, Run };
})(globalThis);
