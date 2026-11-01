// Topic map: the topic's articles as a graph (dots colored by theme, sized by connections, lines for links),
// shown over the article area next to the sidebar. No library: a small force layout is enough for ~30 nodes.
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});
  const esc = (s) => W.markdown.esc(String(s ?? ''));

  // Deterministic layout: same topic, same picture.
  function layout(topic, w, h) {
    const nodes = topic.pages.map((p) => ({ id: p.title, page: p, deg: 0 }));
    const index = new Map(nodes.map((n, i) => [n.id, i]));
    const seen = new Set();
    const edges = [];
    for (const [a, b] of topic.edges || []) {
      if (!index.has(a) || !index.has(b) || a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const [i, j] = [index.get(a), index.get(b)];
      edges.push([i, j]);
      nodes[i].deg++;
      nodes[j].deg++;
    }

    const facets = topic.facets.map((f) => f.name);
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.3;
    const anchorOf = (n) => {
      const i = facets.indexOf(n.page.facet);
      if (n.page.seed || i < 0) return { x: cx, y: cy };
      const a = (i / facets.length) * 2 * Math.PI - Math.PI / 2;
      return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
    };
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const n of nodes) {
      n.anchor = anchorOf(n);
      n.x = n.anchor.x + (rnd() - 0.5) * 80;
      n.y = n.anchor.y + (rnd() - 0.5) * 80;
    }

    // Fruchterman–Reingold, with a pull toward each theme's anchor so themes read as groups.
    const k = Math.sqrt((w * h) / Math.max(1, nodes.length)) * 0.45;
    const steps = 400;
    for (let it = 0; it < steps; it++) {
      const temp = (1 - it / steps) * k * 0.6 + 1;
      for (const n of nodes) n.dx = n.dy = 0;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          const d = Math.max(1, Math.hypot(dx, dy));
          const f = (k * k) / d;
          dx = (dx / d) * f;
          dy = (dy / d) * f;
          a.dx += dx;
          a.dy += dy;
          b.dx -= dx;
          b.dy -= dy;
        }
      }
      for (const [i, j] of edges) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const f = ((d * d) / k) * 0.12; // weak: topics are densely linked
        a.dx -= (dx / d) * f;
        a.dy -= (dy / d) * f;
        b.dx += (dx / d) * f;
        b.dy += (dy / d) * f;
      }
      for (const n of nodes) {
        const pull = n.page.seed ? 0.9 : 0.35;
        n.dx += (n.anchor.x - n.x) * pull * (k / 60);
        n.dy += (n.anchor.y - n.y) * pull * (k / 60);
        const d = Math.max(1, Math.hypot(n.dx, n.dy));
        n.x += (n.dx / d) * Math.min(d, temp);
        n.y += (n.dy / d) * Math.min(d, temp);
      }
    }

    // Fit into the box, leaving room for labels.
    const pad = { x: 90, y: 40 };
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const scale = Math.min((w - 2 * pad.x) / Math.max(1, maxX - minX), (h - 2 * pad.y) / Math.max(1, maxY - minY));
    for (const n of nodes) {
      n.x = pad.x + (n.x - minX) * scale + (w - 2 * pad.x - (maxX - minX) * scale) / 2;
      n.y = pad.y + (n.y - minY) * scale + (h - 2 * pad.y - (maxY - minY) * scale) / 2;
      n.r = 5 + Math.sqrt(n.deg) * 1.8 + (n.page.seed ? 4 : 0);
    }
    return { nodes, edges };
  }

  // Full-size map over the article area, next to the sidebar. Returns a function that closes it.
  function open(opts) {
    opts.root.querySelector('.map-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'map-overlay';
    overlay.style.right = `${opts.rightInset || 0}px`;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', `Map of the topic ${opts.topic.name}`);
    opts.root.appendChild(overlay);
    return draw(overlay, opts, true);
  }

  // Map inside a container (the sidebar's Map tab). Returns a function that removes it.
  function mount(container, opts) {
    container.classList.add('map-inline');
    return draw(container, opts, false);
  }

  // colorOf(page) → class name c0…c5, shared with the sidebar's citation colors.
  function draw(box, { topic, currentTitle, colorOf, onOpenArticle, onAsk, onExpand }, isOverlay) {
    const legend = topic.facets
      .map((f) => {
        const page = topic.pages.find((p) => p.facet === f.name);
        return page ? `<button class="legend-item ${colorOf(page)}" data-facet="${esc(f.name)}"><span class="swatch"></span>${esc(f.name)}</button>` : '';
      })
      .join('');
    box.innerHTML = `
      <div class="map-head">
        <div class="map-title"><strong>${esc(topic.name)}</strong><span class="map-meta"></span></div>
        <div class="legend">${legend}</div>
        ${
          isOverlay
            ? '<button class="icon map-close" title="Close map (Esc)" aria-label="Close map">×</button>'
            : '<button class="icon map-expand" title="Enlarge map" aria-label="Enlarge map"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg></button>'
        }
      </div>
      <svg class="map-svg" role="img" aria-label="Graph of the topic's articles"></svg>
      <div class="map-card" hidden></div>
      <div class="map-hint">${isOverlay ? 'Hover to see connections · click for details · scroll to zoom · drag to move' : 'Click for details · scroll to zoom'}</div>`;

    const svg = box.querySelector('svg.map-svg');
    const rect = svg.getBoundingClientRect();
    const w = Math.max(280, Math.round(rect.width) || 400);
    const h = Math.max(240, Math.round(rect.height) || 400);
    const { nodes, edges } = layout(topic, w, h);
    const neighbors = nodes.map(() => new Set());
    edges.forEach(([i, j]) => {
      neighbors[i].add(j);
      neighbors[j].add(i);
    });
    box.querySelector('.map-meta').textContent = `${nodes.length} articles · ${edges.length} links between them`;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML = `
        <g class="edges">${edges
          .map(([i, j], e) => `<line data-e="${e}" x1="${nodes[i].x.toFixed(1)}" y1="${nodes[i].y.toFixed(1)}" x2="${nodes[j].x.toFixed(1)}" y2="${nodes[j].y.toFixed(1)}"/>`)
          .join('')}</g>
        <g class="nodes">${nodes
          .map(
            (n, i) => `<g class="node ${colorOf(n.page)}${n.id === currentTitle ? ' here' : ''}" data-i="${i}" transform="translate(${n.x.toFixed(1)},${n.y.toFixed(1)})" tabindex="0" role="button" aria-label="${esc(n.id)}">
              <circle r="${n.r.toFixed(1)}"/>
              <text y="${(n.r + 13).toFixed(1)}">${esc(n.id.length > 34 ? n.id.slice(0, 33) + '…' : n.id)}</text>
            </g>`
          )
          .join('')}</g>`;

    const card = box.querySelector('.map-card');
    const lines = [...svg.querySelectorAll('line')];
    const nodeEls = [...svg.querySelectorAll('.node')];
    const hereEl = svg.querySelector('.node.here');
    if (hereEl) hereEl.parentNode.appendChild(hereEl); // drawn last, so no circle covers its label
    let selected = null;
    let themeFilter = null;

    function highlight(i) {
      svg.classList.toggle('focus', i != null || themeFilter != null);
      nodeEls.forEach((el, k) => {
        const on = i != null ? k === i || neighbors[i].has(k) : themeFilter != null && nodes[k].page.facet === themeFilter;
        el.classList.toggle('hl', on);
      });
      lines.forEach((l, e) => {
        const [a, b] = edges[e];
        const on = i != null ? a === i || b === i : themeFilter != null && nodes[a].page.facet === themeFilter && nodes[b].page.facet === themeFilter;
        l.classList.toggle('hl', on);
      });
    }

    function select(i) {
      selected = i;
      nodeEls.forEach((el, k) => el.classList.toggle('selected', k === i));
      highlight(i);
      if (i == null) {
        card.hidden = true;
        return;
      }
      const n = nodes[i];
      const linked = [...neighbors[i]].map((k) => nodes[k].id);
      card.hidden = false;
      card.className = `map-card ${colorOf(n.page)}`;
      card.innerHTML = `
        <div class="card-head"><span class="swatch"></span><span class="card-theme">${esc(n.page.seed ? 'Starting article' : n.page.facet)}</span>
          <button class="icon card-close" aria-label="Close details">×</button></div>
        <h3>${esc(n.id)}</h3>
        ${n.page.description ? `<p class="card-desc">${esc(n.page.description)}</p>` : ''}
        ${n.page.summary ? `<p class="card-summary">${esc(n.page.summary)}${n.page.summary.length >= 270 ? '…' : ''}</p>` : ''}
        <p class="card-links">${linked.length ? `Linked with ${linked.length} other article${linked.length > 1 ? 's' : ''} in this topic: ${linked.slice(0, 6).map(esc).join(', ')}${linked.length > 6 ? '…' : ''}` : 'Not linked with the other articles.'}</p>
        <div class="card-actions">
          ${n.id === currentTitle ? '<span class="tag">You are reading this article</span>' : `<button class="primary open-article">Open article</button>`}
          <button class="ask-article">Ask about it in the chat</button>
        </div>`;
    }

    // Zoom and pan by changing the viewBox.
    const view = { x: 0, y: 0, w, h };
    const applyView = () => {
      svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
      scheduleLabels();
    };

    // Labels keep their size on screen while zooming; where they would overlap, the less connected
    // article's label is hidden until it's hovered or selected, so zooming in reveals more of them.
    const order = nodes.map((n, i) => i).sort((a, b) => (nodes[b].id === currentTitle) - (nodes[a].id === currentTitle) || nodes[b].deg - nodes[a].deg);
    function placeLabels() {
      svg.style.setProperty('--label-scale', String(view.w / w));
      const hits = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
      const circles = nodes.map((n) => ({ x1: n.x - n.r, y1: n.y - n.r, x2: n.x + n.r, y2: n.y + n.r }));
      const placed = [];
      for (const i of order) {
        const text = nodeEls[i].querySelector('text');
        text.classList.remove('crowded');
        const b = text.getBBox();
        const box = { x1: nodes[i].x + b.x - 2, y1: nodes[i].y + b.y - 1, x2: nodes[i].x + b.x + b.width + 2, y2: nodes[i].y + b.y + b.height + 1 };
        const here = nodes[i].id === currentTitle; // the reader's article always keeps its label
        if (!here && (placed.some((p) => hits(box, p)) || circles.some((c, k) => k !== i && hits(box, c)))) text.classList.add('crowded');
        else placed.push(box);
      }
    }
    let labelFrame = 0;
    function scheduleLabels() {
      cancelAnimationFrame(labelFrame);
      labelFrame = requestAnimationFrame(placeLabels);
    }
    placeLabels();
    const toSvg = (e) => {
      const r = svg.getBoundingClientRect();
      return { x: view.x + ((e.clientX - r.left) / r.width) * view.w, y: view.y + ((e.clientY - r.top) / r.height) * view.h };
    };
    svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = toSvg(e);
        const f = Math.exp(e.deltaY * 0.0015);
        const nw = Math.min(w * 3, Math.max(w / 6, view.w * f));
        const nh = (nw / view.w) * view.h;
        view.x = p.x - ((p.x - view.x) * nw) / view.w;
        view.y = p.y - ((p.y - view.y) * nh) / view.h;
        view.w = nw;
        view.h = nh;
        applyView();
      },
      { passive: false }
    );
    let drag = null;
    svg.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.node')) return;
      drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const r = svg.getBoundingClientRect();
      const dx = ((e.clientX - drag.x) / r.width) * view.w;
      const dy = ((e.clientY - drag.y) / r.height) * view.h;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      view.x = drag.vx - dx;
      view.y = drag.vy - dy;
      applyView();
    });
    svg.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved && !e.target.closest('.node')) select(null);
      drag = null;
    });

    svg.addEventListener('pointerover', (e) => {
      const el = e.target.closest('.node');
      if (el && selected == null) highlight(Number(el.dataset.i));
    });
    svg.addEventListener('pointerout', (e) => {
      if (e.target.closest('.node') && selected == null) highlight(null);
    });
    svg.addEventListener('click', (e) => {
      const el = e.target.closest('.node');
      if (el) select(Number(el.dataset.i));
    });
    svg.addEventListener('keydown', (e) => {
      const el = e.target.closest('.node');
      if (el && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        select(Number(el.dataset.i));
      }
    });

    function close() {
      if (isOverlay) box.remove();
      else box.innerHTML = '';
      document.removeEventListener('keydown', onKey, true);
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (selected != null) select(null);
        else close();
      }
    };
    if (isOverlay) document.addEventListener('keydown', onKey, true);

    box.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.matches('.map-close')) close();
      else if (t.matches('.map-expand')) onExpand?.();
      else if (t.matches('.card-close')) select(null);
      else if (t.matches('.open-article')) onOpenArticle(nodes[selected].id);
      else if (t.matches('.ask-article')) {
        onAsk(nodes[selected].id);
        if (isOverlay) close();
      } else if (t.matches('.legend-item')) {
        themeFilter = themeFilter === t.dataset.facet ? null : t.dataset.facet;
        box.querySelectorAll('.legend-item').forEach((b) => b.classList.toggle('active', b.dataset.facet === themeFilter));
        select(null);
      }
    });

    return close;
  }

  W.topicMap = { open, mount, layout };
})(globalThis);
