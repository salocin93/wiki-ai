// What gets read for a question: which passages of the article, of the articles the question names and of a topic go
// to the model before it starts, the searches behind its tools, and the numbered sources they become. No model here:
// the tool-calling loop is in agent.js (Run extends this).
import { appSettings } from './settings.js';
import { asyncUtil } from './async.js';
import { bm25 } from './bm25.js';
import { decisions } from './decisions.js';
import { embeddings } from './embeddings.js';
import { linkRank } from './links.js';
import { textUtil } from './text.js';
import { wiki } from './wiki.js';

const estTokens = (s) => appSettings.estTokens(s);
// Passages read ahead for a question, before the model starts. Retrieval already ranks more than this, and the model
// had made no tool calls in the traces that prompted the raise, so what it isn't shown it doesn't use. The token
// budgets in hints() and otherArticleHints() (format) still bound the text, so this adds no requests.
const CURRENT_PASSAGES = 6; // this article (4 when another article is named too)
const NAMED_PASSAGES = 5; // each article the question names
const TOPIC_PASSAGES = 8; // a topic: two per article at most (6 when another article is named)
const TOOL_PASSAGES = 6; // each search the model makes; the tool budget (format) still bounds the text
const SEARCHED_ARTICLES = 2; // articles the question names that this page doesn't link to, read ahead (also: opened by search_wikipedia)
const SEARCHED_PASSAGES = 4; // passages of each
const FOUND_PASSAGES = 3; // passages search_wikipedia shows of each of its top articles
const SEARCH_AHEAD_MS = 2500; // the read-ahead waits this long for Wikipedia to say which names are articles

// Shown once per answer when semantic search is skipped for a reason that is not an error.
const SOFT_NOTES = {
  pending: 'Semantic index still building in the background, using keyword search for now',
  budget: "Today's embedding budget is used up, using keyword search until it resets",
  size: 'The whole topic is too large to search by meaning: using keyword search across it (single articles can still use meaning)',
};
// "What should I read next" style questions get ranked recommendations instead of a keyword search over links.
const READ_NEXT = /\b(read(ing)? next|read after|should i read|worth reading|recommend|suggest(ions?)? (for )?(reading|articles?)|what else (to|should)|where (should|do) i (go|continue)|learn more|further reading|related articles?|dig deeper)\b|als nächstes lesen|weiterlesen|lesenswert|lire ensuite|à lire|leer a continuación|leggere dopo/i;

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

const { escapeRe, bareTitle } = textUtil;

// Names a question might use for an article: its title, its link text, and short forms
// ("Christian I of Denmark" → "Christian I", "Elimar I, Count of Oldenburg" → "Elimar I").
// Single words are left out: "Christian" or "Holstein" alone are too ambiguous.
// A title bracketed with a name or a year ("Imperial Guard (Russia)") isn't known by its bare name: others share it.
function namesFor(title, anchors = []) {
  const base = bareTitle(title).trim();
  const short = base.split(',')[0].replace(/\s+of\s+\p{Lu}[^,]*$/u, '').trim();
  const bare = textUtil.qualifiedByName(title) ? [] : [base, short];
  return [...new Set([...bare, ...anchors].map((n) => n.trim()))].filter((n) => n.split(/\s+/).length >= 2);
}

// Words that join the parts of a name ("Congress of Vienna", "Otto von Bismarck").
const NAME_JOIN = /^(of|the|von|van|de|du|la|le|der|des|di|del)$/i;

// One-word names in a question: capitalised words that stand alone ("Prussia" in "Tell me more about Prussia"), not
// inside a longer name ("Vienna" in "Congress of Vienna") and not an ordinary word that opens the sentence ("Tell").
function loneNames(text) {
  const words = (text.match(/[\p{L}\p{M}\p{N}'’-]+/gu) || []).map((w) => w.replace(/['’]s$/, ''));
  const name = (w) => !!w && /^\p{Lu}/u.test(w) && bm25.tokenize(w).length > 0;
  const beside = (i, step) => (NAME_JOIN.test(words[i + step] || '') ? words[i + 2 * step] : words[i + step]);
  return [...new Set(words.filter((w, i) => w.length >= 4 && name(w) && !name(beside(i, -1)) && !name(beside(i, 1))))];
}

// A question that leans on the one before it ("And what happened to him afterwards?"): a pronoun and little else.
const REFERS_BACK = /\b(he|she|him|her|his|hers|it|its|they|them|their|that|this|those|these|there|then|ihm|ihn|ihnen|dessen|deren|dort|danach|davor|damals)\b/i;

// Questions about the conversation itself ("what was my first question?"): nothing to look up in the articles.
const ABOUT_CHAT = /\b(my (first|last|previous|earlier|other) questions?|which of my questions|(you|did you) (said|say|answered|answer|told|wrote|mentioned)|earlier in (this|the) (chat|conversation)|(this|our) (chat|conversation)|recap)\b|meine (erste|letzte|vorige) frage|hast du (gesagt|geantwortet)|ma (première|dernière) question|tu as (dit|répondu)|mi (primera|última) pregunta|(dijiste|respondiste)/i;

const shortName = bareTitle;

const linkText = (l) => `${l.title} ${l.title} ${(l.anchors || []).join(' ')} ${l.context} ${l.sections.join(' ')}`;

// Wikipedia text is quoted inside these tags; text that tries to close them early loses the tag.
const quoted = (t) => (t || '').replace(/<\/?\s*(passage|wikipedia)\b[^>]*>/gi, '');

const linkLabel = (l) => (l.anchors?.length ? `${l.title} (linked as "${l.anchors[0]}")` : l.title);

class Retriever {
  constructor({ settings, page, topic, question, history, sources, emit, signal }) {
    this.settings = settings;
    this.topic = topic || null; // active topic cluster, if any
    this.page = page; // {lang, title, url, links, categories, visibleSection: {name, path, text}, selection}
    this.linkIndex = null; // search over the page's links, built on first use
    this.current = null; // the article being read, indexed: {page, chunks, index}; set when a run starts
    this.corpus = null; // every article of the topic in one index, when there is a topic
    this.visible = null; // the section on screen: {name, path, text}
    this.semanticSoft = new Set(); // reasons semantic search was skipped (not errors) already shown during this answer
    this.question = question;
    this.history = history || [];
    this.sources = sources || []; // shared with the UI across the conversation
    this.read = new Map(); // article → language, for those the model was shown passages from for this answer
    this.emit = emit;
    this.signal = signal;
    this.model = settings.model;
    // What happened while answering, for "Copy debug info" (the service worker's console is out of reach).
    this.trace = { started: new Date().toISOString(), calls: [], tools: [], notes: [], stages: /** @type {Record<string, number>} */ ({}) }; // stages: ms before the first model call
  }

  get budget() {
    return appSettings.contextFor(this.settings, this.model);
  }

  // Registers a passage as a citable source and returns its number.
  /**
   * @param {Chunk} chunk
   * @param {boolean} current
   * @returns {number} the source number
   */
  cite(chunk, current) {
    const key = `${chunk.lang}|${chunk.page}|${chunk.section}|${chunk.text.slice(0, 80)}`;
    let src = this.sources.find((s) => s.key === key);
    // A saved chat keeps uncited passages without their text, and cited ones shortened: read again, it comes back whole.
    if (src && (src.text || '').length < chunk.text.length) src.text = chunk.text;
    if (src && chunk.figure && !src.figure) src.figure = chunk.figure;
    if (src && chunk.revid) src.revid = chunk.revid;
    if (!src) {
      src = { n: this.sources.length + 1, key, lang: chunk.lang, page: chunk.page, section: chunk.section, text: chunk.text, current };
      if (chunk.revid) src.revid = chunk.revid; // the revision quoted, so links can show that version
      if (chunk.figure) src.figure = chunk.figure; // the panel shows the image with the answer
      this.sources.push(src);
    }
    return src.n;
  }

  format(chunks, maxTokens) {
    const current = (c) => c.page === this.current.page.title;
    const out = [];
    let used = 0;
    for (const c of chunks) {
      const block = `[${this.cite(c, current(c))}] ${c.page} › ${c.section}\n<passage>\n${quoted(c.text)}\n</passage>`;
      if (used && used + estTokens(block) > maxTokens) {
        out.push('(more text omitted; search with narrower keywords)');
        break;
      }
      out.push(block);
      used += estTokens(block);
      this.read.set(c.page, c.lang); // the passages shown to the model, not those only ranked for recommendations
    }
    return out.join('\n\n');
  }

  get toolBudget() {
    return Math.max(1200, Math.floor(this.budget * 0.15));
  }

  // Topic articles can be from another language's Wikipedia than the page the reader is on.
  langOf(title) {
    const t = wiki.normTitle(title || '');
    return this.topic && this.topic.lang !== this.page.lang && this.topic.pages.some((p) => p.title === t) ? this.topic.lang : this.page.lang;
  }

  // Ranked passages from an article or a topic corpus: led by the sections that match the question's meaning when semantic
  // search is on, else BM25. Embedding trouble (no key, rate limit, a quota used up, a local server that's off) leaves the
  // keyword results, never an error.
  async retrieve(entry, query, k) {
    const ranking = decisions.available(this.settings);
    const keyword = entry.index.search(query, this.settings.semanticSearch || ranking ? Math.max(k, 40) : k);
    // Section ranking first: one quick call, nothing to embed or store. When it can't answer (too slow, rate limited,
    // too many sections), what was used before is used: embeddings when they are on, keywords otherwise.
    if (ranking) {
      try {
        const rated = await decisions.retrieve(entry, query, keyword, this.settings, { signal: this.signal });
        if (rated) {
          const cost = `${rated.model}, ${rated.ms} ms, ${rated.tokens} tokens`;
          if (rated.length) this.trace.notes.push(`section ranking (${cost}): ${rated.sections} sections → ${rated.length} passages`);
          else this.trace.notes.push(`section ranking (${cost}): no section related enough, using keywords`);
          return rated.length ? rated.slice(0, k) : keyword.slice(0, k);
        }
      } catch (e) {
        if (this.signal?.aborted) throw e;
        this.trace.notes.push(`section ranking not used: ${e.message}`);
      }
    }
    if (!this.settings.semanticSearch) return keyword.slice(0, k);
    try {
      // Spend embedding quota only where keyword search looks unsure about this question.
      const gate = await embeddings.gate(entry, query, keyword, this.settings);
      if (!gate.use || gate.reason !== 'vectors stored') this.trace.notes.push(`semantic gate: ${gate.use ? 'use' : 'skip'} (${gate.reason})`);
      if (!gate.use) {
        if (gate.soft && !this.semanticSoft.has(gate.soft)) {
          this.semanticSoft.add(gate.soft);
          this.emit({ type: 'step', text: SOFT_NOTES[gate.soft] });
        }
        return keyword.slice(0, k);
      }
      let fresh = false; // this question had to embed the sections itself: nothing stored for the model that was picked
      // A topic corpus calls this once per article still to embed: say it once, naming the topic.
      const onStart = () => {
        if (fresh) return;
        fresh = true;
        const what = entry.entries ? `the “${this.topic?.name || 'topic'}” topic articles` : `“${entry.page?.title || 'the article'}”`;
        this.emit({ type: 'step', text: `Embedding ${what} for semantic search` });
      };
      const meaning = await embeddings.retrieve(entry, query, keyword, this.settings, { signal: this.signal, onStart });
      if (!meaning) return keyword.slice(0, k);
      if (!meaning.length) {
        this.trace.notes.push('semantic: no section related enough, using keywords');
        return keyword.slice(0, k);
      }
      this.trace.notes.push(`semantic (${meaning.model}${fresh ? ', embedded just now' : ', stored vectors'}): ${meaning.sections} sections → ${meaning.length} passages`);
      return meaning.slice(0, k);
    } catch (e) {
      if (this.signal?.aborted) throw e;
      if (e.soft) {
        // Not a failure: still being embedded in the background, today's budget is used up, or the topic is too large.
        this.trace.notes.push(`semantic search not used (${e.soft}), using keywords: ${e.message}`);
        if (!this.semanticSoft.has(e.soft)) {
          this.semanticSoft.add(e.soft);
          this.emit({ type: 'step', text: SOFT_NOTES[e.soft] });
        }
        return keyword.slice(0, k);
      }
      this.trace.notes.push(`semantic search failed, using keywords: ${e.message}`);
      if (!this.semanticWarned) {
        this.semanticWarned = true;
        this.emit({ type: 'step', text: 'Semantic search unavailable, using keyword search' });
      }
      return keyword.slice(0, k);
    }
  }

  // Keyword search over links, re-ranked so central links win over ones that only share a word.
  searchLinks(query, k) {
    const links = this.page.links || [];
    this.linkIndex ||= new bm25.BM25(links, linkText, { lang: this.page.lang });
    const title = this.current.page.title;
    return this.linkIndex
      .search(query, 30)
      .map((h) => ({ doc: h.doc, score: h.score + 0.4 * linkRank.importance(h.doc, title, this.visible?.name, linkRank.boxSizes(links)) }))
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
    let pool = linkRank.rank(links, title, { focusSection: vis }).slice(0, 45);
    if (focus.trim()) {
      this.linkIndex ||= new bm25.BM25(links, linkText, { lang: this.page.lang });
      const rel = new Map(this.linkIndex.search(focus, 40).map((h) => [h.doc.title, h.score]));
      const max = Math.max(1, ...rel.values());
      pool = [...pool, ...[...rel.keys()].filter((t) => !pool.some((p) => p.link.title === t)).map((t) => ({ link: links.find((l) => l.title === t), score: 0 }))]
        .map((p) => ({ ...p, score: p.score + 6 * ((rel.get(p.link.title) || 0) / max) }))
        .filter((p) => rel.has(p.link.title) || p.score > 6);
    }
    const stats = await wiki.linkStats(this.page.lang, pool.map((p) => p.link.title), title, this.signal).catch(() => new Map());
    const scored = [];
    for (const p of pool) {
      const st = stats.get(wiki.normTitle(p.link.title));
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
    const summaries = await asyncUtil.mapLimit(picks, 3, (p) => wiki.getSummary(this.page.lang, p.link.title, this.signal).catch(() => null));
    picks.forEach((p, i) => (p.summary = summaries[i]));

    const inTopic = new Set(this.topic?.pages.map((p) => p.title) || []);
    const line = ({ link: l, st, summary }) => {
      const first = l.context?.split(' … ')[0] || '';
      // Real sentences only: chart boxes and fact-box rows make poor quotes.
      const sentence = first && !/^(Navigation box|Infobox|Listed under)/.test(first) && first.split(/\s+/).length >= 6 ? first : '';
      const cite = sentence ? `[${this.cite({ lang: this.page.lang, page: title, section: l.sections?.[0] || 'Introduction', text: sentence }, true)}] ` : '';
      const why = [linkRank.reasons(l, title), st?.linksBack ? 'links back to this article' : '', st ? `${Math.round(st.length / 1000)} KB article` : '']
        .filter(Boolean)
        .join('; ');
      const ex = summary?.extract || '';
      const intro = ex.length > 420 ? ex.slice(0, 420).replace(/\s+\S*$/, '…') : ex;
      const introCite = intro ? `[${this.cite({ lang: this.page.lang, page: summary.title, section: 'Introduction', text: intro, revid: summary.revid }, false)}] ` : '';
      return `- ${quoted(linkLabel(l))}${st?.description ? ` — ${quoted(st.description)}` : ''}${inTopic.has(l.title) ? ' (already in the topic)' : ''}
Ranked for: ${why}${sentence ? `\n  ${cite}This article mentions it: <passage>${quoted(sentence.slice(0, 200))}</passage>` : ''}${intro ? `\n  ${introCite}Its own introduction: <passage>${quoted(intro)}</passage>` : ''}`;
    };
    let out = `Recommended articles to read next from "${title}"${focus ? ` (focus: ${focus})` : ''}.`;
    if (central.length) out += `\n\nMost central to the article:\n${central.map(line).join('\n')}`;
    if (reading.length) out += `\n\nFrom the section the reader is looking at ("${vis}"):\n${reading.map(line).join('\n')}`;
    return out;
  }

  // Articles the question names: linked articles, topic articles and pages cited earlier in this chat.
  mentionedArticles(text) {
    const current = this.current.page.title;
    // Names of this article, so "Ada Lovelace" doesn't pick the linked "Ada Lovelace (microarchitecture)". A name
    // that is part of this article's name counts too: on "Vincent van Gogh", the linked film "Van Gogh (1948 film)"
    // is named by every question about the painter.
    const own = namesFor(current).map((n) => n.toLowerCase());
    const ownName = (n) => own.some((o) => new RegExp(`(^|\\s)${escapeRe(n)}($|\\s)`, 'i').test(o));
    const names = new Map(); // lowercased name → title
    const add = (t, anchors) => {
      if (!t || t === current) return;
      for (const n of namesFor(t, anchors)) if (!ownName(n.toLowerCase()) && !names.has(n.toLowerCase())) names.set(n.toLowerCase(), t);
    };
    for (const l of this.page.links || []) add(l.title, l.anchors);
    for (const p of this.topic?.pages || []) add(p.title);
    const found = [];
    for (const [name, t] of [...names].sort((a, b) => b[0].length - a[0].length)) {
      if (found.some((f) => f.title === t || f.name.includes(name))) continue;
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(name)}($|[^\\p{L}\\p{N}])`, 'iu').test(text)) found.push({ name, title: t });
      if (found.length >= 3) break;
    }
    // One-word names: the article with exactly that title ("Prussia"), else the only one whose name ends in it
    // ("Bismarck" → "Otto von Bismarck"). Not in German, which capitalises every noun.
    const titles = [...new Set([...(this.page.links || []).map((l) => l.title), ...(this.topic?.pages || []).map((p) => p.title)])].filter((t) => t && t !== current);
    for (const word of this.page.lang === 'de' ? [] : loneNames(text)) {
      const w = word.toLowerCase();
      if (found.length >= 3) break;
      if (ownName(w) || found.some((f) => f.name.split(/\s+/).includes(w))) continue;
      const exact = titles.find((t) => t.toLowerCase() === w);
      const ending = titles.filter((t) => !textUtil.qualifiedByName(t) && /\s/.test(shortName(t)) && shortName(t).toLowerCase().split(/\s+/).pop() === w);
      // Both when there is one of each: "Verdun" is the town and, in an article on the war, the battle.
      for (const t of [exact, ending.length === 1 ? ending[0] : '']) if (t && found.length < 3 && !found.some((f) => f.title === t)) found.push({ name: w, title: t });
    }
    // A question about one thing only ("What is caffeine?", "Erzähl mir mehr über Preußen"): the article with that
    // name, capital or not, in any language.
    const lang = this.page.lang;
    const asked = bm25.tokenize(text, lang);
    if (asked.length === 1 && found.length < 3 && !bm25.tokenize(current, lang).includes(asked[0])) {
      const tokens = (x) => (textUtil.qualifiedByName(x) ? [] : bm25.tokenize(shortName(x), lang));
      const ending = titles.filter((x) => tokens(x).length > 1 && tokens(x).at(-1) === asked[0]);
      const t = titles.find((x) => tokens(x).join(' ') === asked[0]) || (ending.length === 1 ? ending[0] : ''); // "Königreich Preußen"
      if (t && !found.some((f) => f.title === t)) found.push({ name: asked[0], title: t });
    }
    return found.map((f) => f.title);
  }

  // The best passages of another article for a question, its introduction among them.
  async passagesOf(entry, query, k) {
    let hits = (await this.retrieve(entry, query, k)).map((h) => h.doc);
    if (!hits.some((c) => c.section === 'Introduction')) hits = [entry.chunks[0], ...hits].filter(Boolean).slice(0, k);
    return hits;
  }

  // Articles the question names that this page doesn't link to ("What was decided at the Congress of Vienna?" on
  // George V of Hanover): every run of up to five of its words is looked up as a title, in one Wikipedia request, and
  // the longest names win. Wikipedia's full-text search isn't used for this: asked "decided Congress Vienna" it
  // returns the Concert of Europe and the history of Vienna, and reading those would pull the answer off the subject.
  // A name written with a capital may lead there by a redirect ("Wiener Kongress"). Words without one count only as
  // the title of an article that this article never uses a word of ("photosynthesis"): "life", "afterwards" and
  // "chemical energy" are articles too, and "tea leaves" redirects to the tea plant. German capitalises every noun,
  // so there a name takes two of them, or one and a number ("Wiener Kongress", "Krieg von 1866"). A single word is
  // never followed through a redirect.
  async namedElsewhere(query, skip) {
    const words = (query.match(/[\p{L}\p{M}\p{N}'’-]+/gu) || []).slice(0, 40).map((w) => w.replace(/['’]s$/, ''));
    const lang = this.page.lang;
    const content = (w) => bm25.tokenize(w, lang).length > 0;
    const spans = [];
    for (let n = 5; n >= 1; n--) {
      for (let i = 0; i + n <= words.length; i++) if (content(words[i]) && content(words[i + n - 1])) spans.push({ i, n, text: words.slice(i, i + n).join(' ') });
    }
    if (!spans.length) return [];
    let timer;
    const late = new Promise((resolve) => (timer = setTimeout(() => resolve(null), SEARCH_AHEAD_MS)));
    const found = await Promise.race([wiki.articlesNamed(this.page.lang, spans.map((s) => s.text), this.signal).catch(() => new Map()), late]);
    clearTimeout(timer);
    if (!found) this.trace.notes.push('Looking up the names in the question took too long; read ahead without them');
    const own = new Set(bm25.tokenize(this.current.page.title, lang));
    const used = (this.corpus || this.current).index?.df; // the words this article (or topic) has
    const taken = [];
    const names = [];
    for (const s of spans) {
      const hit = found?.get(wiki.normTitle(s.text));
      if (!hit || names.some((x) => s.i >= x.i && s.i + s.n <= x.i + x.n)) continue; // "Vienna" inside "Congress of Vienna"
      names.push(s); // a name, read or not: the words inside it aren't names of their own
      if (hit.title === this.current.page.title || skip.includes(hit.title) || taken.some((x) => x.title === hit.title)) continue;
      const tokens = bm25.tokenize(s.text, lang);
      if (tokens.every((w) => own.has(w))) continue; // this article's own name
      const marked = words.slice(s.i, s.i + s.n).filter((w, j) => (s.i + j > 0 && /^\p{Lu}/u.test(w)) || (lang === 'de' && /^\d/.test(w))).length;
      const proper = marked >= (lang === 'de' ? 2 : 1);
      const unused = !!used && tokens.every((w) => !used.has(w));
      if (s.n === 1 ? hit.redirect || s.text.length < 5 || !unused : !proper && (hit.redirect || !unused)) continue;
      taken.push({ ...s, title: hit.title });
      if (taken.length >= SEARCHED_ARTICLES) break;
    }
    return taken.map((x) => x.title);
  }

  // Passages from the articles a question names, read before the model starts. Articles from earlier answers
  // aren't read ahead: a keyword score can't tell a follow-up on them from a new question, and wrongly
  // pre-read passages pulled answers off topic. The model has the chat and opens them itself when needed.
  async otherArticleHints(query) {
    // A question that points back names its subject in the question before it ("What is caffeine?", then "How does it
    // affect sleep?"): that one is read for names on its own too.
    const previous = this.previousQuestion();
    const named = [...new Set([...this.mentionedArticles(query), ...(previous ? this.mentionedArticles(previous) : [])])].slice(0, 3);
    this.namedLinked = named.length; // these take two of this article's passages; the ones found by name elsewhere don't
    const searched = named.length >= 3 ? [] : (await this.namedElsewhere(query, named)).slice(0, 3 - named.length);
    if (searched.length) this.trace.notes.push(`Read ahead, named in the question though not linked: ${searched.join(', ')}`);
    const targets = [...named.map((t) => ({ t, k: NAMED_PASSAGES, html: true })), ...searched.map((t) => ({ t, k: SEARCHED_PASSAGES, html: false }))];
    this.aboutArticles = [];
    let out = '';
    for (const { t, k, html } of targets) {
      const e = await wiki.getIndexedPage(this.langOf(t), t, { html, signal: this.signal }).catch(() => null);
      if (!e) continue;
      this.aboutArticles.push(t);
      this.emit({ type: 'step', text: `Reading “${e.page.title}”` });
      const hits = await this.passagesOf(e, query, k);
      out += `\n\nPassages from "${e.page.title}" (the question is about it):\n${this.format(hits, (this.budget * 0.14) / targets.length)}`;
    }
    return out;
  }

  // The words to search with: the question and any selected text, and for a question that only points back
  // ("what happened to him afterwards?") the reader's previous question too, which names what it is about.
  searchQuery() {
    const previous = this.previousQuestion();
    const query = `${this.question} ${(this.page.selection?.text || '').slice(0, 300)}`;
    return previous ? `${query} ${previous}` : query;
  }

  // The reader's question before this one, when this one only points back: a pronoun and at most three other words.
  previousQuestion() {
    if (this.page.selection?.text || !REFERS_BACK.test(this.question) || bm25.tokenize(this.question, this.page.lang).length > 3) return '';
    return (this.history.findLast((m) => m.role === 'user')?.content || '').slice(0, 300);
  }

  // Retrieval done up front, so even small models start from relevant text and know which links exist.
  async hints() {
    const sel = this.page.selection?.text || '';
    const query = this.searchQuery();
    // A question about the chat is answered from the chat; passages found by its words would pull the answer off topic.
    if (!sel && ABOUT_CHAT.test(this.question)) return '';
    if (READ_NEXT.test(this.question)) {
      this.emit({ type: 'step', text: 'Ranking linked articles to read next' });
      return `\n\n${await this.recommend()}`;
    }
    const other = await this.otherArticleHints(query);
    const fewer = this.namedLinked > 0;
    const passages = this.corpus
      ? diverse(await this.retrieve(this.corpus, query, 30), fewer ? TOPIC_PASSAGES - 2 : TOPIC_PASSAGES, 2)
      : (await this.retrieve(this.current, query, fewer ? CURRENT_PASSAGES - 2 : CURRENT_PASSAGES))
          .map((h) => h.doc)
          .filter((c) => c.section !== 'Introduction');
    const from = this.corpus ? 'the topic articles' : `"${this.current.page.title}"`;
    let out = other + (passages.length ? `\n\nPassages from ${from} that may help:\n${this.format(passages, this.budget * 0.1)}` : '');
    const links = this.page.links || [];
    if (links.length) {
      const hits = this.searchLinks(query, 5);
      if (hits.length) {
        out += `\n\nLinked articles that may be relevant (read them with linked_article_summary or search_linked_article):\n`;
        out += `<wikipedia>\n${hits.map(({ doc: l }) => `- ${quoted(linkLabel(l))}${l.context ? ` — "${quoted(l.context.slice(0, 160))}"` : ''}`).join('\n')}\n</wikipedia>`;
      }
    }
    return out;
  }
}

export const retriever = { Retriever, TOOL_PASSAGES, SEARCHED_ARTICLES, FOUND_PASSAGES, diverse, loneNames, shortName, quoted, linkLabel, estTokens };
