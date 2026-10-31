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

  const linkText = (l) => `${l.title} ${l.title} ${(l.anchors || []).join(' ')} ${l.context} ${l.sections.join(' ')}`;

  const linkLabel = (l) => (l.anchors?.length ? `${l.title} (linked as "${l.anchors[0]}")` : l.title);

  class Run {
    constructor({ settings, page, question, history, sources, emit, signal }) {
      this.settings = settings;
      this.page = page; // {lang, title, url, links, visibleSection, selection}
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
          this.linkIndex ||= new W.bm25.BM25(links, linkText);
          const hits = this.linkIndex.search(args.query || '', 8);
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
        default:
          return `Unknown tool ${name}.`;
      }
    }

    describe(name, args) {
      switch (name) {
        case 'search_article': return `Searching this article for “${args.query}”`;
        case 'read_section': return `Reading section “${args.section}”`;
        case 'find_linked_articles': return `Looking for linked articles about “${args.query}”`;
        case 'linked_article_summary': return `Reading the introduction of “${args.title}”`;
        case 'search_linked_article': return `Searching “${args.title}” for “${args.query}”`;
        default: return name;
      }
    }

    systemPrompt() {
      const { page } = this;
      const c = this.current;
      const outline = [...new Set(c.chunks.map((x) => x.section))].join('\n');
      const lead = this.format(c.chunks.filter((x) => x.section === 'Introduction'), this.budget * 0.12);

      let reading = '';
      if (page.visibleSection && page.visibleSection !== 'Introduction') {
        const chunks = c.chunks.filter((x) => x.section.split(' › ').pop() === page.visibleSection);
        if (chunks.length) reading = `\n\nThe reader is currently looking at the section "${page.visibleSection}":\n${this.format(chunks, this.budget * 0.08)}`;
      }

      return `You are a research companion built into the reader's browser. They are reading the Wikipedia article "${c.page.title}" (${page.lang}.wikipedia.org).

Rules:
- Answer only from the article text and tool results below. If they don't contain the answer, say so plainly; never fill gaps from memory.
- Cite every factual claim with its source number in square brackets, like [3] or [2][5]. Only use numbers shown next to passages in this conversation; never cite tool names or article titles in brackets.
- Check the article first (search_article, read_section). If it only mentions a person, place or concept briefly, use find_linked_articles, then linked_article_summary or search_linked_article.
- When the question is mainly about something other than "${c.page.title}" (a relative, a place, an event, a concept), always read that subject's own article before answering, even if this article mentions it.
- Be concise: a few short paragraphs or a list. Use **bold** sparingly. Answer in the language of the question.

Article outline:
${outline}

Introduction of the article:
${lead}${reading}`;
    }

    // Retrieval done up front, so even small models start from relevant text and know which links exist.
    hints() {
      const sel = this.page.selection?.text || '';
      const query = `${this.question} ${sel.slice(0, 300)}`;
      const passages = this.current.index
        .search(query, 3)
        .map((h) => h.doc)
        .filter((c) => c.section !== 'Introduction');
      let out = passages.length ? `\n\nPassages from the article that may help:\n${this.format(passages, this.budget * 0.1)}` : '';
      const links = this.page.links || [];
      if (links.length) {
        this.linkIndex ||= new W.bm25.BM25(links, linkText);
        const hits = this.linkIndex.search(query, 5);
        if (hits.length) {
          out += `\n\nLinked articles that may be relevant (read them with linked_article_summary or search_linked_article):\n`;
          out += hits.map(({ doc: l }) => `- ${linkLabel(l)}${l.context ? ` — "${l.context.slice(0, 160)}"` : ''}`).join('\n');
        }
      }
      return out;
    }

    userMessage() {
      const sel = this.page.selection;
      const question = sel?.text
        ? `About this passage I selected${sel.section ? ` (section "${sel.section}")` : ''}:\n"""${sel.text.slice(0, 1500)}"""\n\n${this.question}`
        : this.question;
      const hints = this.hints();
      return hints ? `${question}\n\n---\nContext gathered automatically:${hints}` : question;
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
      const call = (model) =>
        W.llm.chat({
          settings: this.settings,
          model,
          messages: messages.map(({ shrunk, history, ...m }) => m),
          tools,
          signal: this.signal,
          onUpdate: (u) => this.emit({ type: 'stream', ...u }),
        });
      try {
        return await call(this.model);
      } catch (e) {
        const fallback = this.settings.fallbackModel;
        if (e.status !== 503 || !fallback || this.model === fallback) throw e;
        this.model = fallback;
        this.emit({ type: 'status', text: `Main model unavailable, using ${fallback}` });
        this.fit(messages);
        return call(fallback);
      }
    }

    async run() {
      const { lang, title } = this.page;
      this.emit({ type: 'status', text: 'Reading the article' });
      this.current = await W.wiki.getIndexedPage(lang, title);

      const messages = [
        { role: 'system', content: this.systemPrompt() },
        ...this.history.slice(-8).map((m) => ({ role: m.role, content: m.content, history: true })),
        { role: 'user', content: this.userMessage() },
      ];
      this.emit({ type: 'sources', sources: this.sources });
      this.emit({ type: 'status', text: `Asking ${this.model}` });

      for (let step = 0; ; step++) {
        const last = step >= this.settings.maxSteps;
        if (last) messages.push({ role: 'user', content: 'Answer now using the sources you have, with citations.' });
        this.fit(messages);
        const res = await this.complete(messages, last ? undefined : TOOLS);
        if (!res.toolCalls.length) {
          const answer = res.content || 'The model returned an empty answer.';
          this.emit({ type: 'stream', answer });
          this.emit({ type: 'sources', sources: this.sources });
          this.emit({ type: 'done', answer, model: this.model });
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
