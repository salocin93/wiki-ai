// Minimal, escape-first Markdown renderer for model answers. Turns [3] into citation buttons.
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});

  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // Matches [3], [2, 5], [Source 3] and 【3】.
  const CITE = /(?:\[|【)\s*(?:sources?\s*)?(\d{1,3}(?:\s*[,;]\s*(?:sources?\s*)?\d{1,3})*)\s*(?:\]|】)/gi;

  function inline(text, known) {
    let s = esc(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(CITE, (whole, nums) => {
      const ns = nums.match(/\d+/g).map(Number);
      if (!ns.every((n) => known(n))) return whole;
      return ns.map((n) => `<button class="cite" data-n="${n}" title="Show source ${n}">${n}</button>`).join('');
    });
    return s;
  }

  function render(src, known = () => true) {
    const out = [];
    let list = null;
    let para = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map((l) => inline(l, known)).join('<br>')}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i, known)}</li>`).join('')}</${list.tag}>`);
      list = null;
    };
    for (const line of src.split('\n')) {
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (heading) {
        flushPara();
        flushList();
        out.push(`<h4>${inline(heading[1], known)}</h4>`);
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
    return out.join('');
  }

  function citedNumbers(src) {
    const seen = new Set();
    for (const m of src.matchAll(CITE)) for (const n of m[1].match(/\d+/g)) seen.add(Number(n));
    return [...seen];
  }

  W.markdown = { render, citedNumbers, esc };
})(globalThis);
