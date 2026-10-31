// Wikipedia access: plain-text articles split into sections and chunks, summaries, search indexes.
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});

  const SKIP_SECTIONS = new Set([
    'references', 'external links', 'notes', 'further reading', 'bibliography', 'sources',
    'citations', 'footnotes', 'notes and references', 'works cited', 'general and cited references',
  ]);
  const CHUNK_WORDS = 160;

  const normTitle = (t) => t.replace(/_/g, ' ').trim();

  async function getJSON(url) {
    const res = await fetch(url, { headers: { 'Api-User-Agent': 'WikiAI-personal-extension/0.1' } });
    if (!res.ok) throw new Error(`Wikipedia API returned ${res.status}`);
    return res.json();
  }

  function apiUrl(lang, params) {
    const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
    const all = { format: 'json', formatversion: '2', origin: '*', ...params };
    for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v);
    return url.toString();
  }

  // Turns the "== Heading ==" plain-text extract into sections with breadcrumb paths.
  function parseExtract(text) {
    const sections = [];
    const stack = [];
    let cur = { title: 'Introduction', path: 'Introduction', root: 'Introduction', lines: [] };
    for (const line of text.split('\n')) {
      const m = line.match(/^(={2,6})\s*(.*?)\s*\1\s*$/);
      if (!m) {
        cur.lines.push(line);
        continue;
      }
      sections.push(cur);
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, name: m[2] });
      cur = { title: m[2], path: stack.map((s) => s.name).join(' › '), root: stack[0].name, lines: [] };
    }
    sections.push(cur);
    return sections
      .filter((s) => !SKIP_SECTIONS.has(s.root.toLowerCase()))
      .map(({ title, path, lines }) => ({ title, path, text: lines.join('\n').trim() }));
  }

  function splitSentences(paragraph) {
    return paragraph.match(/[^.!?]+(?:[.!?]+["')\]]*\s*|$)/g) || [paragraph];
  }

  const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;

  function chunkPage(page) {
    const chunks = [];
    for (const s of page.sections) {
      let buf = [];
      let n = 0;
      const flush = () => {
        if (!buf.length) return;
        chunks.push({ page: page.title, lang: page.lang, section: s.path, text: buf.join('\n').trim() });
        buf = [];
        n = 0;
      };
      const paragraphs = s.text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
      for (const p of paragraphs) {
        // Long paragraphs are cut at sentence boundaries; their pieces rejoin with spaces.
        const pieces = wordCount(p) > CHUNK_WORDS * 1.5 ? splitSentences(p).map((x) => x.trim()) : [p];
        let joinWithSpace = false;
        for (const piece of pieces) {
          const w = wordCount(piece);
          if (n && n + w > CHUNK_WORDS) {
            flush();
            joinWithSpace = false;
          }
          if (joinWithSpace) buf[buf.length - 1] += ' ' + piece;
          else buf.push(piece);
          joinWithSpace = pieces.length > 1;
          n += w;
        }
      }
      flush();
    }
    chunks.forEach((c, i) => (c.idx = i));
    return chunks;
  }

  async function getPage(lang, title) {
    const key = `page:${lang}:${normTitle(title)}`;
    return W.cache.wrap(key, async () => {
      const data = await getJSON(
        apiUrl(lang, {
          action: 'query', prop: 'extracts|info', explaintext: 1, exsectionformat: 'wiki',
          redirects: 1, inprop: 'url', titles: normTitle(title),
        })
      );
      const p = data.query?.pages?.[0];
      if (!p || p.missing || p.invalid) throw new Error(`No Wikipedia article called "${title}"`);
      return { lang, title: p.title, url: p.fullurl, sections: parseExtract(p.extract || '') };
    });
  }

  async function getSummary(lang, title) {
    const key = `summary:${lang}:${normTitle(title)}`;
    return W.cache.wrap(key, async () => {
      const slug = encodeURIComponent(normTitle(title).replace(/ /g, '_'));
      const s = await getJSON(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${slug}`);
      return { title: s.title, description: s.description || '', extract: s.extract || '', url: s.content_urls?.desktop?.page };
    });
  }

  // Built indexes are cheap to rebuild, so they live only in memory.
  const indexes = new Map();
  async function getIndexedPage(lang, title) {
    const key = `${lang}:${normTitle(title)}`;
    if (indexes.has(key)) return indexes.get(key);
    const page = await getPage(lang, title);
    const chunks = chunkPage(page);
    const index = new W.bm25.BM25(chunks, (c) => `${c.section} ${c.section} ${c.text}`);
    const entry = { page, chunks, index };
    indexes.set(key, entry);
    indexes.set(`${lang}:${page.title}`, entry); // also under the redirect target
    if (indexes.size > 60) indexes.delete(indexes.keys().next().value);
    return entry;
  }

  const batches = (items, size = 50) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

  // Maps each requested title to the canonical title of an existing article (following redirects); drops missing ones.
  async function resolveTitles(lang, titles) {
    const out = new Map();
    for (const batch of batches([...new Set(titles.map(normTitle))])) {
      const data = await getJSON(apiUrl(lang, { action: 'query', redirects: 1, titles: batch.join('|') }));
      const q = data.query || {};
      const hop = new Map();
      for (const { from, to } of [...(q.normalized || []), ...(q.redirects || [])]) hop.set(from, to);
      const existing = new Set((q.pages || []).filter((p) => !p.missing && !p.invalid && p.ns === 0).map((p) => p.title));
      for (const t of batch) {
        let cur = t;
        for (let i = 0; i < 3 && hop.has(cur); i++) cur = hop.get(cur);
        if (existing.has(cur)) out.set(t, cur);
      }
    }
    return out;
  }

  async function search(lang, query, limit = 3) {
    const data = await getJSON(apiUrl(lang, { action: 'query', list: 'search', srsearch: query, srlimit: limit, srnamespace: 0, srprop: '' }));
    return (data.query?.search || []).map((r) => r.title);
  }

  // Links among a set of articles: [[from, to], …], from the link tables (no page text needed).
  async function linksBetween(lang, fromTitles, toTitles) {
    const edges = [];
    for (const from of batches(fromTitles)) {
      for (const to of batches(toTitles)) {
        let cont = {};
        do {
          const data = await getJSON(
            apiUrl(lang, { action: 'query', prop: 'links', titles: from.join('|'), pltitles: to.join('|'), pllimit: 'max', ...cont })
          );
          for (const p of data.query?.pages || []) for (const l of p.links || []) if (l.title !== p.title) edges.push([p.title, l.title]);
          cont = data.continue || null;
        } while (cont);
      }
    }
    return edges;
  }

  // For candidate articles: length, short description, disambiguation flag, and whether each links back to `to`.
  // Returns Map(requested title → stats); missing articles are left out.
  async function linkStats(lang, titles, to) {
    const out = new Map();
    for (const batch of batches([...new Set(titles.map(normTitle))])) {
      const data = await getJSON(
        apiUrl(lang, {
          action: 'query', redirects: 1, titles: batch.join('|'),
          prop: 'info|description|pageprops|links', ppprop: 'disambiguation', pltitles: normTitle(to), pllimit: 'max',
        })
      );
      const q = data.query || {};
      const hop = new Map();
      for (const { from, to: t } of [...(q.normalized || []), ...(q.redirects || [])]) hop.set(from, t);
      const pages = new Map((q.pages || []).filter((p) => !p.missing).map((p) => [p.title, p]));
      for (const t of batch) {
        let cur = t;
        for (let i = 0; i < 3 && hop.has(cur); i++) cur = hop.get(cur);
        const p = pages.get(cur);
        if (!p) continue;
        out.set(t, {
          title: p.title,
          length: p.length || 0,
          description: p.description || '',
          disambiguation: p.pageprops?.disambiguation !== undefined,
          linksBack: (p.links || []).length > 0,
        });
      }
    }
    return out;
  }

  // Runs fn over items with limited parallelism (Wikipedia is fast, but be polite).
  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  W.wiki = { getPage, getSummary, getIndexedPage, parseExtract, chunkPage, normTitle, resolveTitles, search, linksBetween, linkStats, mapLimit };
})(globalThis);
