// The Wikipedia article on screen: which page and revision it is, its sections and links, finding a cited passage in
// it, and links back to Wikipedia. W.page is left unset where the panel doesn't belong (not an article, an edit or
// history view, an old revision). Used by the panel (content.js).
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});

  const article = document.querySelector('#mw-content-text .mw-parser-output');
  // Only main-namespace articles as read (not edited, not their history); the Main Page is in that namespace but
  // is a portal of boxes.
  const body = document.body.classList;
  if (!article || !body.contains('ns-0') || !body.contains('action-view') || body.contains('page-Main_Page')) return;

  // The revision on screen, from the page's inline config (the content script can't reach mw.config). An old
  // revision (opened from "Open the version quoted") is for reading only: the panel answers about the current one.
  const revisionVar = (name) => {
    for (const el of document.querySelectorAll('script:not([src])')) {
      const m = el.textContent.match(new RegExp(`"${name}"\\s*:\\s*(\\d+)`));
      if (m) return Number(m[1]);
    }
    return 0;
  };
  const pageRevid = revisionVar('wgRevisionId');
  const currentRevid = revisionVar('wgCurRevisionId');
  if (pageRevid && currentRevid && pageRevid !== currentRevid) return;

  const canonical = /** @type {HTMLLinkElement | null} */ (document.querySelector('link[rel=canonical]'))?.href || location.href;
  const pageUrl = new URL(canonical);
  const lang = pageUrl.hostname.split('.')[0];
  // "/wiki/Title", "/zh-hans/Title" or "/w/index.php?title=Title".
  const title = (pageUrl.searchParams.get('title') || decodeURIComponent(pageUrl.pathname.replace(/^\/[^/]+\//, ''))).replace(/_/g, ' ');
  if (!title || title.startsWith('/')) return;

  // ---------- Sections and links ----------

  let links = null; // collected once per page

  const NON_ARTICLE_NS = /^(File|Image|Help|Special|Wikipedia|Template|Category|Portal|Talk|Module|Draft|User|MediaWiki|Book|Media|WP|Template talk|User talk)(:)/i;
  const isBackMatter = (name) => W.sections.isBackMatter(name); // references, external links, "See also", in many languages
  const SKIP_LINK_AREAS = '.reflist, .references, .mw-references-wrap, sup.reference, cite, .citation, .reference-text, .mw-editsection, .sistersitebox, .shortdescription, .navbar';

  const headingText = (h) => (h.querySelector('.mw-headline')?.textContent || h.textContent).replace(/\[edit\]$/, '').trim();
  const headings = () => [...article.querySelectorAll('h2, h3, h4')];

  function sectionOf(node) {
    let name = 'Introduction';
    for (const h of headings()) {
      if (h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) name = headingText(h);
      else break;
    }
    return name;
  }

  const headingLevel = (el) => {
    const h = el.matches('h2, h3, h4, h5, h6') ? el : el.matches('.mw-heading') ? el.querySelector('h2, h3, h4, h5, h6') : null;
    return h ? Number(h.tagName[1]) : 0;
  };

  // The section the reader is looking at, with its text as shown on the page. Wikipedia's plain-text export
  // drops charts, family trees and many tables, so the page itself is the reliable source for "this section".
  function visibleSection() {
    let current = null;
    const stack = [];
    for (const h of headings()) {
      if (h.getBoundingClientRect().top >= window.innerHeight * 0.35) break;
      const level = Number(h.tagName[1]);
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, name: headingText(h) });
      current = h;
    }
    if (!current) return { name: 'Introduction', path: 'Introduction', text: '' };

    const level = Number(current.tagName[1]);
    const parts = [];
    let length = 0;
    for (let el = (current.closest('.mw-heading') || current).nextElementSibling; el && length < 8000; el = el.nextElementSibling) {
      const l = headingLevel(el);
      if (l && l <= level) break;
      if (el.matches('style, script, .navbox, .reflist, .mw-references-wrap, .mw-editsection')) continue;
      const text = (l ? `\n${cleanText(el)}\n` : el.innerText || el.textContent)
        .replace(/\[\d+\]|\[citation needed\]|\[[a-z]\]|\[edit\]/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n')
        .trim();
      if (!text) continue;
      parts.push(text);
      length += text.length;
    }
    return { name: stack[stack.length - 1].name, path: stack.map((x) => x.name).join(' › '), text: parts.join('\n').slice(0, 8000) };
  }

  function cleanText(el) {
    return el.textContent.replace(/\[\d+\]|\[citation needed\]|\[[a-z]\]/g, '').replace(/\s+/g, ' ').trim();
  }

  function contextSentence(a) {
    const block = a.closest('p, li, td, th, dd, figcaption, caption');
    if (!block) return a.textContent.trim();
    const text = cleanText(block);
    const i = text.indexOf(a.textContent.trim());
    if (i < 0) return text.slice(0, 240);
    const before = text.lastIndexOf('. ', i);
    const start = Math.max(before < 0 ? 0 : before + 2, i - 200);
    const after = text.indexOf('. ', i + a.textContent.length);
    const end = Math.min(after < 0 ? text.length : after + 1, i + 260);
    return text.slice(start, end);
  }

  // Where a link sits says a lot about how related it is: navigation boxes list a topic's members,
  // infoboxes hold key facts, and "Main article:" notes point to a section's own article.
  function linkSignal(el) {
    const nav = el.closest('.navbox');
    if (nav) {
      let outer = nav;
      while (outer.parentElement?.closest('.navbox')) outer = outer.parentElement.closest('.navbox');
      const titleEl = (outer.querySelector('.navbox-title') || outer).cloneNode(true);
      titleEl.querySelectorAll('.navbar').forEach((n) => n.remove()); // the "v · t · e" links
      const box = cleanText(titleEl).slice(0, 80);
      const group = el.closest('td.navbox-list')?.previousElementSibling;
      const label = group?.matches('th.navbox-group') ? cleanText(group) : '';
      return { kind: 'navbox', box, context: `Navigation box "${box}"${label ? ` › ${label}` : ''}` };
    }
    const row = el.closest('.infobox tr');
    if (row) {
      const th = row.querySelector('th');
      return { kind: 'infobox', context: `Infobox: ${th ? cleanText(th) + ': ' : ''}${cleanText(row.querySelector('td') || row).slice(0, 160)}` };
    }
    const hat = el.closest('.hatnote');
    if (hat) {
      const text = cleanText(hat);
      return { kind: /^(main articles?|further information)\b/i.test(text) ? 'main' : 'hatnote', context: text.slice(0, 200) };
    }
    return null;
  }

  function collectLinks() {
    if (links) return links;
    const map = new Map();
    let section = 'Introduction';
    for (const el of article.querySelectorAll('h2, h3, h4, a[href]')) {
      if (el.tagName !== 'A') {
        section = headingText(el);
        continue;
      }
      if (el.classList.contains('mw-selflink') || el.closest(SKIP_LINK_AREAS)) continue;
      const url = new URL(/** @type {HTMLAnchorElement} */ (el).href, location.href);
      const m = url.pathname.match(/^\/wiki\/([^#?]+)/);
      if (!m || !url.hostname.endsWith('wikipedia.org') || url.search) continue; // skips red links (?action=edit)
      const target = decodeURIComponent(m[1]).replace(/_/g, ' ');
      if (NON_ARTICLE_NS.test(target) || target === title) continue;
      const entry = map.get(target) || { title: target, count: 0, prose: [], other: [], sections: [], anchors: [], signals: new Set(), navboxes: new Set() };
      const anchor = el.textContent.trim();
      if (anchor && anchor !== target && !entry.anchors.includes(anchor) && entry.anchors.length < 3) entry.anchors.push(anchor);
      let signal = linkSignal(el);
      if (!signal && W.sections.isSeeAlso(section)) signal = { kind: 'seealso', context: `Listed under "${section}"` };
      if (signal) {
        entry.signals.add(signal.kind);
        if (signal.box) entry.navboxes.add(signal.box);
      }
      // Only mentions in the article's own text count; navigation boxes and back matter list links wholesale.
      const inText = !signal && !isBackMatter(section);
      if (inText || signal?.kind === 'main' || signal?.kind === 'infobox') entry.count++;
      if (inText) {
        if (entry.prose.length < 2) entry.prose.push(contextSentence(el));
        if (!entry.sections.includes(section) && entry.sections.length < 3) entry.sections.push(section);
      } else if (signal && entry.other.length < 2) entry.other.push(signal.context);
      map.set(target, entry);
    }
    links = [...map.values()].map((e) => ({
      title: e.title,
      anchors: e.anchors,
      count: e.count,
      context: [...e.prose, ...e.other].slice(0, 2).join(' … '),
      sections: e.sections,
      signals: [...e.signals],
      navboxes: [...e.navboxes],
    }));
    return links;
  }

  // A source quoted from another revision than the one on screen: its text may have changed since.
  const otherRevision = (src) => !!(src.revid && pageRevid && src.revid !== pageRevid);

  function pageInfo() {
    return {
      lang,
      title,
      revid: pageRevid,
      url: canonical,
      links: collectLinks(),
      categories: [...document.querySelectorAll('#mw-normal-catlinks li a')].map((a) => a.textContent.trim()),
      visibleSection: visibleSection(), // {name, path, text}
    };
  }

  // ---------- Highlighting a cited passage in the page ----------

  let textMap = null;
  function buildTextMap() {
    if (textMap) return textMap;
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement?.closest('sup.reference, .mw-editsection, style, script, .navbox, .reflist, .mw-references-wrap')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    let text = '';
    const nodes = [];
    const offsets = [];
    let space = true;
    for (let n; (n = walker.nextNode()); ) {
      const d = n.data;
      for (let i = 0; i < d.length; i++) {
        let ch = d[i];
        if (/\s/.test(ch)) {
          if (space) continue;
          ch = ' ';
          space = true;
        } else space = false;
        text += ch.toLowerCase();
        nodes.push(n);
        offsets.push(i);
      }
    }
    textMap = { text, nodes, offsets };
    return textMap;
  }

  const norm = (s) => s.replace(/\s+/g, ' ').toLowerCase().trim();

  function locate(sourceText) {
    const map = buildTextMap();
    const sentences = (sourceText.match(/[^.!?]+[.!?]*/g) || [sourceText]).map(norm).filter((s) => s.length > 20);
    let start = -1;
    for (const s of sentences.slice(0, 6)) {
      for (const probe of [s.slice(0, 60), s.slice(0, 30), s.slice(Math.floor(s.length / 2), Math.floor(s.length / 2) + 30)]) {
        if (probe.length < 15) continue;
        start = map.text.indexOf(probe);
        if (start >= 0) break;
      }
      if (start >= 0) break;
    }
    if (start < 0) return null;
    let end = start + Math.min(norm(sourceText).length, 400);
    const tail = norm(sourceText).slice(-40);
    const tailAt = map.text.indexOf(tail, start);
    if (tailAt >= 0 && tailAt - start < 4000) end = tailAt + tail.length;
    end = Math.min(end, map.text.length);
    const range = document.createRange();
    range.setStart(map.nodes[start], map.offsets[start]);
    range.setEnd(map.nodes[end - 1], map.offsets[end - 1] + 1);
    return range;
  }

  // A cited table passage ("Table: …", then "76 | Os | Osmium | …" rows) or infobox passage ("Born: …" lines):
  // the range from its first to its last row on the page, found by the rows' leading values or labels.
  // An image passage: its picture with the caption, found by the file name.
  function locateRows(sourceText) {
    const [head, ...lines] = sourceText.split('\n').filter((l) => !l.startsWith('Columns: '));
    if (head.startsWith('Figure')) {
      const file = lines.find((l) => l.startsWith('File: '))?.slice(6).replace(/ /g, '_');
      const link = file && [...article.querySelectorAll('a.mw-file-description')].find((a) => decodeURIComponent(a.getAttribute('href') || '').endsWith(`:${file}`));
      const box = link?.closest('figure, .gallerybox, td') || link;
      if (!box) return null;
      const range = document.createRange();
      range.selectNode(box);
      return range;
    }
    const n = (t) => t.replace(/\s+/g, ' ').trim().toLowerCase();
    const cellText = (c) => n(c.textContent.replace(/\[[^\]]{1,4}\]/g, '')); // without "[12]" footnote marks
    let rows = [];
    if (head.startsWith('Infobox')) {
      const labels = new Set(lines.map((l) => n(l.split(': ')[0])));
      rows = [...article.querySelectorAll('.infobox tr')].filter((tr) => {
        const th = tr.querySelector('th');
        return th && labels.has(cellText(th));
      });
    } else if (head.startsWith('Table')) {
      const wanted = lines.map((l) => l.split(' | ').map(n).filter(Boolean).slice(0, 3)).filter((v) => v.length > 1);
      const trs = [...article.querySelectorAll('table.wikitable tr')];
      rows = trs.filter((tr) => {
        const cells = [...tr.children].map(cellText);
        return wanted.some((v) => cells[0] === v[0] && v.slice(1).every((x) => cells.some((c) => c.includes(x))));
      });
    }
    if (!rows.length) return null;
    const range = document.createRange();
    range.setStartBefore(rows[0]);
    range.setEndAfter(rows[rows.length - 1]);
    return range;
  }

  function highlightSource(src) {
    let range = null;
    try {
      range = /^(Table|Infobox|Figure)\b/.test(src.text) ? locateRows(src.text) : locate(src.text);
    } catch {
      // the page changed under us: show the passage without a highlight
    }
    if (range) {
      if (globalThis.CSS?.highlights && globalThis.Highlight) CSS.highlights.set('wikiai-cite', new Highlight(range));
      const start = range.startContainer;
      const el = start.nodeType === Node.ELEMENT_NODE ? start.childNodes[range.startOffset] || start : start.parentElement; // a table row, or text
      openCollapsedAncestors(el);
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return true;
    }
    // The passage may have changed since it was quoted; the preview says so instead of guessing a place.
    if (otherRevision(src)) return false;
    const h = sectionHeading(src.section);
    if (h) {
      openCollapsedAncestors(h);
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    }
    return false;
  }

  // Each heading with its full path ("History › Early years"), built the way visibleSection() builds it.
  function headingPaths() {
    const stack = [];
    return headings().map((h) => {
      const level = Number(h.tagName[1]);
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, name: headingText(h) });
      return { h, path: stack.map((x) => x.name).join(' › ') };
    });
  }

  // The heading of a cited section: by its full path, else by its own name when only one heading has it, else
  // by its anchor (which keeps a heading's original id on some wikis after it is reworded).
  function sectionHeading(section) {
    const all = headingPaths();
    const exact = all.find((x) => x.path === section);
    if (exact) return exact.h;
    const name = section.split(' › ').pop();
    const named = all.filter((x) => headingText(x.h) === name);
    if (named.length === 1) return named[0].h;
    const id = name.replace(/ /g, '_');
    return all.find((x) => (x.h.id || x.h.querySelector('[id]')?.id) === id)?.h || null;
  }

  function openCollapsedAncestors(el) {
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
  }

  // Quoted Wikipedia text is CC BY-SA: name the source and the licence wherever it's shown.
  const LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';
  const licenseLine = (page, url) =>
    `<div class="license">Text from <a href="${url}" target="_blank" rel="noopener noreferrer">${W.text.esc(page ? `Wikipedia: ${page}` : 'Wikipedia')}</a>, <a href="${LICENSE_URL}" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a></div>`;

  const articleUrl = (src) => W.text.articleUrl(src.lang, src.page);

  // The revision a passage was quoted from, so the link shows the text that was cited.
  const versionUrl = (src) => (src.revid ? `https://${src.lang}.wikipedia.org/w/index.php?oldid=${src.revid}` : articleUrl(src));

  // A text fragment that finds the passage on the page. Table, infobox and figure passages start with labels
  // the page doesn't show ("Table: …"), so they're found by a cell, a value or the caption instead; prose by
  // its first and last words, which survives small edits in between.
  const fragmentText = (t) => encodeURIComponent(t).replace(/-/g, '%2D');
  const firstWords = (t, n) => t.replace(/\s+/g, ' ').trim().split(' ').slice(0, n).join(' ');
  function textFragment(src) {
    const [head = '', ...rest] = src.text.split('\n').filter((l) => !/^(Columns|File|Categories|Description): /.test(l));
    let start = '';
    let end = '';
    if (head.startsWith('Infobox')) start = firstWords(rest[0]?.split(': ').slice(1).join(': ') || '', 3);
    else if (head.startsWith('Table')) start = firstWords(rest[0]?.split(' | ').find((c) => c.trim().length >= 3) || '', 4);
    else if (head.startsWith('Figure')) start = firstWords(head.replace(/^Figure:\s*/, ''), 5);
    else {
      const words = src.text.replace(/\$[^$\n]*\$/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
      [start, end] = words.length > 10 ? [words.slice(0, 4).join(' '), words.slice(-4).join(' ')] : [words.join(' '), ''];
    }
    return start ? `#:~:text=${fragmentText(start)}${end ? `,${fragmentText(end)}` : ''}` : '';
  }

  function linkedUrl(src) {
    return `${versionUrl(src)}${textFragment(src)}`;
  }

  W.page = {
    article, canonical, lang, title, revid: pageRevid,
    headings, headingText, sectionOf, visibleSection, isBackMatter, collectLinks, pageInfo,
    otherRevision, highlightSource, licenseLine, articleUrl, linkedUrl,
  };
})(globalThis);
