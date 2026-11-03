// Minimal, escape-first Markdown renderer for model answers. Turns [3] into citation buttons.
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});

  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // Matches [3], [2, 5], [Source 3] and 【3】.
  const CITE = /(?:\[|【)\s*(?:sources?\s*)?(\d{1,3}(?:\s*[,;]\s*(?:sources?\s*)?\d{1,3})*)\s*(?:\]|】)/gi;

  const CITE_SPACED = new RegExp(`(\\s*)${CITE.source}`, 'gi');

  function inline(text, known, attrs) {
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
    return s.replace(/(\d+)/g, (_, i) => `<span class="unsupported${flagKinds[i] === 'uncited' ? ' uncited' : ''}" title="${esc(flagNotes[i] || '')}">`).replace(//g, '</span>');
  }

  let flagNotes = [];
  let flagKinds = [];

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
        html = g.katex.renderToString(tex.trim(), { displayMode: display, throwOnError: false, strict: 'ignore', errorColor: 'inherit' });
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
  function render(src, known = () => true, attrs, flagged = []) {
    flagNotes = flagged.map((f) => f.note);
    flagKinds = flagged.map((f) => f.kind);
    flagged.forEach((f, i) => {
      if (!f.text.includes('\n')) src = src.replace(f.text, () => `${i}${f.text}`);
    });
    const math = g.katex ? takeMath(src) : null;
    if (math) src = math.text;
    const out = [];
    let list = null;
    let para = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map((l) => inline(l, known, attrs)).join('<br>')}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i, known, attrs)}</li>`).join('')}</${list.tag}>`);
      list = null;
    };
    for (const line of src.split('\n')) {
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (heading) {
        flushPara();
        flushList();
        out.push(`<h4>${inline(heading[1], known, attrs)}</h4>`);
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

  function citedNumbers(src) {
    const seen = new Set();
    for (const m of src.matchAll(CITE)) for (const n of m[1].match(/\d+/g)) seen.add(Number(n));
    return [...seen];
  }

  // For text shown plainly (suggested questions saved before they were cleaned up).
  const plain = (t) =>
    t
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1');

  W.markdown = { render, citedNumbers, esc, plain };
})(globalThis);
