// Wikipedia access: plain-text articles split into sections and chunks, summaries, search indexes.
import { bm25 } from './bm25.js';
import { cache } from './cache.js';
import { htmlTables } from './tables.js';
import { sectionNames } from './sections.js';

const CHUNK_WORDS = 160;
const TIMEOUT_MS = 20_000; // per Wikipedia request

const normTitle = (t) => t.replace(/_/g, ' ').trim();

// Wikimedia asks API clients to say who they are and how to reach the maintainer.
const USER_AGENT = `WikiAI/${globalThis.chrome?.runtime?.getManifest?.().version || 'dev'} (https://github.com/salocin93/wiki-ai)`;

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason || new Error('Aborted'));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(undefined);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

// One Wikipedia request, given up after TIMEOUT_MS or when signal aborts. When Wikipedia is busy (a lagging
// database, "maxlag", or 429/503), it waits as long as Wikipedia asks, up to 10 s, and tries again twice.
async function getJSON(url, signal) {
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let res;
    let data;
    try {
      res = await fetch(url, { headers: { 'Api-User-Agent': USER_AGENT }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      data = res.ok ? await res.json() : null;
    } catch (e) {
      if (timeout.aborted && !signal?.aborted) throw new Error(`Wikipedia didn't answer within ${TIMEOUT_MS / 1000} s. Try again.`);
      throw e;
    }
    const busy = res.status === 429 || res.status === 503 || data?.error?.code === 'maxlag';
    if (busy && attempt < 2) {
      await sleep(Math.min(Number(res.headers.get('retry-after')) || 5, 10) * 1000, signal);
      continue;
    }
    if (!res.ok) throw new Error(`Wikipedia API returned ${res.status}`);
    if (data?.error) throw new Error(`Wikipedia API: ${data.error.info || data.error.code}`);
    return data;
  }
}

// The Wikipedia of a language code ("en", "de", "zh-yue"). Anything else is refused, so a malformed code
// can never turn the address into another host.
function host(lang) {
  if (!/^[a-z][a-z0-9-]{0,20}$/.test(lang || '')) throw new Error(`Not a Wikipedia language code: "${lang}"`);
  return `${lang}.wikipedia.org`;
}

// maxlag: Wikimedia asks automated clients to back off while its databases lag behind.
function apiUrl(lang, params) {
  const url = new URL(`https://${host(lang)}/w/api.php`);
  const all = { format: 'json', formatversion: '2', origin: '*', maxlag: 5, ...params };
  for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v);
  return url.toString();
}

// The plain-text extract writes formulas as "{\displaystyle E=mc^{2}}"; as "$E=mc^{2}$" the model reads them as
// LaTeX and the panel can render them when they're quoted.
function texToDollars(text) {
  let out = '';
  let from = 0;
  for (let at; (at = text.indexOf('{\\displaystyle', from)) >= 0; ) {
    let depth = 0;
    let end = at;
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}' && --depth === 0) break;
    }
    if (end >= text.length) break; // unbalanced: leave the rest as it is
    const tex = text.slice(at + '{\\displaystyle'.length, end).trim();
    out += text.slice(from, at).replace(/[ \t]*\n[ \t]*$/, ' ') + `$${tex}$`;
    from = end + 1;
    // The extract puts each formula on its own line; inside a sentence it rejoins with a space.
    if (text[from] === '\n' && text[from + 1] !== '\n') {
      out += ' ';
      from++;
    }
  }
  return out + text.slice(from);
}

// Turns the "== Heading ==" plain-text extract into sections with breadcrumb paths.
function parseExtract(text) {
  text = texToDollars(text);
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
    .filter((s) => !sectionNames.isSkipped(s.root))
    .map(({ title, path, lines }) => ({ title, path, text: lines.join('\n').trim() }));
}

function splitSentences(paragraph) {
  return paragraph.match(/[^.!?]+(?:[.!?]+["')\]]*\s*|$)/g) || [paragraph];
}

const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;

/** @returns {Chunk[]} */
function chunkPage(page) {
  const chunks = [];
  for (const s of page.sections) {
    const tables = s.tables || [];
    const figures = s.figures || [];
    let buf = [];
    let n = 0;
    const flush = () => {
      if (!buf.length) return;
      chunks.push({ page: page.title, lang: page.lang, revid: page.revid, section: s.path, text: buf.join('\n').trim() });
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
    // Table rows after the section's prose, each chunk headed with the table's name so it reads on its own.
    for (const t of tables) {
      const head = `${t.infobox ? 'Infobox' : 'Table'}${t.caption && t.caption !== 'Infobox' ? `: ${t.caption}` : ''}${t.columns ? `\nColumns: ${t.columns}` : ''}`;
      let rows = [];
      let words = 0;
      const flushRows = () => {
        if (rows.length) chunks.push({ page: page.title, lang: page.lang, revid: page.revid, section: s.path, text: `${head}\n${rows.join('\n')}`, table: true });
        rows = [];
        words = 0;
      };
      for (const line of t.lines) {
        const w = wordCount(line);
        if (words && words + w > CHUNK_WORDS) flushRows();
        rows.push(line);
        words += w;
      }
      flushRows();
    }
    // One passage per image: its caption and what Wikimedia Commons says about the file.
    for (const f of figures) {
      const lines = [
        `Figure: ${f.caption || f.description || f.file}`,
        f.description && f.description !== f.caption ? `Description: ${f.description}` : '',
        `File: ${f.file}`,
        f.categories?.length ? `Categories: ${f.categories.join('; ')}` : '',
      ];
      chunks.push({ page: page.title, lang: page.lang, revid: page.revid, section: s.path, text: lines.filter(Boolean).join('\n'), figure: f });
    }
  }
  chunks.forEach((c, i) => (c.idx = i));
  return chunks;
}

// The article as sections of plain text; with `html`, each section also gets its tables, infoboxes and
// images, which the plain-text extract leaves out (that costs a second, larger request for the page's HTML,
// and one for the images' Commons details). `revid` is the revision the reader has open: a cached copy older
// than that is fetched again, so citations quote the text on the page.
/**
 * @param {string} lang
 * @param {string} title
 * @param {{ html?: boolean, revid?: number, signal?: AbortSignal }} [opts]
 */
async function getPage(lang, title, { html = true, revid = 0, signal } = {}) {
  // v2: pages carry their revision, and formulas as LaTeX; copies cached before that aren't used.
  const key = `page2:${html ? 'html:' : ''}${lang}:${normTitle(title)}`;
  const cached = await cache.get(key);
  if (cached && !(revid && (cached.revid || 0) < revid)) return cached;
  const page = await fetchPage(lang, title, html, signal);
  await cache.set(key, page);
  return page;
}

async function fetchPage(lang, title, html, signal) {
  const noParts = { tables: [], figures: [] };
  const [data, first] = await Promise.all([
    getJSON(
      apiUrl(lang, {
        action: 'query', prop: 'extracts|info', explaintext: 1, exsectionformat: 'wiki',
        redirects: 1, inprop: 'url', titles: normTitle(title),
      }),
      signal
    ),
    html ? getHtmlParts(lang, title, signal).catch(() => noParts) : noParts,
  ]);
  const p = data.query?.pages?.[0];
  if (!p || p.missing || p.invalid) throw new Error(`No Wikipedia article called "${title}"`);
  // The two requests can land on either side of an edit: read the tables of the extract's revision then.
  let parts = first;
  if (html && first.revid && p.lastrevid && first.revid !== p.lastrevid) {
    parts = await getHtmlParts(lang, title, signal, p.lastrevid).catch(() => first);
  }
  const sections = parseExtract(p.extract || '');
  // By path, else by the heading alone; parts under skipped sections (references, external links) stay out.
  const sectionOf = (path) => sections.find((x) => x.path === path) || sections.find((x) => x.title === path.split(' › ').pop());
  for (const [key, list] of /** @type {Array<['tables' | 'figures', any[]]>} */ ([['tables', parts.tables], ['figures', parts.figures]])) {
    for (const x of list) {
      const s = sectionOf(x.path);
      if (s) (s[key] ||= []).push(x);
    }
  }
  return { lang, title: p.title, url: p.fullurl, revid: p.lastrevid || 0, sections };
}

// oldid: a particular revision instead of the current one.
async function getHtmlParts(lang, title, signal, oldid) {
  const page = oldid ? { oldid } : { page: normTitle(title), redirects: 1 };
  const data = await getJSON(apiUrl(lang, { action: 'parse', prop: 'text', disableeditsection: 1, disabletoc: 1, ...page }), signal);
  const html = data.parse?.text || '';
  const figures = htmlTables.figures(html);
  await describeFiles(lang, figures, signal).catch(() => {});
  return { tables: htmlTables.extract(html), figures, revid: data.parse?.revid || 0 };
}

// Categories that say how a file is licensed or maintained, not what it shows.
const FILE_ADMIN = /licen|\bGFDL\b|\bCC[- ]|\bPD[- ]|public domain|self-published|own work|uploaded|^files?\b|\bfiles\b|^media\b|\bpages\b|\bimages? (with|by|from|of)\b|redundant|\bvalid svg|created with|^svg\b|photographs taken|featured|quality images|scans|\bpng\b|\bjpe?g\b|^images\b|personality rights|vectori[sz]ations?\b/i;

// Adds what Wikimedia Commons (or the local wiki) knows about each image: its description, topic categories,
// author and licence, and a thumbnail to show. One request per 50 images.
async function describeFiles(lang, figures, signal) {
  const byName = new Map(figures.map((f) => [`File:${f.file}`, f]));
  for (const batch of batches([...byName.keys()])) {
    const data = await getJSON(
      apiUrl(lang, { action: 'query', prop: 'imageinfo', iiprop: 'extmetadata|url', iiurlwidth: 400, iiextmetadatafilter: 'ImageDescription|Categories|Artist|LicenseShortName', titles: batch.join('|') }),
      signal
    );
    const q = data.query || {};
    const renamed = new Map((q.normalized || []).map(({ from, to }) => [to, from]));
    for (const p of q.pages || []) {
      const f = byName.get(renamed.get(p.title) || p.title);
      const ii = p.imageinfo?.[0];
      if (!f || !ii) continue;
      const meta = (k) => htmlTables.text(String(ii.extmetadata?.[k]?.value || ''));
      f.description = meta('ImageDescription').slice(0, 400);
      f.categories = meta('Categories').split('|').map((c) => c.trim()).filter((c) => c && !FILE_ADMIN.test(c)).slice(0, 6);
      f.artist = meta('Artist').slice(0, 120);
      f.license = meta('LicenseShortName');
      f.thumb = ii.thumburl;
      f.url = ii.descriptionurl;
    }
  }
}

async function getSummary(lang, title, signal) {
  const key = `summary2:${lang}:${normTitle(title)}`; // v2: with the revision
  return cache.wrap(key, async () => {
    const slug = encodeURIComponent(normTitle(title).replace(/ /g, '_'));
    const s = await getJSON(`https://${host(lang)}/api/rest_v1/page/summary/${slug}`, signal);
    return { title: s.title, description: s.description || '', extract: s.extract || '', url: s.content_urls?.desktop?.page, revid: Number(s.revision) || 0 };
  });
}

// Short descriptions and introductions of many articles, 20 per request (instead of one request each).
// Returns Map(requested title → {title, description, summary}); missing articles are left out.
// From a query response: the title a requested one ends up at, after normalising and up to 3 redirects.
function redirectTarget(q) {
  const hop = new Map();
  for (const { from, to } of [...(q.normalized || []), ...(q.redirects || [])]) hop.set(from, to);
  return (title) => {
    let cur = title;
    for (let i = 0; i < 3 && hop.has(cur); i++) cur = hop.get(cur);
    return cur;
  };
}

async function describeMany(lang, titles, signal) {
  const out = new Map();
  for (const batch of batches([...new Set(titles.map(normTitle))], 20)) {
    const data = await getJSON(
      apiUrl(lang, { action: 'query', redirects: 1, prop: 'extracts|description', exintro: 1, explaintext: 1, exlimit: 20, titles: batch.join('|') }),
      signal
    );
    const q = data.query || {};
    const final = redirectTarget(q);
    const pages = new Map((q.pages || []).filter((p) => !p.missing && !p.invalid).map((p) => [p.title, p]));
    for (const t of batch) {
      const p = pages.get(final(t));
      if (p) out.set(t, { title: p.title, description: p.description || '', summary: (p.extract || '').trim() });
    }
  }
  return out;
}

// Built indexes are cheap to rebuild, so they live only in memory. Like getPage, an index older than the
// reader's revision is rebuilt.
const indexes = new Map();
/**
 * @param {string} lang
 * @param {string} title
 * @param {{ html?: boolean, revid?: number, signal?: AbortSignal }} [opts]
 */
async function getIndexedPage(lang, title, { html = true, revid = 0, signal } = {}) {
  const key = `${html ? 'html:' : ''}${lang}:${normTitle(title)}`;
  const known = indexes.get(key);
  if (known && !(revid && (known.page.revid || 0) < revid)) return known;
  const page = await getPage(lang, title, { html, revid, signal });
  const chunks = chunkPage(page);
  const index = new bm25.BM25(chunks, (c) => `${c.section} ${c.section} ${c.text}`);
  const entry = { page, chunks, index };
  indexes.set(key, entry);
  indexes.set(`${html ? 'html:' : ''}${lang}:${page.title}`, entry); // also under the redirect target
  if (indexes.size > 60) indexes.delete(indexes.keys().next().value);
  return entry;
}

const batches = (items, size = 50) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

// Maps each requested title to the canonical title of an existing article (following redirects); drops missing ones.
async function resolveTitles(lang, titles, signal) {
  const out = new Map();
  for (const batch of batches([...new Set(titles.map(normTitle))])) {
    const data = await getJSON(apiUrl(lang, { action: 'query', redirects: 1, titles: batch.join('|') }), signal);
    const q = data.query || {};
    const final = redirectTarget(q);
    const existing = new Set((q.pages || []).filter((p) => !p.missing && !p.invalid && p.ns === 0).map((p) => p.title));
    for (const t of batch) {
      const cur = final(t);
      if (existing.has(cur)) out.set(t, cur);
    }
  }
  return out;
}

async function search(lang, query, limit = 3, signal) {
  const data = await getJSON(apiUrl(lang, { action: 'query', list: 'search', srsearch: query, srlimit: limit, srnamespace: 0, srprop: '' }), signal);
  return (data.query?.search || []).map((r) => r.title);
}

// Links among a set of articles: [[from, to], …], from the link tables (no page text needed).
async function linksBetween(lang, fromTitles, toTitles, signal) {
  const edges = [];
  for (const from of batches(fromTitles)) {
    for (const to of batches(toTitles)) {
      let cont = {};
      do {
        const data = await getJSON(
          apiUrl(lang, { action: 'query', prop: 'links', titles: from.join('|'), pltitles: to.join('|'), pllimit: 'max', ...cont }),
          signal
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
async function linkStats(lang, titles, to, signal) {
  const out = new Map();
  // A few batches at a time: a long article has over a thousand links.
  await mapLimit(batches([...new Set(titles.map(normTitle))]), 2, async (batch) => {
    const data = await getJSON(
      apiUrl(lang, {
        action: 'query', redirects: 1, titles: batch.join('|'),
        prop: 'info|description|pageprops|links', ppprop: 'disambiguation', pltitles: normTitle(to), pllimit: 'max',
      }),
      signal
    );
    const q = data.query || {};
    const final = redirectTarget(q);
    const pages = new Map((q.pages || []).filter((p) => !p.missing).map((p) => [p.title, p]));
    for (const t of batch) {
      const p = pages.get(final(t));
      if (!p) continue;
      out.set(t, {
        title: p.title,
        length: p.length || 0,
        description: p.description || '',
        disambiguation: p.pageprops?.disambiguation !== undefined,
        linksBack: (p.links || []).length > 0,
      });
    }
  });
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

// Drops the in-memory indexes, e.g. after the reader cleared the cache.
const forget = () => indexes.clear();

export const wiki = { forget, getPage, getSummary, describeMany, getIndexedPage, parseExtract, texToDollars, chunkPage, normTitle, resolveTitles, search, linksBetween, linkStats, mapLimit };
