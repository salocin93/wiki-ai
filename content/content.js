// Sidebar UI on Wikipedia articles: chat, clickable citations, "ask about this" on selected text.
(() => {
  if (window.__wikiai) return;
  window.__wikiai = true;

  const W = globalThis.WikiAI;
  const article = document.querySelector('#mw-content-text .mw-parser-output');
  if (!article || !document.body.classList.contains('ns-0')) return; // only main-namespace articles

  const canonical = document.querySelector('link[rel=canonical]')?.href || location.href;
  const lang = new URL(canonical).hostname.split('.')[0];
  const title = decodeURIComponent(canonical.split('/wiki/')[1].split(/[#?]/)[0]).replace(/_/g, ' ');
  const PANEL_WIDTH = 420;

  const state = {
    open: false,
    busy: false,
    messages: [], // {role, content, reasoning, steps[], status, error, model}
    sources: [],
    quote: null, // {text, section}
    port: null,
    links: null,
    topic: null, // active topic cluster
    topicOpen: false, // drawer expanded
    topicView: 'map', // 'map' or 'saved'
    savedTopics: [],
    building: null, // progress text while a cluster is being built
    topicError: null,
  };

  // ---------- Page reading helpers ----------

  const NON_ARTICLE_NS = /^(File|Image|Help|Special|Wikipedia|Template|Category|Portal|Talk|Module|Draft|User|MediaWiki|Book|Media|WP|Template talk|User talk)(:)/i;
  const BACK_MATTER = /^(see also|references|notes|footnotes|external links|further reading|bibliography|sources|citations|works cited)$/i;
  const SKIP_LINK_AREAS = '.reflist, .references, .mw-references-wrap, sup.reference, .mw-editsection, .sistersitebox, .shortdescription, .navbar';

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
      if (!signal && /^see also$/i.test(section)) signal = { kind: 'seealso', context: 'Listed under "See also"' };
      if (signal) {
        entry.signals.add(signal.kind);
        if (signal.box) entry.navboxes.add(signal.box);
      }
      // Only mentions in the article's own text count; navigation boxes and back matter list links wholesale.
      const inText = !signal && !BACK_MATTER.test(section);
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

  function pageInfo() {
    return {
      lang,
      title,
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

  function highlightSource(src) {
    let range = null;
    try {
      range = locate(src.text);
    } catch {}
    if (range) {
      if (globalThis.CSS?.highlights && globalThis.Highlight) CSS.highlights.set('wikiai-cite', new Highlight(range));
      const el = range.startContainer.parentElement;
      openCollapsedAncestors(el);
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return true;
    }
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

  function articleUrl(src) {
    return `https://${src.lang}.wikipedia.org/wiki/${encodeURIComponent(src.page.replace(/ /g, '_'))}`;
  }

  function linkedUrl(src) {
    const words = src.text.replace(/\s+/g, ' ').split(' ').slice(0, 6).join(' ');
    return `${articleUrl(src)}#:~:text=${encodeURIComponent(words)}`;
  }

  // ---------- UI ----------

  const host = document.createElement('div');
  host.id = 'wikiai-host';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <link rel="stylesheet" href="${chrome.runtime.getURL('content/sidebar.css')}">
    <button class="launcher" title="Ask about this article (Alt+Shift+W)" aria-label="Open Wiki AI">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>
    </button>
    <button class="ask-selection" hidden>Ask about this</button>
    <aside class="panel" hidden>
      <header>
        <div class="titles">
          <div class="name">Wiki AI</div>
          <div class="sub"></div>
        </div>
        <button class="icon new" title="New conversation" aria-label="New conversation">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        <button class="icon settings" title="Settings" aria-label="Settings">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
        </button>
        <button class="icon close" title="Close" aria-label="Close">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </header>
      <div class="topic"></div>
      <div class="messages" role="log" aria-live="polite"></div>
      <div class="preview" hidden></div>
      <form class="composer">
        <div class="quote" hidden></div>
        <div class="row">
          <textarea rows="1" placeholder="Ask about this article…"></textarea>
          <button type="submit" class="send" title="Send" aria-label="Send">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </button>
        </div>
      </form>
    </aside>`;
  document.documentElement.appendChild(host);

  // Highlight style has to live in the page, outside the shadow root.
  const pageStyle = document.createElement('style');
  pageStyle.textContent = `
    ::highlight(wikiai-cite) { background-color: rgba(255, 196, 0, 0.45); color: inherit; }
    html.wikiai-open body { margin-right: ${PANEL_WIDTH}px !important; }
    html.wikiai-open .vector-sticky-header { right: ${PANEL_WIDTH}px !important; width: auto !important; }
    /* Fundraising and other CentralNotice banners can overlay the panel; hide them while it's open
       (hidden only, not dismissed, so Wikipedia's own "don't show again" choice stays the user's). */
    html.wikiai-open #siteNotice, html.wikiai-open #centralNotice, html.wikiai-open .cn-banner,
    html.wikiai-open .cn-fundraising, html.wikiai-open [id^="frb"], html.wikiai-open [class*="frb-"],
    html.wikiai-open [id^="WMDE"], html.wikiai-open .wmde-banner { display: none !important; }
    html.wikiai-open, html.wikiai-open body { overflow: auto !important; }`;
  document.head.appendChild(pageStyle);

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
  $('.sub').textContent = title;

  function syncTheme() {
    const cls = document.documentElement.classList;
    const dark =
      cls.contains('skin-theme-clientpref-night') ||
      (cls.contains('skin-theme-clientpref-os') && matchMedia('(prefers-color-scheme: dark)').matches);
    host.dataset.theme = dark ? 'dark' : 'light';
  }
  syncTheme();
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
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
      unpinned = PINNED_RIGHT.filter(([pinned]) => cls.contains(pinned));
      for (const [pinned, hidden] of unpinned) cls.replace(pinned, hidden);
    } else {
      for (const [pinned, hidden] of unpinned) cls.replace(hidden, pinned);
      unpinned = [];
    }
  }

  function setOpen(open) {
    state.open = open;
    panel.hidden = !open;
    launcher.hidden = open;
    document.documentElement.classList.toggle('wikiai-open', open);
    unpinWikipediaColumn(open);
    if (open) {
      render();
      refreshTopic();
      setTimeout(() => input.focus(), 0);
    }
  }

  // ---------- Topic clusters ----------

  // After the extension is reloaded or updated, this script stays on the page but loses its connection
  // (chrome.runtime goes away). Show a reload prompt instead of failing on every click.
  const extensionAlive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  function ensureAlive() {
    if (extensionAlive()) return;
    messagesEl.innerHTML = `<div class="stale">Wiki AI was updated or reloaded. <button class="link reload-page">Reload this page</button> to keep using it.</div>`;
    topicEl.innerHTML = '';
    throw new Error('Extension context invalidated');
  }

  function openOptions() {
    ensureAlive();
    chrome.runtime.sendMessage({ type: 'openOptions' });
  }

  async function send(msg) {
    ensureAlive();
    const res = await chrome.runtime.sendMessage(msg);
    if (res?.error) throw new Error(res.error);
    return res?.result;
  }

  async function refreshTopic() {
    try {
      state.topic = await send({ type: 'topics:active' });
      state.savedTopics = await send({ type: 'topics:list' });
    } catch {}
    renderTopic();
    render();
  }

  const inTopic = () => !!state.topic?.pages.some((p) => p.title === title);
  const wikiUrl = (t) => `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, '_'))}`;

  function renderTopic() {
    const esc = W.markdown.esc;
    const t = state.topic;
    input.placeholder = state.quote ? 'Ask about the selected text…' : t ? 'Ask about this topic…' : 'Ask about this article…';
    if (state.building) {
      topicEl.innerHTML = `<div class="topic-bar building"><span class="dot"></span><span class="topic-status">${esc(state.building)}</span><button class="link stop-topic">Stop</button></div>`;
      return;
    }
    const error = state.topicError ? `<div class="topic-error">${esc(state.topicError)}</div>` : '';
    if (!t) {
      topicEl.innerHTML = `
        <div class="topic-bar empty">
          <span class="topic-hint">Questions use this article and its links.</span>
          <button class="link build-topic" title="Let the AI group this article's most relevant linked articles into themes">Build topic cluster</button>
          ${state.savedTopics.length ? `<button class="link show-saved">Saved (${state.savedTopics.length})</button>` : ''}
        </div>${error}${state.topicOpen && state.topicView === 'saved' ? savedList() : ''}`;
      return;
    }
    const chevron = `<svg class="chev${state.topicOpen ? ' open' : ''}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;
    topicEl.innerHTML = `
      <button class="topic-bar active toggle-topic" aria-expanded="${state.topicOpen}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="7" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.3 6.4l7.4.4M7.3 8.2l3.6 7.6M16.8 9.2l-3.6 6.6"/></svg>
        <span class="topic-name">${esc(t.name)}</span>
        <span class="topic-meta">${t.pages.length} articles · ${t.facets.length} themes</span>
        ${chevron}
      </button>${error}
      ${state.topicOpen ? (state.topicView === 'saved' ? savedList() : topicMap(t)) : ''}`;
  }

  function topicMap(t) {
    const esc = W.markdown.esc;
    const pageRow = (p) => `
      <li class="${p.title === title ? 'here' : ''}">
        <a href="${wikiUrl(p.title)}" title="${esc(p.summary || p.description || '')}">${esc(p.title)}</a>
        ${p.title === title ? '<span class="tag">you are here</span>' : ''}
        ${p.description ? `<span class="desc">${esc(p.description)}</span>` : ''}
        ${p.seed ? '' : `<button class="icon remove-page" data-title="${esc(p.title)}" title="Remove from topic" aria-label="Remove ${esc(p.title)} from topic">×</button>`}
      </li>`;
    const seed = t.pages.filter((p) => p.seed);
    const facets = t.facets
      .map((f) => {
        const pages = t.pages.filter((p) => p.facet === f.name);
        if (!pages.length) return '';
        return `<section class="facet"><h5>${esc(f.name)}</h5>${f.why ? `<p class="why">${esc(f.why)}</p>` : ''}<ul>${pages.map(pageRow).join('')}</ul></section>`;
      })
      .join('');
    return `
      <div class="topic-drawer">
        ${inTopic() ? '' : `<div class="notice">This article isn't in the topic. <button class="link add-page">Add it</button></div>`}
        ${seed.length ? `<ul class="seed">${seed.map(pageRow).join('')}</ul>` : ''}
        ${facets}
        <div class="drawer-actions">
          <button class="link rebuild-topic" title="Build a new cluster starting from this article">Rebuild from this article</button>
          <button class="link show-saved">Saved topics</button>
          <button class="link leave-topic">Close topic</button>
        </div>
      </div>`;
  }

  function savedList() {
    const esc = W.markdown.esc;
    const rows = state.savedTopics
      .map(
        (t) => `
        <li class="${t.id === state.topic?.id ? 'here' : ''}">
          <button class="link open-topic" data-id="${t.id}">${esc(t.name)}</button>
          <span class="desc">${t.pages} articles · ${t.facets} themes · from “${esc(t.seed)}”</span>
          <button class="icon delete-topic" data-id="${t.id}" title="Delete topic" aria-label="Delete ${esc(t.name)}">×</button>
        </li>`
      )
      .join('');
    return `
      <div class="topic-drawer">
        <h5>Saved topics</h5>
        ${rows ? `<ul>${rows}</ul>` : '<p class="why">No saved topics yet.</p>'}
        <div class="drawer-actions">${state.topic ? '<button class="link back-to-map">Back to topic map</button>' : '<button class="link close-saved">Close</button>'}</div>
      </div>`;
  }

  function buildTopic() {
    try {
      ensureAlive();
    } catch {
      return;
    }
    state.building = 'Starting';
    state.topicError = null;
    state.topicOpen = false;
    renderTopic();
    connect().postMessage({ type: 'buildTopic', page: pageInfo() });
  }

  async function topicAction(fn) {
    state.topicError = null;
    try {
      await fn();
    } catch (e) {
      state.topicError = e.message;
    }
    await refreshTopic();
  }

  const W_ADDED = 'Added by you';
  const SUGGESTIONS = [
    'Summarize this article in a few bullet points',
    'Explain the section I am reading',
    'Which linked articles should I read next, and why?',
  ];

  function topicSuggestions(t) {
    const [a, b] = t.facets.filter((f) => f.name !== W_ADDED);
    return [
      `Give me an overview of ${t.name} and its main themes`,
      a && b ? `How is “${a.name}” connected to “${b.name}”?` : 'How are the articles in this topic connected?',
      `How does ${title} fit into ${t.name}?`,
    ];
  }

  function render() {
    if (!state.messages.length) {
      const esc = W.markdown.esc;
      const t = state.topic;
      const intro = t
        ? `Ask anything about <strong>${esc(t.name)}</strong>: answers search all ${t.pages.length} articles in the topic.`
        : `Ask anything about <strong>${esc(title)}</strong> or the articles it links to. Select text in the article to ask about a passage.`;
      messagesEl.innerHTML = `
        <div class="empty">
          <p>${intro}</p>
          ${(t ? topicSuggestions(t) : SUGGESTIONS).map((s) => `<button class="suggestion">${esc(s)}</button>`).join('')}
        </div>`;
      return;
    }
    const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
    const scrollTop = messagesEl.scrollTop;
    messagesEl.innerHTML = state.messages.map(renderMessage).join('');
    messagesEl.scrollTop = atBottom ? messagesEl.scrollHeight : scrollTop;
  }

  const known = (n) => n >= 1 && n <= state.sources.length;

  // Each cited page gets a stable color for the conversation, shared by its inline citations and its source group.
  const PAGE_COLORS = 6;
  function pageColor(page) {
    const pages = [...new Set(state.sources.map((s) => s.page))];
    const i = page === title ? 0 : pages.filter((p) => p !== title).indexOf(page) + 1;
    return i % PAGE_COLORS;
  }

  function citeAttrs(n) {
    const s = state.sources[n - 1];
    return { title: `${s.page} › ${s.section}`, className: `c${pageColor(s.page)}` };
  }

  // Sources under an answer, grouped by Wikipedia page; sections are secondary.
  function renderSourceGroups(numbers) {
    const groups = new Map();
    for (const n of numbers) {
      const s = state.sources[n - 1];
      if (!groups.has(s.page)) groups.set(s.page, []);
      groups.get(s.page).push(s);
    }
    const esc = W.markdown.esc;
    return `<div class="sources">${[...groups]
      .map(([page, items]) => {
        const first = items[0];
        const pageEl = first.current
          ? `<span class="page-name">${esc(page)}</span><span class="tag">this article</span>`
          : `<a class="page-name" href="${articleUrl(first)}" target="_blank" rel="noopener" title="Open “${esc(page)}”">${esc(page)} ↗</a>`;
        const sections = items
          .sort((a, b) => a.n - b.n)
          .map((s) => `<button class="source" data-n="${s.n}" title="${esc(s.text.slice(0, 200))}"><span class="num">${s.n}</span><span class="where">${esc(s.section.split(' › ').pop())}</span></button>`)
          .join('');
        return `<div class="source-group c${pageColor(page)}"><div class="page-row">${pageEl}</div><div class="chips">${sections}</div></div>`;
      })
      .join('')}</div>`;
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
    const body = m.content ? `<div class="answer">${W.markdown.render(m.content, known, citeAttrs)}</div>` : '';
    const status = m.pending && !m.content ? `<div class="status"><span class="dot"></span>${W.markdown.esc(m.status || 'Thinking')}</div>` : '';
    const error = m.error
      ? `<div class="error">${W.markdown.esc(m.error)}${/API key|401|403/.test(m.error) ? ' <button class="link open-settings">Open settings</button>' : ''}</div>`
      : '';
    const cited = m.pending ? [] : W.markdown.citedNumbers(m.content || '').filter(known);
    const sources = cited.length ? renderSourceGroups(cited) : '';
    const meta = m.model && !m.pending ? `<div class="meta">${W.markdown.esc(m.model)}</div>` : '';
    return `<div class="msg assistant" data-i="${i}">${steps}${reasoning}${body}${status}${error}${sources}${meta}</div>`;
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
    sendBtn.innerHTML = busy
      ? '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  }

  function connect() {
    if (state.port) return state.port;
    ensureAlive();
    const port = chrome.runtime.connect({ name: 'wikiai-chat' });
    port.onMessage.addListener(onAgentMessage);
    port.onDisconnect.addListener(() => {
      state.port = null;
      const m = state.messages[state.messages.length - 1];
      if (state.busy && m?.pending) {
        m.pending = false;
        m.error = 'Connection to the extension was lost. Try again.';
        setBusy(false);
        render();
      }
    });
    state.port = port;
    return port;
  }

  function onAgentMessage(msg) {
    if (msg.type === 'topicProgress' || msg.type === 'topicBuilt' || msg.type === 'topicError') {
      if (msg.type === 'topicProgress') state.building = msg.text;
      if (msg.type === 'topicBuilt') {
        state.building = null;
        state.topic = msg.topic;
        state.topicOpen = true;
        state.topicView = 'map';
        refreshTopic();
      }
      if (msg.type === 'topicError') {
        state.building = null;
        state.topicError = msg.message;
      }
      renderTopic();
      render();
      return;
    }
    const m = state.messages[state.messages.length - 1];
    if (!m || m.role !== 'assistant') return;
    switch (msg.type) {
      case 'status':
        m.status = msg.text;
        break;
      case 'step':
        m.steps.push(msg.text);
        m.status = msg.text;
        break;
      case 'stream':
        m.content = msg.answer;
        if (msg.reasoning) m.reasoning = msg.reasoning;
        break;
      case 'sources':
        state.sources = msg.sources;
        break;
      case 'done':
        m.pending = false;
        if (msg.answer) m.content = msg.answer;
        if (msg.model) m.model = msg.model;
        if (msg.stopped && !m.content) m.error = 'Stopped.';
        setBusy(false);
        break;
      case 'error':
        m.pending = false;
        m.error = msg.message;
        setBusy(false);
        break;
    }
    scheduleRender();
  }

  function ask(question) {
    question = question.trim();
    if (!question || state.busy) return;
    try {
      ensureAlive();
    } catch {
      return;
    }
    const history = state.messages
      .filter((m) => !m.error && m.content)
      .map((m) => ({ role: m.role, content: m.role === 'user' && m.quote ? `About "${m.quote.text.slice(0, 300)}": ${m.content}` : m.content }));
    const quote = state.quote;
    state.messages.push({ role: 'user', content: question, quote });
    state.messages.push({ role: 'assistant', content: '', steps: [], pending: true, status: 'Starting' });
    setQuote(null);
    input.value = '';
    autosize();
    setBusy(true);
    render();
    connect().postMessage({
      type: 'ask',
      question,
      history,
      sources: state.sources,
      page: { ...pageInfo(), selection: quote },
      topicId: state.topic?.id || null,
    });
  }

  function showPreview(src) {
    previewEl.hidden = false;
    previewEl.innerHTML = `
      <div class="preview-head c${pageColor(src.page)}">
        <span class="num">${src.n}</span>
        <span class="preview-title">
          <span class="page-name">${W.markdown.esc(src.page)}</span>
          <span class="section-name">${W.markdown.esc(src.section)}</span>
        </span>
        <button class="icon close-preview" aria-label="Close preview">×</button>
      </div>
      <div class="preview-text">${W.markdown.esc(src.text)}</div>
      <div class="preview-actions">
        ${src.current ? '<button class="link show-in-page">Show in article</button>' : `<a class="link" href="${linkedUrl(src)}" target="_blank" rel="noopener">Open “${W.markdown.esc(src.page)}” ↗</a>`}
      </div>`;
    previewEl.dataset.n = src.n;
  }

  function onCite(n) {
    const src = state.sources[n - 1];
    if (!src) return;
    if (src.current) {
      const found = highlightSource(src);
      if (found) previewEl.hidden = true;
      else showPreview(src);
    } else showPreview(src);
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
    if (state.busy) state.port?.postMessage({ type: 'stop' });
    state.messages = [];
    state.sources = [];
    previewEl.hidden = true;
    CSS.highlights?.delete('wikiai-cite');
    setQuote(null);
    setBusy(false);
    render();
  });

  $('.composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.busy) state.port?.postMessage({ type: 'stop' });
    else ask(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!state.busy) ask(input.value);
    }
    e.stopPropagation(); // keep Wikipedia's keyboard shortcuts out of the textarea
  });
  input.addEventListener('input', autosize);

  // Remember opened/closed step and thinking lists, so streaming re-renders don't snap them shut.
  messagesEl.addEventListener(
    'toggle',
    (e) => {
      const d = e.target;
      const m = state.messages[Number(d.closest('.msg')?.dataset.i)];
      if (!m) return;
      if (d.classList.contains('steps')) m.stepsOpen = d.open;
      if (d.classList.contains('reasoning')) m.reasoningOpen = d.open;
    },
    true
  );

  root.addEventListener('click', (e) => {
    const t = e.target.closest('button, a');
    if (!t) return;
    if (t.matches('.cite, .source')) onCite(Number(t.dataset.n));
    else if (t.matches('.suggestion')) ask(t.textContent);
    else if (t.matches('.clear-quote')) setQuote(null);
    else if (t.matches('.close-preview')) previewEl.hidden = true;
    else if (t.matches('.show-in-page')) highlightSource(state.sources[Number(previewEl.dataset.n) - 1]);
    else if (t.matches('.open-settings')) openOptions();
    else if (t.matches('.reload-page')) location.reload();
    else if (t.matches('.build-topic, .rebuild-topic')) buildTopic();
    else if (t.matches('.stop-topic')) state.port?.postMessage({ type: 'stopTopic' });
    else if (t.matches('.toggle-topic')) {
      state.topicOpen = !state.topicOpen;
      state.topicView = 'map';
      renderTopic();
    } else if (t.matches('.show-saved')) {
      state.topicOpen = true;
      state.topicView = 'saved';
      renderTopic();
    } else if (t.matches('.back-to-map')) {
      state.topicView = 'map';
      renderTopic();
    } else if (t.matches('.close-saved')) {
      state.topicOpen = false;
      renderTopic();
    } else if (t.matches('.add-page')) topicAction(() => send({ type: 'topics:addPage', id: state.topic.id, title }));
    else if (t.matches('.remove-page')) topicAction(() => send({ type: 'topics:removePage', id: state.topic.id, title: t.dataset.title }));
    else if (t.matches('.leave-topic')) {
      state.topicOpen = false;
      topicAction(() => send({ type: 'topics:setActive', id: null }));
    } else if (t.matches('.open-topic')) {
      state.topicView = 'map';
      topicAction(() => send({ type: 'topics:setActive', id: t.dataset.id }));
    } else if (t.matches('.delete-topic')) {
      const name = state.savedTopics.find((x) => x.id === t.dataset.id)?.name;
      if (confirm(`Delete the topic “${name}”? This can't be undone.`)) topicAction(() => send({ type: 'topics:delete', id: t.dataset.id }));
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
})();
