// Minimal, escape-first Markdown renderer for model answers. Turns [3] into citation buttons.
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});

  const { esc } = W.text;
  const CITE_SPACED = new RegExp(`(\\s*)${W.text.CITE.source}`, 'gi');

  // flags: {notes, kinds} of the sentences render() marked as not matched to the sources.
  function inline(text, known, attrs, flags) {
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
    return s.replace(/(\d+)/g, (_, i) => `<span class="unsupported${flags.kinds[i] === 'uncited' ? ' uncited' : ''}" title="${esc(flags.notes[i] || '')}">`).replace(//g, '</span>');
  }

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
    const flags = { notes: flagged.map((f) => f.note), kinds: flagged.map((f) => f.kind) };
    // Private-use characters are this renderer's own markers; any in the model's text would be taken for them.
    src = withoutMarkers(src);
    flagged.forEach((f, i) => {
      const text = withoutMarkers(f.text);
      if (!text.includes('\n')) src = src.replace(text, () => `${i}${text}`);
    });
    const math = g.katex ? takeMath(src) : null;
    if (math) src = math.text;
    else if (W.markdown.onMath && src.search(MATH) >= 0) W.markdown.onMath(); // KaTeX loads on first use; formulas show as text until then
    const out = [];
    let list = null;
    let para = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map((l) => inline(l, known, attrs, flags)).join('<br>')}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i, known, attrs, flags)}</li>`).join('')}</${list.tag}>`);
      list = null;
    };
    for (const line of src.split('\n')) {
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (heading) {
        flushPara();
        flushList();
        out.push(`<h4>${inline(heading[1], known, attrs, flags)}</h4>`);
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
  W.markdown = { render, onMath: null };
})(globalThis);
