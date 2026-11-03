// Sidebar UI on Wikipedia articles: chat, clickable citations, "ask about this" on selected text.
(() => {
  if (window.__wikiai) return;
  window.__wikiai = true;

  const W = globalThis.WikiAI;
  const article = document.querySelector('#mw-content-text .mw-parser-output');
  // Only main-namespace articles; the Main Page is in that namespace but is a portal of boxes.
  if (!article || !document.body.classList.contains('ns-0') || document.body.classList.contains('page-Main_Page')) return;

  const canonical = document.querySelector('link[rel=canonical]')?.href || location.href;
  const lang = new URL(canonical).hostname.split('.')[0];
  const title = decodeURIComponent(canonical.split('/wiki/')[1].split(/[#?]/)[0]).replace(/_/g, ' ');
  const PANEL_WIDTH = 420;

  const state = {
    open: false,
    busy: false,
    convs: [], // tabs: {id, scope, title, messages: [{role, content, steps, followups, branches, …}], sources, parentId, context}
    activeId: null,
    scope: null, // where the tabs are saved: the topic, or this article
    request: null, // the conversation an answer is streaming into
    pinQuestion: false, // keep the last question at the top, until the reader scrolls
    quote: null, // {text, section}
    port: null,
    links: null,
    topic: null, // active topic cluster
    view: 'chat', // 'chat', 'topic' or 'map'
    savedTopics: [],
    building: null, // progress text while a cluster is being built
    topicError: null,
    useTopicHere: null, // null: use the open topic only on its own articles; true/false: the reader chose
    allChats: [], // summaries of saved chats everywhere, for the history
    historyFilter: '',
    pendingChat: null, // a chat to open once its topic or article has loaded
  };

  // ---------- Page reading helpers ----------

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
    if (state.links) return state.links;
    const map = new Map();
    let section = 'Introduction';
    for (const el of article.querySelectorAll('h2, h3, h4, a[href]')) {
      if (el.tagName !== 'A') {
        section = headingText(el);
        continue;
      }
      if (el.classList.contains('mw-selflink') || el.closest(SKIP_LINK_AREAS)) continue;
      const url = new URL(el.href, location.href);
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
    state.links = [...map.values()].map((e) => ({
      title: e.title,
      anchors: e.anchors,
      count: e.count,
      context: [...e.prose, ...e.other].slice(0, 2).join(' … '),
      sections: e.sections,
      signals: [...e.signals],
      navboxes: [...e.navboxes],
    }));
    return state.links;
  }

  // The revision on screen, from the page's inline config (the content script can't reach mw.config).
  const pageRevid = (() => {
    for (const el of document.querySelectorAll('script:not([src])')) {
      const m = el.textContent.match(/"wgRevisionId"\s*:\s*(\d+)/);
      if (m) return Number(m[1]);
    }
    return 0;
  })();
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
    } catch {}
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
    const h = headings().find((x) => headingText(x) === src.section.split(' › ').pop());
    if (h) {
      openCollapsedAncestors(h);
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    }
    return false;
  }

  function openCollapsedAncestors(el) {
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
  }

  // Quoted Wikipedia text is CC BY-SA: name the source and the licence wherever it's shown.
  const LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';
  const licenseLine = (page, url) =>
    `<div class="license">Text from <a href="${url}" target="_blank" rel="noopener noreferrer">${W.markdown.esc(page ? `Wikipedia: ${page}` : 'Wikipedia')}</a>, <a href="${LICENSE_URL}" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a></div>`;

  function articleUrl(src) {
    return `https://${src.lang}.wikipedia.org/wiki/${encodeURIComponent(src.page.replace(/ /g, '_'))}`;
  }

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

  // ---------- UI ----------

  const host = document.createElement('div');
  host.id = 'wikiai-host';
  // Closed, so the page's own scripts can't read or change the chats. In the extension this variable lives in the
  // content script's isolated world, out of the page's reach; the test harness reads it to inspect the panel.
  const root = host.attachShadow({ mode: 'closed' });
  globalThis.__wikiaiRoot = root;
  root.innerHTML = `
    <link rel="stylesheet" href="${chrome.runtime.getURL('vendor/katex/katex.min.css')}">
    <link rel="stylesheet" href="${chrome.runtime.getURL('content/sidebar.css')}">
    <button class="launcher" title="Ask about this article (Alt+Shift+W)" aria-label="Open Wiki AI">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>
    </button>
    <button class="ask-selection" hidden>Ask about this</button>
    <aside class="panel" aria-label="Wiki AI" hidden>
      <header>
        <img class="mark" src="${chrome.runtime.getURL('icons/mascot.svg')}" alt="">
        <div class="titles">
          <img class="name" src="${chrome.runtime.getURL('icons/wordmark.svg')}" alt="Wiki AI">
          <div class="sub"></div>
        </div>
        <button class="icon new" title="New chat" aria-label="New chat">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        <button class="icon settings" title="Settings" aria-label="Settings">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
        </button>
        <button class="icon close" title="Close" aria-label="Close">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </header>
      <nav class="views" role="tablist" aria-label="Sidebar sections">
        <button class="view-btn active" role="tab" aria-selected="true" data-view="chat">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>
          Chat<span class="dot" hidden></span></button>
        <button class="view-btn" role="tab" aria-selected="false" data-view="topic">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="7" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.3 6.4l7.4.4M7.3 8.2l3.6 7.6M16.8 9.2l-3.6 6.6"/></svg>
          Topic<span class="dot" hidden></span></button>
        <button class="view-btn" role="tab" aria-selected="false" data-view="map">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><circle cx="4" cy="5" r="2"/><circle cx="20" cy="5" r="2"/><circle cx="4" cy="19" r="2"/><circle cx="20" cy="19" r="2"/><path d="M9.6 10.2L5.5 6.4M14.4 10.2l4.1-3.8M9.6 13.8l-4.1 3.8M14.4 13.8l4.1 3.8"/></svg>
          Map</button>
        <button class="view-btn" role="tab" aria-selected="false" data-view="history">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
          History</button>
      </nav>
      <section class="view view-topic" role="tabpanel" hidden><div class="topic"></div></section>
      <section class="view view-map" role="tabpanel" hidden></section>
      <section class="view view-history" role="tabpanel" hidden><div class="history-view"></div></section>
      <section class="view view-chat" role="tabpanel">
      <div class="scope-bar" hidden></div>
      <div class="chat-bar"></div>
      <div class="messages" role="region" aria-label="Conversation"></div>
      <div class="sr-only live" aria-live="polite" aria-atomic="true"></div>
      <div class="preview" hidden></div>
      <form class="composer">
        <div class="quote" hidden></div>
        <div class="row">
          <textarea rows="1" maxlength="4000" placeholder="Ask about this article…" aria-label="Your question"></textarea>
          <button type="submit" class="send" title="Send" aria-label="Send">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </button>
        </div>
      </form>
      </section>
    </aside>`;
  document.documentElement.appendChild(host);

  // Highlight style has to live in the page, outside the shadow root.
  const pageStyle = document.createElement('style');
  pageStyle.textContent = `
    ::highlight(wikiai-cite) { background-color: rgba(255, 196, 0, 0.45); color: inherit; }
    html.wikiai-open body { margin-right: ${PANEL_WIDTH}px !important; }
    html.wikiai-open .vector-sticky-header { right: ${PANEL_WIDTH}px !important; width: auto !important; }
    html.wikiai-open, html.wikiai-open body { overflow: auto !important; }
    /* Wide data tables scroll on their own instead of running under the panel. */
    html.wikiai-open .mw-parser-output table.wikitable { display: block; max-width: 100%; overflow-x: auto; }`;
  document.head.appendChild(pageStyle);
  // KaTeX's fonts: Chrome ignores @font-face inside a shadow root, so the page loads them too (its rules only
  // touch .katex elements, which Wikipedia doesn't use).
  const katexFonts = document.createElement('link');
  katexFonts.rel = 'stylesheet';
  katexFonts.href = chrome.runtime.getURL('vendor/katex/katex.min.css');
  document.head.appendChild(katexFonts);

  const $ = (sel) => root.querySelector(sel);
  const panel = $('.panel');
  const launcher = $('.launcher');
  const messagesEl = $('.messages');
  const input = $('textarea');
  const sendBtn = $('.send');
  const quoteEl = $('.quote');
  const previewEl = $('.preview');
  const askSelBtn = $('.ask-selection');
  const topicEl = $('.topic');
  const navEl = $('.views');
  const chatView = $('.view-chat');
  const topicView = $('.view-topic');
  const mapView = $('.view-map');
  const historyView = $('.view-history');
  const historyEl = $('.history-view');
  const chatBar = $('.chat-bar');
  const scopeBar = $('.scope-bar');
  $('.sub').textContent = title;

  function syncTheme() {
    const cls = document.documentElement.classList;
    const dark =
      cls.contains('skin-theme-clientpref-night') ||
      (cls.contains('skin-theme-clientpref-os') && matchMedia('(prefers-color-scheme: dark)').matches);
    host.dataset.theme = dark ? 'dark' : 'light';
  }
  syncTheme();
  new MutationObserver(() => {
    syncTheme();
    // Wikipedia's own scripts may re-pin the column after the panel opened (e.g. on page load).
    if (state.open && PINNED_RIGHT.some(([pinned]) => document.documentElement.classList.contains(pinned))) unpinWikipediaColumn(true);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme);

  // Vector 2022's pinned right column (Appearance, Tools) moves into its dropdown menus while the panel is open,
  // so the article keeps its width. Only the page's classes change; the user's saved preference is untouched.
  const PINNED_RIGHT = [
    ['vector-feature-appearance-pinned-clientpref-1', 'vector-feature-appearance-pinned-clientpref-0'],
    ['vector-feature-page-tools-pinned-enabled', 'vector-feature-page-tools-pinned-disabled'],
  ];
  let unpinned = [];
  function unpinWikipediaColumn(open) {
    const cls = document.documentElement.classList;
    if (open) {
      for (const pair of PINNED_RIGHT) {
        if (!cls.contains(pair[0])) continue;
        cls.replace(pair[0], pair[1]);
        if (!unpinned.includes(pair)) unpinned.push(pair);
      }
    } else {
      for (const [pinned, hidden] of unpinned) cls.replace(hidden, pinned);
      unpinned = [];
    }
  }

  // Whether the panel is open, and in which section, is remembered per browser tab (sessionStorage),
  // so following a link to another article keeps it open.
  const remember = (key, value) => {
    try {
      sessionStorage.setItem(`wikiai:${key}`, value);
    } catch {}
  };
  const recall = (key) => {
    try {
      return sessionStorage.getItem(`wikiai:${key}`);
    } catch {
      return null;
    }
  };

  // Hand-off to new tabs: when the panel is open and the reader presses on an article link, note the link
  // briefly; if that article opens in a new tab soon after, the panel opens there too.
  const HANDOFF_MS = 2 * 60 * 1000;
  // Kept by the service worker: extension storage is closed to content scripts.
  const handoffStore = {
    get: () => send({ type: 'handoff:get' }).then((list) => list || [], () => []),
    set: (list) => send({ type: 'handoff:set', list }).catch(() => {}),
  };
  const pathOf = (url) => {
    try {
      const u = new URL(url, location.href);
      return decodeURIComponent(u.pathname).replace(/_/g, ' ');
    } catch {
      return '';
    }
  };

  async function noteLink(a) {
    if (!state.open || !/\/wiki\//.test(a.href)) return;
    const list = (await handoffStore.get()).filter((h) => Date.now() - h.at < HANDOFF_MS).slice(-4);
    list.push({ path: pathOf(a.href), view: state.view, at: Date.now() });
    handoffStore.set(list);
  }

  // Was this page opened from a link pressed while the panel was open? Returns the section to show.
  async function takeHandoff() {
    const list = await handoffStore.get();
    const here = [pathOf(location.href), pathOf(canonical)];
    const fresh = list.filter((h) => Date.now() - h.at < HANDOFF_MS);
    const match = fresh.find((h) => here.includes(h.path));
    if (match) handoffStore.set(fresh.filter((h) => h !== match));
    return match || null;
  }

  function setOpen(open, { focus = true } = {}) {
    state.open = open;
    remember('open', open ? '1' : '0');
    panel.hidden = !open;
    launcher.hidden = open;
    document.documentElement.classList.toggle('wikiai-open', open);
    unpinWikipediaColumn(open);
    if (!open) {
      closeMap?.();
      unmountMap?.();
    } else if (state.view === 'map') renderMapView();
    if (open) {
      render();
      refreshTopic();
      if (focus) setTimeout(() => input.focus(), 0);
    }
  }

  // ---------- Topic clusters ----------

  // After the extension is reloaded or updated, this script stays on the page but loses its connection
  // (chrome.runtime goes away). Show a reload prompt instead of failing on every click; nothing throws,
  // so Chrome doesn't list an error for the extension.
  const extensionAlive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  function ensureAlive() {
    if (extensionAlive()) return true;
    messagesEl.innerHTML = `<div class="stale">Wiki AI was updated or reloaded. <button class="link reload-page">Reload this page</button> to keep using it.</div>`;
    topicEl.innerHTML = '';
    return false;
  }

  function openOptions() {
    if (ensureAlive()) chrome.runtime.sendMessage({ type: 'openOptions' });
  }

  async function send(msg) {
    if (!ensureAlive()) return new Promise(() => {}); // nothing will answer; callers just stop here
    const res = await chrome.runtime.sendMessage(msg);
    if (res?.error) throw new Error(res.error);
    return res?.result;
  }

  async function refreshTopic() {
    await loadLanguage();
    try {
      // A topic opened on purpose stays; otherwise the one that has this article, so the scope fits the page.
      state.topic = await send(state.useTopicHere === true ? { type: 'topics:active' } : { type: 'topics:forPage', lang, title });
      state.savedTopics = await send({ type: 'topics:list' });
    } catch {}
    renderTopic();
    if (state.view === 'map') renderMapView();
    if (currentScope() !== state.scope) await loadConversations();
    else {
      renderChatBar();
      render();
    }
  }

  const inTopic = () => !!state.topic?.pages.some((p) => p.title === title);
  // The topic chats on this page use: the open topic on its own articles, this article alone elsewhere,
  // unless the reader switched.
  const topicHere = () => (state.topic && (state.useTopicHere ?? inTopic()) ? state.topic : null);

  async function setScope(useTopic) {
    state.useTopicHere = useTopic;
    if (currentScope() !== state.scope) await loadConversations();
    renderChatBar();
    renderTopic();
  }
  // l: the Wikipedia the article is on; a topic's articles can be in another language than this page.
  const wikiUrl = (t, l = lang) => `https://${l}.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, '_'))}`;

  const truncate = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  const esc = (v) => W.markdown.esc(String(v ?? ''));
  const normQ = (q) => W.markdown.plain(q).toLowerCase().replace(/\s+/g, ' ').trim();
  const DOC_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/></svg>`;
  const CHAT_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>`;
  const MAP_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><circle cx="4" cy="5" r="2"/><circle cx="20" cy="5" r="2"/><circle cx="4" cy="19" r="2"/><circle cx="20" cy="19" r="2"/><path d="M9.6 10.2L5.5 6.4M14.4 10.2l4.1-3.8M9.6 13.8l-4.1 3.8M14.4 13.8l4.1 3.8"/></svg>`;
  const CLOSE_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
  const PLUS_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;
  const GRAPH_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="7" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.3 6.4l7.4.4M7.3 8.2l3.6 7.6M16.8 9.2l-3.6 6.6"/></svg>`;

  // ---------- Views: Chat, Topic, Map ----------

  function setView(view) {
    state.view = view;
    remember('view', view);
    for (const b of navEl.querySelectorAll('.view-btn')) {
      const on = b.dataset.view === view;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on);
    }
    chatView.hidden = view !== 'chat';
    topicView.hidden = view !== 'topic';
    mapView.hidden = view !== 'map';
    historyView.hidden = view !== 'history';
    if (view !== 'map') unmountMap?.();
    if (view === 'topic') renderTopic();
    if (view === 'map') renderMapView();
    if (view === 'history') {
      renderHistory();
      loadAllChats();
    }
    if (view === 'chat') {
      renderChatBar();
      render(true);
    }
  }

  function renderNav() {
    navEl.querySelector('[data-view="chat"] .dot').hidden = !state.busy;
    navEl.querySelector('[data-view="topic"] .dot').hidden = !state.building;
  }

  // ---------- Topic view ----------

  function renderTopic() {
    input.placeholder = state.quote
      ? 'Ask about the selected text…'
      : topicHere()
        ? `Ask across all ${topicHere().pages.length} articles…`
        : 'Ask about this article…';
    renderNav();
    if (state.view !== 'topic') return;
    const t = state.topic;
    const parts = [];
    if (state.topicError) parts.push(`<div class="${state.topicNote ? 'topic-note' : 'topic-error'}">${esc(state.topicError)}</div>`);
    if (!t && !state.building) {
      parts.push(`
        <div class="topic-head empty">
          <p>Questions now use <strong>${esc(title)}</strong> and the articles it links to. A topic cluster lets you explore a subject across many articles: the AI groups this article's most relevant links into themes, and answers search all of them.</p>
          <button class="primary build-topic">Build topic cluster</button>
        </div>`);
      parts.push(savedTopicsSection());
    } else {
      // The open topic is the first card in the list, with its themes inside it; other saved topics follow, collapsed.
      const newBtn = state.building
        ? ''
        : `<button class="pill new-topic build-topic" title="Build a new topic cluster starting from “${esc(title)}”">${PLUS_ICON}New topic</button>`;
      const building = state.building
        ? `<div class="topic-head building"><span class="dot"></span><span class="topic-status">${esc(state.building)}</span><button class="link stop-topic">Stop</button></div>`
        : '';
      parts.push(`
        <section class="block topics">
          <div class="block-head"><h4>Your topics</h4>${newBtn}</div>
          ${building}
          ${t ? openTopicCard(t) : ''}
          ${savedTopicCards()}
        </section>`);
    }
    parts.push(exploreSection());
    topicEl.innerHTML = parts.join('');
  }

  // Suggested questions that haven't been asked yet, from every chat saved here (newest chats first).
  function unexplored() {
    const asked = new Set(state.convs.flatMap((c) => c.messages.filter((m) => m.role === 'user').map((m) => normQ(m.content))));
    const seen = new Set();
    const groups = [];
    const byRecent = [...state.convs].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    for (const c of byRecent) {
      c.messages.forEach((m, i) => {
        if (m.role !== 'assistant' || !m.followups?.length) return;
        const items = m.followups.map((q) => W.markdown.plain(q)).filter((q) => !asked.has(normQ(q)) && !seen.has(normQ(q)));
        items.forEach((q) => seen.add(normQ(q)));
        if (items.length) groups.push({ convId: c.id, from: c.messages[i - 1]?.content || c.title, items });
      });
    }
    return groups;
  }

  function exploreSection() {
    const groups = unexplored();
    if (!groups.length) return '';
    const count = groups.reduce((n, g) => n + g.items.length, 0);
    return `
      <section class="block explore">
        <h4>Questions to explore <span class="count">${count}</span></h4>
        <p class="why">Suggestions from your chats that you haven't asked yet. Asking one continues the chat it came from.</p>
        ${groups
          .map(
            (g) => `<div class="explore-group">
              <div class="explore-from">After “${esc(truncate(g.from, 80))}”</div>
              ${g.items.map((q) => `<button class="followup explore-q" data-conv="${g.convId}" data-q="${esc(q)}">${esc(q)}</button>`).join('')}
            </div>`
          )
          .join('')}
      </section>`;
  }

  function themesSection(t) {
    const pageRow = (p) => `
      <li class="${p.title === title ? 'here' : ''}">
        <a href="${wikiUrl(p.title, t.lang)}" title="${esc(p.summary || p.description || '')}">${esc(p.title)}</a>
        ${p.title === title ? '<span class="tag">you are here</span>' : ''}
        ${p.description ? `<span class="desc">${esc(p.description)}</span>` : ''}
        ${p.seed ? '' : `<button class="icon remove-page" data-title="${esc(p.title)}" title="Remove from topic" aria-label="Remove ${esc(p.title)} from topic">×</button>`}
      </li>`;
    const seed = t.pages.filter((p) => p.seed);
    const facets = t.facets
      .map((f) => {
        const pages = t.pages.filter((p) => p.facet === f.name);
        if (!pages.length) return '';
        return `<div class="facet"><h5>${esc(f.name)}</h5>${f.why ? `<p class="why">${esc(f.why)}</p>` : ''}<ul>${pages.map(pageRow).join('')}</ul></div>`;
      })
      .join('');
    return `
      <section class="topic-card-body">
        <h4>Themes and articles</h4>
        ${seed.length ? `<ul class="seed">${seed.map(pageRow).join('')}</ul>` : ''}
        ${facets}
      </section>`;
  }

  function openTopicCard(t) {
    return `
      <article class="topic-card open">
        <div class="topic-card-head">
          <div class="topic-title">${GRAPH_ICON}<div class="grow"><div class="topic-name">${esc(t.name)}</div><div class="topic-meta">${t.pages.length} articles · ${t.facets.length} themes</div></div>
            <button class="icon leave-topic" title="Close topic (it stays saved)" aria-label="Close topic">${CLOSE_ICON}</button>
          </div>
          ${inTopic() ? '' : `<div class="notice">This article isn't in the topic. <button class="link add-page">Add it</button></div>`}
          <div class="topic-actions">
            <button class="pill primary-pill chat-topic" title="Ask questions across every article in this topic">${CHAT_ICON}Chat</button>
            <button class="pill go-map" title="See how the articles connect">${MAP_ICON}Map</button>
          </div>
        </div>
        ${state.building ? '' : themesSection(t)}
      </article>`;
  }

  // Saved topics other than the open one, as collapsed cards.
  function savedTopicCards() {
    return state.savedTopics
      .filter((t) => t.id !== state.topic?.id)
      .map(
        (t) => `
        <div class="topic-card saved">
          <div class="topic-title">${GRAPH_ICON}<div class="grow">
            <button class="open-topic" data-id="${t.id}" title="Open this topic">${esc(t.name)}</button>
            <div class="topic-meta">${t.pages} articles · ${t.facets} themes · from “${esc(t.seed)}”</div>
          </div>
            <button class="icon delete-topic" data-id="${t.id}" title="Delete topic" aria-label="Delete ${esc(t.name)}">×</button>
          </div>
        </div>`
      )
      .join('');
  }

  function savedTopicsSection() {
    const cards = savedTopicCards();
    return cards ? `<section class="block topics"><h4>Saved topics</h4>${cards}</section>` : '';
  }

  const BUILDING = 'Generating topic cluster…';

  function buildTopic() {
    if (!ensureAlive()) return;
    if (isDisambiguation()) {
      state.topicNote = true; // guidance, not a failure
      state.topicError = `“${title}” is a disambiguation page: it lists different meanings, so there's no single subject to build a topic around. Open the meaning you want and build the topic there.`;
      if (state.view !== 'topic') setView('topic');
      else renderTopic();
      return;
    }
    state.building = BUILDING;
    state.topicError = null;
    state.topicNote = false;
    renderTopic();
    renderScopeBar();
    connect().postMessage({ type: 'buildTopic', page: pageInfo() });
  }

  async function topicAction(fn) {
    state.topicError = null;
    state.topicNote = false;
    try {
      await fn();
    } catch (e) {
      state.topicError = e.message;
      state.topicNote = false;
    }
    await refreshTopic();
  }

  // ---------- Map view ----------

  let unmountMap = null;
  let closeMap = null;

  function mapOptions() {
    const t = state.topic;
    const facets = t.facets.map((f) => f.name);
    return {
      root,
      topic: t,
      currentTitle: title,
      colorOf: (p) => (p.seed ? 'c0' : `c${(Math.max(0, facets.indexOf(p.facet)) % 7) + 1}`),
      onOpenArticle: (t2) => (location.href = wikiUrl(t2, t.lang)),
      onList: () => {
        closeMap?.();
        setView('topic');
      },
      onAsk: async (t2) => {
        closeMap?.();
        setView('chat');
        if (!topicHere()) await setScope(true);
        const q = phrases().about(t2);
        if (state.busy) {
          input.value = q;
          autosize();
        } else ask(q);
      },
    };
  }

  function renderMapView() {
    unmountMap?.();
    unmountMap = null;
    if (!state.topic) {
      mapView.innerHTML = `
        <div class="map-empty">
          <p>The map shows a topic cluster's articles and how they link to each other.</p>
          ${state.building ? `<p><span class="dot"></span> ${esc(state.building)}</p>` : '<button class="primary build-topic">Build a topic from this article</button>'}
          <div class="topic">${savedTopicsSection()}</div>
        </div>`;
      return;
    }
    mapView.innerHTML = '<div class="map-host"></div>';
    unmountMap = W.topicMap.mount(mapView.querySelector('.map-host'), { ...mapOptions(), onExpand: showMap });
  }

  // The large version over the article area, next to the sidebar.
  function showMap() {
    if (!state.topic) return;
    closeMap = W.topicMap.open({ ...mapOptions(), rightInset: state.open ? PANEL_WIDTH : 0 });
  }

  // ---------- Chats ----------

  const newConv = (extra = {}) => ({
    id: `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    scope: state.scope,
    title: '',
    messages: [],
    sources: [],
    createdAt: Date.now(),
    ...extra,
  });
  const conv = () => state.convs.find((c) => c.id === state.activeId) || state.convs[0];
  const convById = (id) => state.convs.find((c) => c.id === id);
  const currentScope = () => (topicHere() ? `topic:${topicHere().id}` : `page:${lang}:${title}`);

  async function loadConversations() {
    state.scope = currentScope();
    let saved = [];
    try {
      saved = (await send({ type: 'conv:list', scope: state.scope })) || [];
    } catch {}
    // Keep a conversation that is still answering, even if it belongs elsewhere.
    const running = state.request && !saved.some((c) => c.id === state.request.id) ? [state.request] : [];
    state.convs = [...saved, ...running];
    const latest = [...state.convs].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))[0];
    if (!latest) state.convs.push(newConv());
    state.activeId = (latest || state.convs[0]).id;
    renderChatBar();
    render();
    if (state.view === 'topic') renderTopic();
    applyPendingChat();
  }

  function saveConv(c) {
    send({ type: 'conv:save', scope: c.scope || state.scope, conv: c }).then(
      () => state.saveError && ((state.saveError = null), renderChatBar()),
      (e) => {
        state.saveError = `This chat couldn't be saved (${e.message}). It stays open until you leave the page.`;
        renderChatBar();
      }
    );
  }

  function openChat(id) {
    if (!convById(id)) return;
    const cur = conv();
    if (cur) cur.scrollTop = messagesEl.scrollTop;
    state.activeId = id;
    previewEl.hidden = true;
    if (state.view !== 'chat') setView('chat');
    renderChatBar();
    render(true);
  }

  function newChat() {
    const empty = state.convs.find((c) => !c.messages.length);
    const c = empty || newConv();
    if (!empty) state.convs.push(c);
    openChat(c.id);
    input.focus();
  }

  function deleteChat(id) {
    const c = convById(id);
    if (!c) return;
    if (state.request === c) state.port?.postMessage({ type: 'stop' });
    state.convs = state.convs.filter((x) => x !== c);
    // Also from the History's list of saved chats, which would otherwise show it again as "saved in another tab".
    state.allChats = state.allChats.filter((x) => x.id !== id);
    if (c.messages.length) send({ type: 'conv:delete', scope: c.scope || state.scope, id }).catch(() => {});
    if (!state.convs.length) state.convs.push(newConv());
    if (state.activeId === id) state.activeId = state.convs[state.convs.length - 1].id;
    renderChatBar();
    render();
    if (state.view === 'history') renderHistoryLists();
  }

  // Suggested questions continue the chat they were suggested in.
  function askSuggested(question, c = conv()) {
    if (c !== conv()) openChat(c.id);
    if (state.view !== 'chat') setView('chat');
    if (state.busy) {
      input.value = question; // an answer is still running; send it when that's done
      autosize();
      input.focus();
    } else ask(question, c);
  }

  // "Ask about: [this article] [the topic]" whenever a topic is open, plus a quick way to start a new topic.
  function renderScopeBar() {
    if (state.building) {
      scopeBar.hidden = false;
      scopeBar.innerHTML = `<span class="dot"></span><span class="scope-status">${esc(state.building)}</span><button class="link stop-topic">Stop</button>`;
      return;
    }
    const t = state.topic;
    // Offer the topic only where it fits: on its own articles, or after the reader chose it here.
    scopeBar.hidden = !t || !(inTopic() || topicHere());
    if (scopeBar.hidden) return;
    const usingTopic = !!topicHere();
    const caption = usingTopic
      ? `Searching ${t.pages.length === 1 ? 'the 1 article' : `all ${t.pages.length} articles`} in the topic “${esc(t.name)}”`
      : `Searching “${esc(title)}” and the articles it links to`;
    scopeBar.innerHTML = `
      <div class="scope-row">
        <span class="scope-label">Answers use</span>
        <span class="seg" role="radiogroup" aria-label="Answers use">
          <button class="seg-btn scope-article${usingTopic ? '' : ' on'}" role="radio" aria-checked="${!usingTopic}">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/></svg>
            This article
          </button>
          <button class="seg-btn scope-topic${usingTopic ? ' on' : ''}" role="radio" aria-checked="${usingTopic}">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="7" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.3 6.4l7.4.4M7.3 8.2l3.6 7.6M16.8 9.2l-3.6 6.6"/></svg>
            Topic · ${t.pages.length} article${t.pages.length === 1 ? '' : 's'}
          </button>
        </span>
      </div>
      <div class="scope-caption">${caption}${inTopic() ? '' : ' · <button class="link build-topic" title="Build a topic cluster starting from this article">New topic from this article</button>'}</div>`;
  }

  function renderChatBar() {
    renderScopeBar();
    const c = conv();
    chatBar.innerHTML = `
      <span class="chat-title" title="${esc(c?.title || '')}">${esc(truncate(c?.title || (topicHere() ? 'New topic chat' : 'New chat'), 52))}</span>
      <button class="link new-chat">New chat</button>
      ${state.saveError ? `<div class="save-error" role="alert">${esc(state.saveError)}</div>` : ''}`;
    renderNav();
  }

  const ago = (ts) => {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    return new Date(ts).toLocaleDateString();
  };

  // ---------- History across all topics and articles ----------

  async function loadAllChats() {
    try {
      state.allChats = (await send({ type: 'conv:all' })) || [];
      state.savedTopics = await send({ type: 'topics:list' });
    } catch {
      state.allChats = [];
    }
    if (state.view === 'history') renderHistoryLists();
  }

  function scopeLabel(scope) {
    if (scope.startsWith('topic:')) {
      const t = state.savedTopics.find((x) => x.id === scope.slice(6));
      return { kind: 'topic', name: t ? t.name : 'Deleted topic' };
    }
    const [, l, ...rest] = scope.split(':');
    const name = rest.join(':');
    return { kind: 'article', name: l === lang ? name : `${name} (${l})` };
  }

  function renderHistory() {
    if (!historyEl.querySelector('.history-search')) {
      historyEl.innerHTML = `
        <div class="history">
          <input class="history-search" type="search" placeholder="Search your chats" aria-label="Search your chats">
          <div class="history-lists"></div>
        </div>`;
      const box = historyEl.querySelector('.history-search');
      box.value = state.historyFilter;
      box.addEventListener('input', () => {
        state.historyFilter = box.value;
        renderHistoryLists();
      });
      box.addEventListener('keydown', (e) => e.stopPropagation());
    }
    renderHistoryLists();
  }

  function renderHistoryLists() {
    const listEl = historyEl.querySelector('.history-lists');
    if (!listEl) return;
    const q = state.historyFilter.trim().toLowerCase();
    // Matches the title or anything said in the chat.
    const match = (c) => !q || [c.title, c.text ?? c.messages?.map((m) => m.content || '').join('\n')].some((t) => (t || '').toLowerCase().includes(q));
    const row = ({ scope, id, title: t, questions, updatedAt, here, running }) => `
      <li class="${here ? 'here' : ''}">
        <button class="link ${scope ? 'open-saved-chat' : 'open-chat'}" data-id="${id}" ${scope ? `data-scope="${esc(scope)}"` : ''}>${esc(truncate(t || 'Chat', 70))}</button>
        <span class="desc">${questions} question${questions === 1 ? '' : 's'} · ${ago(updatedAt)}${running ? ' · answering…' : ''}</span>
        <button class="icon ${scope ? 'delete-saved-chat' : 'delete-chat'}" data-id="${id}" ${scope ? `data-scope="${esc(scope)}"` : ''} title="Delete chat" aria-label="Delete chat">×</button>
      </li>`;

    const here = state.convs
      .filter((c) => c.messages.length && match(c))
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
      .map((c) => row({ id: c.id, title: c.title, questions: c.messages.filter((m) => m.role === 'user').length, updatedAt: c.updatedAt || c.createdAt, here: c.id === conv()?.id, running: state.request === c }));
    for (const c of state.allChats) {
      if (c.scope === state.scope && !convById(c.id) && match(c)) here.push(row(c)); // saved in another tab
    }
    const where = topicHere() ? `in the topic “${esc(topicHere().name)}”` : `about “${esc(title)}”`;

    const groups = new Map();
    for (const c of state.allChats) {
      if (c.scope === state.scope || !match(c)) continue;
      if (!groups.has(c.scope)) groups.set(c.scope, []);
      groups.get(c.scope).push(c);
    }
    const others = [...groups]
      .map(([scope, chats]) => {
        const label = scopeLabel(scope);
        const icon = label.kind === 'topic' ? GRAPH_ICON : DOC_ICON;
        // A chat about this very article, kept separately from the topic's chats.
        const tag = label.kind === 'topic' ? 'topic' : scope === `page:${lang}:${title}` ? 'this article, without the topic' : 'article';
        return `<div class="history-group">
          <div class="history-scope ${label.kind}">${icon}<span>${esc(label.name)}</span><span class="tag">· ${tag}</span></div>
          <ul>${chats.map((c) => row(c)).join('')}</ul>
        </div>`;
      })
      .join('');

    listEl.innerHTML = `
      <h4>Chats ${where}</h4>
      ${here.length ? `<ul>${here.join('')}</ul>` : `<p class="why">${q ? 'No matching chats here.' : 'No saved chats here yet.'}</p>`}
      ${others ? `<h4>Other topics and articles</h4>${others}` : ''}`;
  }

  function applyPendingChat() {
    if (!state.pendingChat) return;
    const c = convById(state.pendingChat);
    state.pendingChat = null;
    if (c) openChat(c.id);
  }

  // Opens a saved chat from anywhere: topic chats right here, article chats on their article.
  async function openSavedChat(scope, id) {
    if (scope === state.scope) {
      if (!convById(id)) {
        const saved = (await send({ type: 'conv:list', scope }).catch(() => [])) || [];
        state.convs.push(...saved.filter((c) => !convById(c.id)));
      }
      return openChat(id);
    }
    state.pendingChat = id;
    if (scope.startsWith('topic:')) {
      state.useTopicHere = true;
      await topicAction(() => send({ type: 'topics:setActive', id: scope.slice(6) }));
      return;
    }
    const [, l, ...rest] = scope.split(':');
    const t = rest.join(':');
    if (l === lang && t === title) {
      await setScope(false);
      applyPendingChat();
      return;
    }
    const url = `https://${l}.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, '_'))}`;
    const list = (await handoffStore.get()).filter((h) => Date.now() - h.at < HANDOFF_MS).slice(-4);
    list.push({ path: pathOf(url), view: 'chat', chat: id, scope, at: Date.now() });
    await handoffStore.set(list);
    location.href = url;
  }

  const W_ADDED = 'Added by you';
  // Starter questions in the answer language (Settings › Answer language); English for other languages.
  const PHRASES = {
    en: {
      summary: 'Summarize this article in a few bullet points',
      summaryOf: (t) => `Summarize “${t}” in a few bullet points`,
      explain: (x) => `Explain the section “${x}”`,
      meanings: (t) => `Which meanings of “${t}” are listed here?`,
      whatIs: (x) => `What is “${x}”?`,
      section: 'Explain the section I am reading',
      readNext: 'Which linked articles should I read next, and why?',
      overview: 'Give me an overview of this topic and its main themes',
      connect: (a, b) => `How is “${a}” connected to “${b}”?`,
      connected: 'How are the articles in this topic connected?',
      theme: (c) => `What should I know about “${c}”?`,
      readFirst: 'Which articles in this topic should I read first, and why?',
      fit: (x) => `How does ${x} fit into this topic?`,
      about: (x) => `Tell me about ${x} and how it connects to the rest of this topic.`,
    },
    de: {
      summary: 'Fasse diesen Artikel in ein paar Stichpunkten zusammen',
      summaryOf: (t) => `Fasse „${t}“ in ein paar Stichpunkten zusammen`,
      explain: (x) => `Erkläre den Abschnitt „${x}“`,
      meanings: (t) => `Welche Bedeutungen von „${t}“ werden hier aufgeführt?`,
      whatIs: (x) => `Was ist „${x}“?`,
      section: 'Erkläre den Abschnitt, den ich gerade lese',
      readNext: 'Welche verlinkten Artikel sollte ich als Nächstes lesen, und warum?',
      overview: 'Gib mir einen Überblick über dieses Thema und seine wichtigsten Schwerpunkte',
      connect: (a, b) => `Wie hängt „${a}“ mit „${b}“ zusammen?`,
      connected: 'Wie hängen die Artikel dieses Themas zusammen?',
      theme: (c) => `Was sollte ich über „${c}“ wissen?`,
      readFirst: 'Welche Artikel dieses Themas sollte ich zuerst lesen, und warum?',
      fit: (x) => `Wie passt ${x} in dieses Thema?`,
      about: (x) => `Erzähl mir von ${x} und wie es mit dem Rest dieses Themas zusammenhängt.`,
    },
    fr: {
      summary: 'Résume cet article en quelques points',
      summaryOf: (t) => `Résume « ${t} » en quelques points`,
      explain: (x) => `Explique la section « ${x} »`,
      meanings: (t) => `Quels sens de « ${t} » sont listés ici ?`,
      whatIs: (x) => `Qu'est-ce que « ${x} » ?`,
      section: 'Explique la section que je lis',
      readNext: 'Quels articles liés devrais-je lire ensuite, et pourquoi ?',
      overview: "Donne-moi une vue d'ensemble de ce sujet et de ses thèmes principaux",
      connect: (a, b) => `Quel est le lien entre « ${a} » et « ${b} » ?`,
      connected: 'Quels liens existent entre les articles de ce sujet ?',
      theme: (c) => `Que faut-il savoir sur « ${c} » ?`,
      readFirst: 'Quels articles de ce sujet devrais-je lire en premier, et pourquoi ?',
      fit: (x) => `Quelle place occupe ${x} dans ce sujet ?`,
      about: (x) => `Parle-moi de ${x} et de ses liens avec le reste de ce sujet.`,
    },
    es: {
      summary: 'Resume este artículo en unos pocos puntos',
      summaryOf: (t) => `Resume «${t}» en unos pocos puntos`,
      explain: (x) => `Explica la sección «${x}»`,
      meanings: (t) => `¿Qué significados de «${t}» aparecen aquí?`,
      whatIs: (x) => `¿Qué es «${x}»?`,
      section: 'Explica la sección que estoy leyendo',
      readNext: '¿Qué artículos enlazados debería leer a continuación y por qué?',
      overview: 'Dame una visión general de este tema y sus aspectos principales',
      connect: (a, b) => `¿Qué relación hay entre «${a}» y «${b}»?`,
      connected: '¿Cómo se relacionan los artículos de este tema?',
      theme: (c) => `¿Qué debería saber sobre «${c}»?`,
      readFirst: '¿Qué artículos de este tema debería leer primero y por qué?',
      fit: (x) => `¿Qué papel tiene ${x} en este tema?`,
      about: (x) => `Háblame de ${x} y de su relación con el resto de este tema.`,
    },
    it: {
      summary: 'Riassumi questo articolo in pochi punti',
      summaryOf: (t) => `Riassumi «${t}» in pochi punti`,
      explain: (x) => `Spiega la sezione «${x}»`,
      meanings: (t) => `Quali significati di «${t}» sono elencati qui?`,
      whatIs: (x) => `Che cos'è «${x}»?`,
      section: 'Spiega la sezione che sto leggendo',
      readNext: 'Quali articoli collegati dovrei leggere dopo, e perché?',
      overview: 'Dammi una panoramica di questo argomento e dei suoi temi principali',
      connect: (a, b) => `Che legame c'è tra «${a}» e «${b}»?`,
      connected: 'Come sono collegati gli articoli di questo argomento?',
      theme: (c) => `Cosa dovrei sapere su «${c}»?`,
      readFirst: 'Quali articoli di questo argomento dovrei leggere per primi, e perché?',
      fit: (x) => `Che ruolo ha ${x} in questo argomento?`,
      about: (x) => `Parlami di ${x} e di come si collega al resto di questo argomento.`,
    },
  };

  // The answer language for this page: the setting, resolved against the article's and browser's language.
  // "Same as my question" uses the browser's language for the starter questions.
  function phrases() {
    const choice = state.answerLanguage || 'browser';
    const browser = (navigator.language || 'en').split('-')[0].toLowerCase();
    const code = choice === 'article' ? lang : choice === 'browser' || choice === 'question' ? browser : choice;
    return PHRASES[code] || PHRASES.en;
  }

  async function loadLanguage() {
    try {
      const s = await chrome.runtime.sendMessage({ type: 'getSettings' });
      state.answerLanguage = s?.answerLanguage || 'browser';
      // Shown above the chat until the reader dismisses it once.
      state.notice = s?.recipient && !s.noticeSeen ? { recipient: s.recipient, privacyUrl: s.privacyUrl } : null;
    } catch {}
  }

  // A page that lists the meanings of a name ("Mercury"): no single subject to build a topic around.
  const isDisambiguation = () =>
    !!document.querySelector('#disambigbox, .dmbox-disambig') || /\b(disambiguation|begriffsklärung)\b/i.test(document.querySelector('#mw-normal-catlinks')?.textContent || '');

  // Starter questions about this article, from the page itself (no model call): its name, the section
  // on screen, its most-mentioned link. Stubs get fewer; a disambiguation page asks which meaning.
  function starterSuggestions() {
    const p = phrases();
    const linked = collectLinks().filter((l) => l.count > 0);
    if (isDisambiguation()) {
      return [p.meanings(title), ...linked.slice(0, 2).map((l) => p.whatIs(l.title))];
    }
    const sections = headings().map(headingText).filter((h) => !isBackMatter(h));
    if (!sections.length) return [p.summaryOf(title), p.readNext];
    const vis = visibleSection().name;
    const top = [...linked].sort((a, b) => b.count - a.count)[0];
    return [
      p.summaryOf(title),
      vis !== 'Introduction' && !isBackMatter(vis) ? p.explain(vis) : top ? p.connect(title, top.title) : p.section,
      p.readNext,
    ];
  }

  function topicSuggestions(t) {
    const p = phrases();
    const [a, b, c] = t.facets.filter((f) => f.name !== W_ADDED && t.pages.some((x) => x.facet === f.name));
    return [
      p.overview,
      a && b ? p.connect(a.name, b.name) : p.connected,
      c ? p.theme(c.name) : null,
      title === t.seed || title === t.name ? p.readFirst : p.fit(title),
    ].filter(Boolean);
  }

  // What the empty chat is about: the whole topic, or this article.
  function topicCard(t) {
    const themes = t.facets
      .map((f) => ({ name: f.name, n: t.pages.filter((p) => p.facet === f.name).length }))
      .filter((f) => f.n);
    return `
      <div class="scope-card topic">
        <div class="scope-card-head">${GRAPH_ICON}<div><div class="scope-kind">Topic chat</div><div class="scope-name">${esc(t.name)}</div></div></div>
        <p>Ask questions that span the whole topic: answers draw on all ${t.pages.length} articles, not just the one you're reading.</p>
        <div class="theme-chips">${themes.map((f) => `<span class="chip">${esc(f.name)} <span class="n">${f.n}</span></span>`).join('')}</div>
        <div class="scope-card-links"><button class="link go-topic">See all articles</button><button class="link go-map">Open the map</button></div>
      </div>`;
  }

  function articleCard() {
    return `
      <div class="scope-card">
        <div class="scope-card-head"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/></svg><div><div class="scope-kind">Article chat</div><div class="scope-name">${esc(title)}</div></div></div>
        <p>Answers use this article and the articles it links to. Select text in the article to ask about a passage.</p>
      </div>`;
  }

  // Before the first question: what is sent where, with the privacy policy.
  function noticeCard() {
    const n = state.notice;
    if (!n) return '';
    return `<div class="privacy-notice" role="note">
        <p>To answer, Wiki AI sends your question, any text you select, your earlier questions in the chat, and passages from Wikipedia to <strong>${esc(n.recipient)}</strong>. Your chats are saved only in this browser.</p>
        <p><a href="${esc(n.privacyUrl)}" target="_blank" rel="noopener noreferrer">Privacy policy</a> · <button class="link dismiss-notice">Got it</button></p>
      </div>`;
  }

  function render(restoreScroll = false) {
    const c = conv();
    if (!c || state.view !== 'chat') return;
    if (!c.messages.length) {
      const t = topicHere();
      const open = unexplored().reduce((n, g) => n + g.items.length, 0);
      messagesEl.innerHTML = `
        <div class="empty">
          ${noticeCard()}
          ${t ? topicCard(t) : articleCard()}
          <div class="fu-label">Try asking</div>
          ${(t ? topicSuggestions(t) : starterSuggestions()).map((q) => `<button class="suggestion">${esc(q)}</button>`).join('')}
          ${state.topic || state.building || isDisambiguation() ? '' : '<p class="why">Want to explore this subject across many articles? <button class="link build-topic">Build a topic cluster</button></p>'}
          ${open ? `<p class="why">${open} suggested question${open > 1 ? 's' : ''} from earlier chats are waiting in <button class="link go-topic">Topic › Questions to explore</button>.</p>` : ''}
        </div>`;
      return;
    }
    const scrollTop = messagesEl.scrollTop;
    // Thinking boxes scroll on their own: keep each one where the reader left it, or at its end while it grows.
    const thinking = new Map(
      [...messagesEl.querySelectorAll('.msg[data-i] .reasoning div')].map((d) => [
        d.closest('.msg').dataset.i,
        d.scrollHeight - d.scrollTop - d.clientHeight < 8 ? Infinity : d.scrollTop,
      ])
    );
    patchChildren(messagesEl, [noticeCard(), ...c.messages.map(renderMessage)]);
    for (const d of messagesEl.querySelectorAll('.msg[data-i] .reasoning div')) {
      const top = thinking.get(d.closest('.msg').dataset.i);
      if (top !== undefined) d.scrollTop = top === Infinity ? d.scrollHeight : top;
    }
    if (restoreScroll) state.pinQuestion = false;
    messagesEl.scrollTop = restoreScroll ? c.scrollTop ?? messagesEl.scrollHeight : state.pinQuestion ? questionTop() : scrollTop;
  }

  // Replaces only the children whose HTML changed: while an answer streams in, that's the one message being
  // written, so the rest keep their focus, open details and screen-reader position. Each part is one element.
  function patchChildren(container, parts) {
    const focused = focusKey(container);
    const kids = [...container.children];
    const tpl = document.createElement('template');
    parts = parts.filter(Boolean);
    parts.forEach((html, i) => {
      if (kids[i]?.__html === html) return;
      tpl.innerHTML = html;
      const el = tpl.content.firstElementChild;
      el.__html = html;
      if (kids[i]) kids[i].replaceWith(el);
      else container.appendChild(el);
    });
    for (const k of kids.slice(parts.length)) k.remove();
    if (focused && !container.contains(root.activeElement)) restoreFocus(container, focused);
  }

  // Enough to find the focused control again after its message was redrawn.
  function focusKey(container) {
    const el = root.activeElement;
    if (!el || !container.contains(el)) return null;
    return { i: el.closest('.msg')?.dataset.i, cls: el.classList[0], n: el.dataset.n, q: el.dataset.q, tag: el.tagName };
  }
  function restoreFocus(container, k) {
    const scope = k.i != null ? container.querySelector(`.msg[data-i="${k.i}"]`) : container;
    const match = [...(scope?.querySelectorAll(k.cls ? `.${CSS.escape(k.cls)}` : k.tag) || [])].find(
      (el) => el.tagName === k.tag && el.dataset.n === k.n && el.dataset.q === k.q
    );
    match?.focus({ preventScroll: true });
  }

  // Screen readers hear status changes and the finished answer here, not every redraw of the conversation.
  const liveEl = $('.live');
  function announce(text) {
    if (!text || liveEl.textContent === text) return;
    liveEl.textContent = '';
    setTimeout(() => (liveEl.textContent = text), 50);
  }
  const spoken = (md) => W.markdown.plain(md || '').replace(/\s*(?:\[|【)\s*\d+(?:\s*[,;]\s*\d+)*\s*(?:\]|】)/g, '').replace(/[#*$]/g, '').slice(0, 1500);

  // A new question goes to the top, and stays there as its answer streams in, so the answer is read from its start.
  function questionTop() {
    const q = [...messagesEl.querySelectorAll('.msg.user')].pop();
    return q ? q.getBoundingClientRect().top - messagesEl.getBoundingClientRect().top + messagesEl.scrollTop - 8 : messagesEl.scrollTop;
  }

  const known = (n) => n >= 1 && n <= (conv()?.sources.length || 0);

  // Each cited page gets a stable color for the conversation, shared by its inline citations and its source group.
  const PAGE_COLORS = 6;
  function pageColor(page) {
    const pages = [...new Set(conv().sources.map((s) => s.page))];
    const i = page === title ? 0 : pages.filter((p) => p !== title).indexOf(page) + 1;
    return i % PAGE_COLORS;
  }

  // Whether a source is from the page open now (a chat may have been started on another page).
  const isHere = (src) => src.lang === lang && src.page === title;

  function citeAttrs(n) {
    const s = conv().sources[n - 1];
    return { title: `${s.page} › ${s.section}`, className: `c${pageColor(s.page)}` };
  }

  // Sources under an answer, grouped by Wikipedia page; sections are secondary.
  // labelOf maps a chat-wide source number to the number shown in this answer.
  function renderSourceGroups(numbers, labelOf) {
    const groups = new Map();
    for (const n of numbers) {
      const s = conv().sources[n - 1];
      if (!groups.has(s.page)) groups.set(s.page, []);
      groups.get(s.page).push(s);
    }
    const esc = W.markdown.esc;
    return `<div class="sources" role="group" aria-label="Sources (arrow keys move between them)">${[...groups]
      .map(([page, items]) => {
        const first = items[0];
        const pageEl = isHere(first)
          ? `<span class="page-name">${esc(page)}</span><span class="tag">this article</span>`
          : `<a class="page-name" href="${articleUrl(first)}" target="_blank" rel="noopener" title="Open “${esc(page)}”">${esc(page)} ↗</a>`;
        const where = (s) => s.section.split(' › ').pop();
        // Several passages from one section: tell them apart by their opening words.
        const repeated = (s) => items.filter((x) => where(x) === where(s)).length > 1;
        const label = (s) => (repeated(s) ? `${where(s)} · ${truncate(s.text.replace(/\s+/g, ' ').trim(), 22)}` : where(s));
        const sections = items
          .sort((a, b) => labelOf.get(a.n) - labelOf.get(b.n))
          .map((s) => {
            const k = labelOf.get(s.n);
            return `<button class="source" data-n="${s.n}" data-label="${k}" tabindex="${k === 1 ? 0 : -1}" title="${esc(s.text.slice(0, 200))}" aria-label="Source ${k}: ${esc(page)}, ${esc(label(s))}"><span class="num">${k}</span><span class="where">${esc(label(s))}</span></button>`;
          })
          .join('');
        return `<div class="source-group c${pageColor(page)}"><div class="page-row">${pageEl}</div><div class="chips">${sections}</div></div>`;
      })
      .join('')}${licenseLine('', `https://${lang}.wikipedia.org/`)}</div>`;
  }

  function renderMessage(m, i) {
    if (m.role === 'user') {
      const quote = m.quote ? `<blockquote>${W.markdown.esc(m.quote.text.slice(0, 280))}${m.quote.text.length > 280 ? '…' : ''}</blockquote>` : '';
      return `<div class="msg user">${quote}<div class="bubble">${W.markdown.esc(m.content)}</div></div>`;
    }
    const steps = m.steps?.length
      ? `<details class="steps"${m.stepsOpen ?? m.pending ? ' open' : ''}><summary>${m.steps.length} research step${m.steps.length > 1 ? 's' : ''}</summary><ul>${m.steps.map((s) => `<li>${W.markdown.esc(s)}</li>`).join('')}</ul></details>`
      : '';
    const reasoning = m.reasoning ? `<details class="reasoning"${m.reasoningOpen ? ' open' : ''}><summary>Thinking</summary><div>${W.markdown.esc(m.reasoning)}</div></details>` : '';
    const flagged = m.pending ? [] : m.unsupported || [];
    // Sources are numbered across the chat; each answer shows its own as 1, 2, 3… in the order it cites them.
    const cited = m.pending ? [] : W.markdown.citedNumbers(m.content || '').filter(known);
    const labelOf = new Map(cited.map((n, k) => [n, k + 1]));
    const attrs = (n) => ({ ...citeAttrs(n), label: labelOf.get(n) });
    const body = m.content ? `<div class="answer">${W.markdown.render(m.content, known, attrs, flagged)}</div>` : '';
    const grounding = flagged.length
      ? `<div class="grounding-note">${flagged.some((f) => f.kind !== 'uncited') ? "Underlined parts couldn't be matched to the Wikipedia sources." : 'Parts underlined in grey have no source number.'} Hover over them to see why.</div>`
      : '';
    const status = m.pending && !m.content ? `<div class="status"><span class="dot"></span>${W.markdown.esc(m.status || 'Thinking')}</div>` : '';
    const debug = traces.has(m) ? ` · <button class="link copy-debug" data-i="${i}" title="Copy what happened while answering (no API key), for a bug report">Copy debug info</button>` : '';
    const error = m.error
      ? `<div class="error">${W.markdown.esc(m.error)}${/API key|401|403/.test(m.error) ? ' <button class="link open-settings">Open settings</button>' : ''}${m.model ? '' : debug}</div>`
      : '';
    const sources = cited.length ? renderSourceGroups(cited, labelOf) : '';
    const figures = cited.length ? renderFigures(cited, labelOf) : '';
    const meta = m.model && !m.pending ? `<div class="meta">${W.markdown.esc(m.model)}${debug}</div>` : '';
    const askedHere = new Set(conv().messages.filter((x) => x.role === 'user').map((x) => normQ(x.content)));
    const followups = !m.pending && m.followups?.length
      ? `<div class="followups"><div class="fu-label">Ask next</div>${m.followups
          .map((q) => W.markdown.plain(q))
          .map((q) =>
            askedHere.has(normQ(q))
              ? `<div class="followup asked"><span aria-hidden="true">✓</span> ${esc(q)}</div>`
              : `<button class="followup" data-q="${esc(q)}">${esc(q)}</button>`
          )
          .join('')}</div>`
      : '';
    return `<div class="msg assistant" data-i="${i}">${steps}${reasoning}${body}${figures}${grounding}${status}${error}${sources}${meta}${followups}</div>`;
  }

  // Images the answer cites, with their caption and credit (Commons licences ask for the author and licence).
  function renderFigures(numbers, labelOf) {
    const esc = W.markdown.esc;
    const figs = numbers.map((n) => conv().sources[n - 1]).filter((s) => s?.figure?.thumb).slice(0, 3);
    if (!figs.length) return '';
    return `<div class="answer-figures">${figs
      .map((s) => {
        const f = s.figure;
        const credit = [f.artist, f.license].filter(Boolean).join(' · ');
        return `<figure class="answer-figure">
          <button class="figure-img" data-n="${s.n}" data-label="${labelOf.get(s.n)}" title="${isHere(s) ? 'Show in the article' : `From “${esc(s.page)}”`}"><img src="${esc(f.thumb)}" alt="${esc(f.caption || f.description || f.file)}" loading="lazy"></button>
          <figcaption><span class="num">${labelOf.get(s.n)}</span> ${esc(truncate(f.caption || f.description || f.file, 160))}${credit ? ` <a class="credit" href="${esc(f.url || '')}" target="_blank" rel="noopener">${esc(credit)}</a>` : ''}</figcaption>
        </figure>`;
      })
      .join('')}</div>`;
  }

  // Re-render at most every 40 ms while tokens stream in (a timer, so it also runs in background tabs).
  let renderTimer = 0;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = 0;
      render();
    }, 40);
  }

  function setQuote(quote) {
    state.quote = quote;
    quoteEl.hidden = !quote;
    if (quote) {
      quoteEl.innerHTML = `<span class="label">Selected text${quote.section ? ` · ${W.markdown.esc(quote.section)}` : ''}</span><span class="text">${W.markdown.esc(quote.text.slice(0, 200))}${quote.text.length > 200 ? '…' : ''}</span><button type="button" class="icon clear-quote" aria-label="Remove selection">×</button>`;
    }
    renderTopic();
  }

  function setBusy(busy) {
    state.busy = busy;
    sendBtn.classList.toggle('stop', busy);
    sendBtn.title = busy ? 'Stop' : 'Send';
    sendBtn.setAttribute('aria-label', busy ? 'Stop generating' : 'Send');
    if (busy) state.busySince = Date.now();
    sendBtn.innerHTML = busy
      ? '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  }

  function connect() {
    if (state.port) return state.port;
    const port = chrome.runtime.connect({ name: 'wikiai-chat' });
    port.onMessage.addListener(onAgentMessage);
    port.onDisconnect.addListener(() => {
      state.port = null;
      // A topic being built has no one left to finish it.
      if (state.building) {
        state.building = null;
        state.topicError = 'Building the topic stopped because the connection to the extension was lost. Try again.';
        state.topicNote = false;
        renderTopic();
        renderScopeBar();
        if (state.view === 'map') renderMapView();
      }
      const c = state.request;
      const m = c?.messages[c.messages.length - 1];
      if (state.busy && m?.pending) {
        m.pending = false;
        m.error = 'Connection to the extension was lost. Try again.';
        state.request = null;
        setBusy(false);
        renderChatBar();
        render();
      }
    });
    state.port = port;
    return port;
  }

  // What happened while answering, per answer, for "Copy debug info". Kept in memory only, never saved.
  const traces = new WeakMap();

  function onAgentMessage(msg) {
    if (msg.type === 'topicProgress' || msg.type === 'topicBuilt' || msg.type === 'topicError') {
      if (msg.type === 'topicProgress') state.building = BUILDING; // the steps are internal detail
      if (msg.type === 'topicBuilt') {
        state.building = null;
        state.topic = msg.topic;
        state.useTopicHere = null;
        refreshTopic();
      }
      if (msg.type === 'topicError') {
        state.building = null;
        state.topicError = msg.message;
        state.topicNote = false;
      }
      renderTopic();
      renderScopeBar();
      if (state.view === 'map' && !state.topic) renderMapView();
      render();
      return;
    }
    const c = state.request;
    const m = c?.messages[c.messages.length - 1];
    if (!m || m.role !== 'assistant') return;
    const finish = () => {
      state.request = null;
      setBusy(false);
      saveConv(c);
      renderChatBar();
      if (state.view === 'topic') renderTopic(); // new suggestions for "Questions to explore"
    };
    switch (msg.type) {
      case 'status':
        m.status = msg.text;
        announce(msg.text);
        break;
      case 'step':
        m.steps.push(msg.text);
        m.status = msg.text;
        announce(msg.text);
        break;
      case 'trace':
        traces.set(m, msg.trace);
        break;
      case 'stream':
        m.content = msg.answer;
        if (msg.reasoning) m.reasoning = msg.reasoning;
        break;
      case 'sources':
        c.sources = msg.sources;
        break;
      case 'done':
        m.pending = false;
        if (msg.answer) m.content = msg.answer;
        if (msg.model) m.model = msg.model;
        if (msg.followups?.length) m.followups = msg.followups;
        m.unsupported = msg.unsupported?.length ? msg.unsupported : undefined;
        if (msg.stopped && !m.content) m.error = 'Stopped.';
        announce(m.error || `Answer: ${spoken(m.content)}`);
        finish();
        break;
      case 'error':
        m.pending = false;
        m.error = msg.message;
        announce(msg.message);
        finish();
        break;
    }
    if (c === conv()) scheduleRender();
  }

  // An earlier answer as the model sees it again: without the sentences the source check couldn't match,
  // so details from memory don't come back later looking sourced.
  const withoutUnsupported = (m) => (m.unsupported || []).filter((u) => u.kind !== 'uncited').reduce((text, u) => text.replace(u.text, ''), m.content).replace(/[ \t]+\n/g, '\n');

  function ask(question, c = conv()) {
    question = question.trim();
    if (!question || state.busy) return;
    if (!ensureAlive()) return;
    // A question that was stopped or failed leaves the history with its reply, so the model doesn't answer it later.
    const answered = (m, i) => {
      const reply = m.role === 'user' ? c.messages[i + 1] : m;
      return !!reply && reply.role === 'assistant' && !reply.error && !!reply.content && !!m.content;
    };
    const history = [
      ...(c.context || []),
      ...c.messages
        .filter(answered)
        .map((m) => ({ role: m.role, content: m.role === 'user' && m.quote ? `About "${m.quote.text.slice(0, 300)}": ${m.content}` : withoutUnsupported(m) })),
    ];
    const quote = state.quote;
    c.title ||= question;
    c.messages.push({ role: 'user', content: question, quote });
    c.messages.push({ role: 'assistant', content: '', steps: [], pending: true, status: 'Starting' });
    state.request = c;
    setQuote(null);
    input.value = '';
    autosize();
    setBusy(true);
    renderChatBar();
    state.pinQuestion = true;
    render();
    connect().postMessage({
      type: 'ask',
      question,
      history,
      sources: c.sources,
      page: { ...pageInfo(), selection: quote },
      topicId: topicHere()?.id || null,
    });
  }

  function showPreview(src, label = src.n) {
    previewEl.hidden = false;
    previewEl.innerHTML = `
      <div class="preview-head c${pageColor(src.page)}">
        <span class="num">${W.markdown.esc(label)}</span>
        <span class="preview-title">
          <span class="page-name">${W.markdown.esc(src.page)}</span>
          <span class="section-name">${W.markdown.esc(src.section)}</span>
        </span>
        <button class="icon close-preview" aria-label="Close preview">×</button>
      </div>
      ${src.figure?.thumb ? `<img class="preview-img" src="${W.markdown.esc(src.figure.thumb)}" alt="">` : ''}
      ${isHere(src) && otherRevision(src) ? '<p class="preview-note">Quoted from another version of this article. The passage may have changed since, so it isn\'t highlighted on the page.</p>' : ''}
      <div class="preview-text">${W.markdown.esc(src.text)}</div>
      ${licenseLine(src.page, articleUrl(src))}
      <div class="preview-actions">
        ${
          isHere(src) && !otherRevision(src)
            ? '<button class="link show-in-page">Show in article</button>'
            : `<a class="link" href="${linkedUrl(src)}" target="_blank" rel="noopener noreferrer">${isHere(src) ? 'Open the version quoted ↗' : `Open “${W.markdown.esc(src.page)}” ↗`}</a>`
        }
      </div>`;
    previewEl.dataset.n = src.n;
  }

  function onCite(n, label) {
    const src = conv().sources[n - 1];
    if (!src) return;
    if (isHere(src)) {
      const found = highlightSource(src);
      if (found) previewEl.hidden = true;
      else showPreview(src, label);
    } else showPreview(src, label);
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }

  // ---------- Events ----------

  launcher.addEventListener('click', () => setOpen(true));
  $('.close').addEventListener('click', () => setOpen(false));
  $('.settings').addEventListener('click', openOptions);
  $('.new').addEventListener('click', () => {
    if (state.view !== 'chat') setView('chat');
    newChat();
  });

  $('.composer').addEventListener('submit', (e) => {
    e.preventDefault();
    // The button turns into Stop under the cursor; the second click of a double-click isn't a stop.
    if (state.busy) {
      if (Date.now() - state.busySince > 500) state.port?.postMessage({ type: 'stop' });
    } else ask(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!state.busy) ask(input.value);
    }
    if (e.key !== 'Escape') e.stopPropagation(); // keep Wikipedia's keyboard shortcuts out of the textarea; Escape closes the panel
  });
  input.addEventListener('input', autosize);

  // Scrolling by hand during an answer lets the reader go where they like.
  for (const type of ['wheel', 'touchmove', 'keydown']) messagesEl.addEventListener(type, () => (state.pinQuestion = false), { passive: true });
  messagesEl.addEventListener('mousedown', (e) => e.target === messagesEl && (state.pinQuestion = false)); // the scrollbar

  // Remember opened/closed step and thinking lists, so streaming re-renders don't snap them shut.
  messagesEl.addEventListener(
    'toggle',
    (e) => {
      const d = e.target;
      const m = conv()?.messages[Number(d.closest('.msg')?.dataset.i)];
      if (!m) return;
      if (d.classList.contains('steps')) m.stepsOpen = d.open;
      if (d.classList.contains('reasoning')) m.reasoningOpen = d.open;
    },
    true
  );

  root.addEventListener('click', (e) => {
    const t = e.target.closest('button, a');
    if (!t) return;
    if (t.matches('.cite, .source, .figure-img')) onCite(Number(t.dataset.n), t.dataset.label);
    else if (t.matches('.suggestion')) ask(t.textContent);
    else if (t.matches('.copy-debug')) {
      navigator.clipboard
        .writeText(JSON.stringify(traces.get(conv().messages[Number(t.dataset.i)]), null, 2))
        .then(() => (t.textContent = 'Copied'), () => (t.textContent = "Couldn't copy"));
    }
    else if (t.matches('.dismiss-notice')) {
      state.notice = null;
      send({ type: 'privacyNoticeSeen' }).catch(() => {});
      render();
    } else if (t.matches('.clear-quote')) setQuote(null);
    else if (t.matches('.close-preview')) previewEl.hidden = true;
    else if (t.matches('.show-in-page')) highlightSource(conv().sources[Number(previewEl.dataset.n) - 1]);
    else if (t.matches('.view-btn')) setView(t.dataset.view);
    else if (t.matches('.explore-q')) askSuggested(t.dataset.q, convById(t.dataset.conv) || conv());
    else if (t.matches('.followup')) askSuggested(t.dataset.q);
    else if (t.matches('.open-saved-chat')) openSavedChat(t.dataset.scope, t.dataset.id);
    else if (t.matches('.delete-saved-chat')) {
      if (confirm("Delete this chat? This can't be undone.")) {
        state.allChats = state.allChats.filter((x) => x.id !== t.dataset.id);
        renderHistoryLists();
        send({ type: 'conv:delete', scope: t.dataset.scope, id: t.dataset.id }).then(loadAllChats, () => {});
      }
    } else if (t.matches('.new-chat')) newChat();
    else if (t.matches('.open-chat')) openChat(t.dataset.id);
    else if (t.matches('.delete-chat')) {
      if (confirm('Delete this chat? This can\'t be undone.')) deleteChat(t.dataset.id);
    } else if (t.matches('.go-map')) setView('map');
    else if (t.matches('.go-topic')) setView('topic');
    else if (t.matches('.open-settings')) openOptions();
    else if (t.matches('.reload-page')) location.reload();
    else if (t.matches('.build-topic')) buildTopic();
    else if (t.matches('.chat-topic')) setScope(true).then(() => setView('chat'));
    else if (t.matches('.scope-article')) setScope(false);
    else if (t.matches('.scope-topic')) setScope(true);
    else if (t.matches('.stop-topic')) state.port?.postMessage({ type: 'stopTopic' });
    else if (t.matches('.add-page')) topicAction(() => send({ type: 'topics:addPage', id: state.topic.id, title }));
    else if (t.matches('.remove-page')) topicAction(() => send({ type: 'topics:removePage', id: state.topic.id, title: t.dataset.title }));
    else if (t.matches('.leave-topic')) {
      state.useTopicHere = null;
      topicAction(() => send({ type: 'topics:setActive', id: null }));
    }
    else if (t.matches('.open-topic')) {
      state.useTopicHere = true; // opened on purpose, so use it here even if this article isn't in it
      topicAction(() => send({ type: 'topics:setActive', id: t.dataset.id }));
    }
    else if (t.matches('.delete-topic')) {
      const name = state.savedTopics.find((x) => x.id === t.dataset.id)?.name;
      if (confirm(`Delete the topic “${name}” and the chats in it? This can't be undone.`)) topicAction(() => send({ type: 'topics:delete', id: t.dataset.id }));
    }
  });

  // "Ask about this" button next to a text selection in the article.
  let pendingSelection = null;
  document.addEventListener('mouseup', (e) => {
    if (e.composedPath().includes(host)) return;
    setTimeout(() => {
      const sel = getSelection();
      const text = sel?.toString().trim();
      if (!sel || sel.isCollapsed || !text || text.length < 3 || !article.contains(sel.anchorNode)) {
        askSelBtn.hidden = true;
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      pendingSelection = { text: text.slice(0, 2000), section: sectionOf(sel.anchorNode) };
      askSelBtn.hidden = false;
      const below = rect.bottom + 44 < window.innerHeight;
      askSelBtn.style.top = `${below ? rect.bottom + 8 : rect.top - 40}px`;
      askSelBtn.style.left = `${Math.min(Math.max(8, rect.left + rect.width / 2 - 60), window.innerWidth - (state.open ? PANEL_WIDTH : 0) - 140)}px`;
    }, 0);
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.composedPath().includes(host)) askSelBtn.hidden = true;
  });
  askSelBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  askSelBtn.addEventListener('click', () => {
    askSelBtn.hidden = true;
    if (pendingSelection) setQuote(pendingSelection);
    setOpen(true);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') CSS.highlights?.delete('wikiai-cite');
  });
  // An answer's sources are one tab stop; arrow keys move between them.
  messagesEl.addEventListener('keydown', (e) => {
    const chip = e.target.closest?.('.source');
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!chip || !step) return;
    e.preventDefault();
    const chips = [...chip.closest('.sources').querySelectorAll('.source')].sort((a, b) => a.dataset.label - b.dataset.label);
    const next = chips[(chips.indexOf(chip) + step + chips.length) % chips.length];
    chips.forEach((c) => (c.tabIndex = c === next ? 0 : -1));
    next.focus();
  });

  // Escape inside the panel closes the source preview first, then the panel (the map handles its own).
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing) return;
    if (!previewEl.hidden) previewEl.hidden = true;
    else {
      setOpen(false);
      launcher.focus();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'toggle') setOpen(!state.open);
    if (msg.type === 'askSelection') {
      const sel = getSelection();
      const anchor = sel && !sel.isCollapsed ? sel.anchorNode : null;
      setQuote({ text: msg.text.slice(0, 2000), section: anchor && article.contains(anchor) ? sectionOf(anchor) : '' });
      setOpen(true);
    }
  });

  render();
  refreshTopic();
  // The panel opens on every article, in its last section; closing it keeps it closed in this tab
  // until it's opened again.
  const restore = (view) => {
    if (view === 'topic' || view === 'map') setView(view);
    setOpen(true, { focus: false });
  };
  const sessionOpen = recall('open');
  takeHandoff().then((h) => {
    if (h?.chat) {
      state.pendingChat = h.chat;
      if (h.scope?.startsWith('page:')) state.useTopicHere = false;
      refreshTopic(); // load that chat's scope; the chat opens once it's loaded
    }
    if (h && sessionOpen !== '0') restore(h.view);
    else if (sessionOpen !== '0') restore(recall('view'));
  });

  for (const type of ['pointerdown', 'contextmenu']) {
    document.addEventListener(
      type,
      (e) => {
        const a = e.target.closest?.('a[href]');
        if (a && !e.composedPath().includes(host)) noteLink(a);
      },
      true
    );
  }
})();
