// Minimal, escape-first Markdown renderer for model answers. Turns [3] into citation buttons.
import { answerLinks } from './answerlinks.js';
import { textUtil } from '../lib/text.js';

const { esc } = textUtil;
const CITE_SPACED = new RegExp(`(\\s*)${textUtil.CITE.source}`, 'gi');

const OPEN_LINK = /\uE020(\d+)\uE021/g;

// flags: {notes, kinds} of the sentences render() marked as not matched to the sources. links: articles to link to.
function inline(text, known, attrs, flags, links) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  // Numbers the model made up (no such source) are dropped, with the space before them.
  s = s.replace(CITE_SPACED, (whole, space, nums) => {
    const ns = nums.match(/\d+/g).map(Number).filter((n) => known(n));
    if (!ns.length) return '';
    return space + ns
      .map((n) => {
        const a = attrs?.(n) || {};
        const label = a.label ?? n;
        return `<button class="cite ${a.className || ''}" data-n="${n}" data-label="${label}" title="${esc(a.title || `Source ${label}`)}" aria-label="Source ${label}${a.title ? `: ${esc(a.title)}` : ''}" tabindex="-1">${label}</button>`; // the source chips under the answer are the keyboard stops
      })
      .join('');
  });
  s = s
    .replace(OPEN_LINK, (_, k) => {
      const { lang, title } = links[k];
      return `<a class="answer-link" href="${esc(textUtil.articleUrl(lang, title))}" target="_blank" rel="noopener noreferrer" title="Open “${esc(title)}”">`;
    })
    .replace(/\uE022/g, '</a>');
  return s.replace(/(\d+)/g, (_, i) => `<span class="unsupported${flags.kinds[i] === 'uncited' ? ' uncited' : ''}" title="${esc(flags.notes[i] || '')}">`).replace(//g, '</span>');
}

const VALID_LANG = /^[a-z][a-z0-9-]{0,20}$/;
const withoutMarkers = (t) => t.replace(/[\uE000-\uF8FF]/g, '');

// Formulas: $$…$$ and \[…\] on their own, $…$ and \(…\) inline. An inline $ pair needs no space just inside
// it and no digit right after, so prices ("$5 and $10") stay text. Each becomes a placeholder until the end.
const MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?!\d)/g;

function takeMath(src) {
  const formulas = [];
  const text = src.replace(MATH, (whole, block, block2, inl, inl2) => {
    const tex = block ?? block2 ?? inl ?? inl2;
    const display = block != null || block2 != null;
    let html;
    try {
      html = globalThis.katex.renderToString(tex.trim(), { displayMode: display, throwOnError: false, strict: 'ignore', errorColor: 'inherit' });
    } catch {
      html = esc(whole);
    }
    formulas.push(html);
    return `\uE010${formulas.length - 1}\uE011`;
  });
  return { text, put: (html) => html.replace(/\uE010(\d+)\uE011/g, (_, k) => formulas[k]) };
}

// attrs(n) may return {title, className, label} for citation n; label is the number shown (default n).
// flagged: [{text, note, kind}], sentences to underline as not matched to the sources ('uncited': no source given).
// links: {items: [{title, lang}], self}, articles to link to at their first mention, and the article being read.
function render(src, known = () => true, attrs, flagged = [], links = null) {
  const flags = { notes: flagged.map((f) => f.note), kinds: flagged.map((f) => f.kind) };
  // Private-use characters are this renderer's own markers; any in the model's text would be taken for them.
  src = withoutMarkers(src);
  flagged.forEach((f, i) => {
    const text = withoutMarkers(f.text);
    if (!text.includes('\n')) src = src.replace(text, () => `${i}${text}`);
  });
  const math = globalThis.katex ? takeMath(src) : null;
  if (math) src = math.text;
  else if (markdown.onMath && src.search(MATH) >= 0) markdown.onMath(); // KaTeX loads on first use; formulas show as text until then
  const found = links?.items?.length ? answerLinks.spans(src, links.items.filter((l) => VALID_LANG.test(l.lang || '')), links.self) : [];
  for (let k = found.length - 1; k >= 0; k--) {
    const { start, end } = found[k];
    src = `${src.slice(0, start)}\uE020${k}\uE021${src.slice(start, end)}\uE022${src.slice(end)}`;
  }
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map((l) => inline(l, known, attrs, flags, found)).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i, known, attrs, flags, found)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (const line of src.split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      out.push(`<h4>${inline(heading[1], known, attrs, flags, found)}</h4>`);
    } else if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      list ||= { tag, items: [] };
      list.items.push((bullet || numbered)[1]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else if (list && /^\s{2,}/.test(line)) {
      list.items[list.items.length - 1] += ' ' + line.trim();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return math ? math.put(out.join('')) : out.join('');
}

// onMath: set by the panel, called when an answer has a formula and KaTeX isn't loaded yet.
export const markdown = { render, onMath: null };
