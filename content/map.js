// Topic map: the topic's articles as a graph (dots colored by theme, sized by connections, lines for links),
// shown over the article area next to the sidebar. No library: a fixed grouped layout is enough for ~30 nodes.
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});
  const esc = (s) => W.markdown.esc(String(s ?? ''));

  // Deterministic layout: same topic, same picture. Each theme gets its own round region on a ring around the
  // starting article, so themes never overlap; inside a region articles are packed in a sunflower spiral, the
  // most connected ones in the middle. Lines between regions then show how the themes relate.
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

    // Groups: the starting article(s) in the middle, then one per theme (articles of an unknown theme last).
    const names = topic.facets.map((f) => f.name).filter((f) => nodes.some((n) => !n.page.seed && n.page.facet === f));
    if (nodes.some((n) => !n.page.seed && !names.includes(n.page.facet))) names.push(null);
    const groupOf = (n) => (n.page.seed ? -1 : names.includes(n.page.facet) ? names.indexOf(n.page.facet) : names.indexOf(null));
    nodes.forEach((n) => (n.group = groupOf(n)));
    const members = (g) =>
      nodes.filter((n) => n.group === g).sort((a, b) => b.deg - a.deg || (a.id < b.id ? -1 : 1));

    // Put themes that link to each other a lot next to each other on the ring (tries every order for up to 7).
    const F = names.length;
    const weight = names.map(() => names.map(() => 0));
    for (const [i, j] of edges) {
      const [a, b] = [nodes[i].group, nodes[j].group];
      if (a >= 0 && b >= 0 && a !== b) weight[a][b] = ++weight[b][a];
    }
    let ring = names.map((_, i) => i);
    if (F > 2 && F <= 7) {
      const cost = (o) => {
        let c = 0;
        for (let x = 0; x < F; x++)
          for (let y = x + 1; y < F; y++) c += weight[o[x]][o[y]] * Math.min(y - x, F - (y - x));
        return c;
      };
      let best = cost(ring);
      const permute = (prefix, rest) => {
        if (!rest.length) {
          const c = cost(prefix);
          if (c < best) [best, ring] = [c, prefix];
          return;
        }
        rest.forEach((r, k) => permute([...prefix, r], [...rest.slice(0, k), ...rest.slice(k + 1)]));
      };
      permute([0], ring.slice(1));
    }

    // Sizes in units of one article spacing; regions are wider than tall, since labels are.
    const c = 0.58;
    const wide = 1.5;
    const pack = (list, cx, cy) =>
      list.forEach((n, i) => {
        const r = list.length === 1 ? 0 : c * Math.sqrt(i + 0.5);
        const a = i * 2.39996; // golden angle
        n.ux = cx + r * Math.cos(a) * wide;
        n.uy = cy + r * Math.sin(a);
      });
    const radiusOf = (count) => (count <= 1 ? 0.6 : c * Math.sqrt(count - 0.5) + 0.6);
    const seeds = members(-1);
    const seedR = seeds.length ? radiusOf(seeds.length) + 0.3 : 0;
    const groups = names.map((name, g) => ({ name, list: members(g), r: radiusOf(members(g).length) }));
    // Regions sit on an oval shaped like the box, pushed out just far enough that none overlap (with room for
    // the theme names). Of two rotations of the ring, keep the one that draws everything biggest.
    const pad = { x: 36, top: 34, bottom: 26 };
    const regions = [...(seeds.length ? [{ r: seedR, fixed: true }] : []), ...ring.map((g) => groups[g])];
    const [ex, ey] = [w / Math.max(w, h), h / Math.max(w, h)];
    const apart = (p, q) =>
      Math.abs(p.ux - q.ux) >= (p.r + q.r) * wide + 0.8 || Math.abs(p.uy - q.uy) >= p.r + q.r + 1.1;
    let best = null;
    for (const offset of F > 1 ? [0, Math.PI / F] : [0]) {
      const at = (A) =>
        regions.forEach((reg) => {
          const k = ring.indexOf(groups.indexOf(reg));
          const a = (k / Math.max(1, F)) * 2 * Math.PI - Math.PI / 2 + offset;
          [reg.ux, reg.uy] = reg.fixed ? [0, 0] : [A * ex * Math.cos(a), A * ey * Math.sin(a)];
        });
      let A = 0;
      for (at(A); regions.some((p, i) => regions.some((q, j) => j > i && !apart(p, q))); at((A += 0.1)));
      // The ring is sized for the biggest region; pull the others in toward the middle as far as they fit.
      for (let it = 0; it < 40; it++) {
        for (const reg of regions) {
          if (reg.fixed) continue;
          const [x, y] = [reg.ux, reg.uy];
          [reg.ux, reg.uy] = [x * 0.95, y * 0.95];
          if (regions.some((q) => q !== reg && !apart(reg, q))) [reg.ux, reg.uy] = [x, y];
        }
      }
      const minX = Math.min(...regions.map((reg) => reg.ux - reg.r * wide));
      const maxX = Math.max(...regions.map((reg) => reg.ux + reg.r * wide));
      const minY = Math.min(...regions.map((reg) => reg.uy - reg.r));
      const maxY = Math.max(...regions.map((reg) => reg.uy + reg.r));
      const scale = Math.min((w - 2 * pad.x) / (maxX - minX), (h - pad.top - pad.bottom) / (maxY - minY));
      if (!best || scale > best.scale) best = { at: regions.map((reg) => [reg.ux, reg.uy]), scale, minX, maxX, minY, maxY };
    }
    regions.forEach((reg, k) => ([reg.ux, reg.uy] = best.at[k]));
    pack(seeds, 0, 0);
    for (const grp of groups) pack(grp.list, grp.ux, grp.uy);

    // Fit into the box, leaving room for the labels under the articles and the theme names above the regions.
    const { scale, minX, maxX, minY, maxY } = best;
    const ox = pad.x + (w - 2 * pad.x - (maxX - minX) * scale) / 2 - minX * scale;
    const oy = pad.top + (h - pad.top - pad.bottom - (maxY - minY) * scale) / 2 - minY * scale;
    const maxDeg = Math.max(1, ...nodes.map((n) => n.deg));
    const rMax = Math.max(4, Math.min(13, scale * 0.34));
    const rMin = Math.max(3, rMax * 0.45);
    for (const n of nodes) {
      n.x = ox + n.ux * scale;
      n.y = oy + n.uy * scale;
      n.r = n.page.seed ? Math.min(rMax * 1.3, scale * 0.45) : rMin + (rMax - rMin) * Math.sqrt(n.deg / maxDeg);
    }
    const clusters = groups.map((grp) => ({
      name: grp.name,
      page: grp.list[0].page,
      x: ox + grp.ux * scale,
      y: oy + grp.uy * scale,
      rx: grp.r * scale * wide,
      ry: grp.r * scale,
    }));
    // One line per pair of linked themes, from region edge to region edge, standing in for their many links.
    const bundles = [];
    for (let a = 0; a < F; a++) {
      for (let b = a + 1; b < F; b++) {
        if (!weight[a][b]) continue;
        const [p, q] = [clusters[a], clusters[b]];
        const [dx, dy] = [q.x - p.x, q.y - p.y];
        const t = (c) => 1 / Math.hypot(dx / c.rx, dy / c.ry);
        bundles.push({ a, b, count: weight[a][b], x1: p.x + dx * t(p), y1: p.y + dy * t(p), x2: q.x - dx * t(q), y2: q.y - dy * t(q) });
      }
    }
    return { nodes, edges, clusters, bundles };
  }

  // Full-size map over the article area, next to the sidebar. Returns a function that closes it.
  function open(opts) {
    // An overlay still open is closed properly, so its Escape handler goes too.
    const old = opts.root.querySelector('.map-overlay');
    if (old) old.__close ? old.__close() : old.remove();
    const overlay = document.createElement('div');
    overlay.className = 'map-overlay';
    overlay.style.right = `${opts.rightInset || 0}px`;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', `Map of the topic ${opts.topic.name}`);
    opts.root.appendChild(overlay);
    overlay.__close = draw(overlay, opts, true);
    return overlay.__close;
  }

  // Map inside a container (the sidebar's Map tab). Returns a function that removes it.
  function mount(container, opts) {
    container.classList.add('map-inline');
    return draw(container, opts, false);
  }

  // colorOf(page) → class name c0…c5, shared with the sidebar's citation colors.
  function draw(box, { topic, currentTitle, colorOf, onOpenArticle, onAsk, onExpand, onList }, isOverlay) {
    const legend = topic.facets
      .map((f) => {
        const page = topic.pages.find((p) => p.facet === f.name);
        return page ? `<button class="legend-item ${colorOf(page)}" data-facet="${esc(f.name)}"><span class="swatch"></span>${esc(f.name)}</button>` : '';
      })
      .join('');
    box.innerHTML = `
      <div class="map-head">
        <div class="map-title"><strong>${esc(topic.name)}</strong><span class="map-meta"></span><span class="map-hint">${isOverlay ? 'Hover to see connections · click for details · scroll to zoom · drag to move' : 'Click for details · scroll to zoom · drag to move'}</span></div>
        <div class="legend">${legend}</div>
        ${onList ? '<button class="link map-list" title="The same articles as a list, in the Topic tab">List view</button>' : ''}
        ${
          isOverlay
            ? '<button class="icon map-close" title="Close map (Esc)" aria-label="Close map">×</button>'
            : '<button class="icon map-expand" title="Enlarge map" aria-label="Enlarge map"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg></button>'
        }
      </div>
      <svg class="map-svg" role="group" aria-label="Graph of the topic's articles: each article is a button. List view shows them as a list."></svg>
      <div class="map-card" hidden></div>`;

    const svg = box.querySelector('svg.map-svg');
    const rect = svg.getBoundingClientRect();
    const w = Math.max(280, Math.round(rect.width) || 400);
    const h = Math.max(240, Math.round(rect.height) || 400);
    const { nodes, edges, clusters, bundles } = layout(topic, w, h);
    const maxBundle = Math.max(1, ...bundles.map((b) => b.count));
    const neighbors = nodes.map(() => new Set());
    edges.forEach(([i, j]) => {
      neighbors[i].add(j);
      neighbors[j].add(i);
    });
    box.querySelector('.map-meta').textContent = `${nodes.length} articles · ${edges.length} links between them`;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML = `
        <g class="clusters">${clusters
          .map(
            (c) => `<g class="cluster ${colorOf(c.page)}" data-facet="${esc(c.name ?? '')}">
              <ellipse cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" rx="${c.rx.toFixed(1)}" ry="${c.ry.toFixed(1)}"/>
              <text x="${c.x.toFixed(1)}" y="${(c.y - c.ry - 6).toFixed(1)}">${esc(c.name ?? 'Other')}</text>
            </g>`
          )
          .join('')}</g>
        <g class="bundles">${bundles
          .map(
            (b, k) => `<line class="bundle" data-b="${k}" x1="${b.x1.toFixed(1)}" y1="${b.y1.toFixed(1)}" x2="${b.x2.toFixed(1)}" y2="${b.y2.toFixed(1)}" stroke-width="${(1.5 + 7 * Math.sqrt(b.count / maxBundle)).toFixed(1)}">
              <title>${b.count} link${b.count > 1 ? 's' : ''} between ${esc(clusters[b.a].name ?? 'Other')} and ${esc(clusters[b.b].name ?? 'Other')}</title></line>`
          )
          .join('')}</g>
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
    const lines = [...svg.querySelectorAll('.edges line')];
    const nodeEls = [...svg.querySelectorAll('.node')];
    const themeLabels = [...svg.querySelectorAll('.cluster text')];
    const bundleEls = [...svg.querySelectorAll('.bundle')];
    const hereEl = svg.querySelector('.node.here');
    if (hereEl) hereEl.parentNode.appendChild(hereEl); // drawn last, so no circle covers its label
    let selected = null;
    let themeFilter = null;
    let focus = null; // while something is highlighted: its articles get the labels first

    // Individual links show only for the hovered or selected article or the chosen theme. A hovered bundle
    // stands out itself and lights up the articles at its ends; drawing its dozens of links would be a wall.
    function highlight(i, bundle = null) {
      const inTheme = (k) => themeFilter != null && !nodes[k].page.seed && nodes[k].page.facet === themeFilter;
      const across = ([a, b]) =>
        (nodes[a].group === bundle.a && nodes[b].group === bundle.b) || (nodes[a].group === bundle.b && nodes[b].group === bundle.a);
      const linkOn = ([a, b]) => (i != null ? a === i || b === i : bundle ? false : inTheme(a) || inTheme(b));
      svg.classList.toggle('focus', i != null || bundle != null || themeFilter != null);
      focus = svg.classList.contains('focus') ? { lead: i, on: new Set() } : null;
      nodeEls.forEach((el, k) => {
        const on = i != null ? k === i || neighbors[i].has(k) : bundle ? edges.some((e) => across(e) && e.includes(k)) : inTheme(k);
        el.classList.toggle('hl', on);
        if (on) focus.on.add(k);
      });
      lines.forEach((l, e) => l.classList.toggle('hl', linkOn(edges[e])));
      bundleEls.forEach((el, k) => el.classList.toggle('hl', bundles[k] === bundle));
      placeLabels();
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
      if (!isOverlay) keepAboveCard(n);
    }

    // In the sidebar the card covers the lower part of the map: move the view so the chosen article stays above it.
    function keepAboveCard(n) {
      const r = svg.getBoundingClientRect();
      if (!r.height) return;
      const covered = (card.getBoundingClientRect().top - r.top) / r.height; // share of the map still visible
      const bottom = view.y + view.h * Math.max(0.3, covered) - n.r - 24 * (view.w / w); // room for its label
      if (n.y <= bottom && n.y >= view.y + n.r) return;
      view.y += n.y - (view.y + view.h * Math.max(0.3, covered) * 0.5);
      applyView();
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
      const ls = view.w / w;
      svg.style.setProperty('--label-scale', String(ls));
      const hits = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
      const inView = (b) => b.x1 >= view.x && b.x2 <= view.x + view.w && b.y1 >= view.y && b.y2 <= view.y + view.h;
      const circles = nodes.map((n) => ({ x1: n.x - n.r, y1: n.y - n.r, x2: n.x + n.r, y2: n.y + n.r }));
      // Places a label at (x, y) inside a group at (ox, oy), sliding it sideways to stay inside the view;
      // returns its box in map coordinates.
      const put = (text, ox, oy, y, x = 0) => {
        text.setAttribute('x', x.toFixed(1));
        text.setAttribute('y', y.toFixed(1));
        let b = text.getBBox();
        const left = view.x + 2 - (ox + b.x);
        const right = view.x + view.w - 2 - (ox + b.x + b.width);
        const shift = left > 0 ? left : right < 0 ? Math.max(right, left) : 0;
        text.setAttribute('x', (x + shift).toFixed(1));
        b = text.getBBox();
        return { x1: ox + b.x - 2, y1: oy + b.y - 1, x2: ox + b.x + b.width + 2, y2: oy + b.y + b.height + 1 };
      };
      // Theme names always show, above their region or else below it; article labels make room for them.
      const placed = [];
      clusters.forEach((c, k) => {
        const text = themeLabels[k];
        let box;
        for (const y of [c.y - c.ry - 6 * ls, c.y + c.ry + 14 * ls]) {
          box = put(text, 0, 0, y, c.x);
          if (inView(box) && !placed.some((p) => hits(box, p))) break;
        }
        placed.push(box);
      });
      // While highlighting, only highlighted articles get labels: the hovered one, then the rest by connections.
      const keep = (i) => nodes[i].id === currentTitle || (focus && focus.lead === i);
      const turn = focus ? [...order].sort((a, b) => keep(b) - keep(a)).filter((i) => focus.on.has(i) || nodes[i].id === currentTitle) : order;
      if (focus) for (const el of nodeEls) el.querySelector('text').classList.add('crowded');
      for (const i of turn) {
        const text = nodeEls[i].querySelector('text');
        text.classList.remove('crowded');
        const n = nodes[i];
        const fontPx = 11 * ls;
        const free = (box) => inView(box) && !placed.some((p) => hits(box, p)) && !circles.some((c, k) => k !== i && hits(box, c));
        // Below the dot, or above it when that's taken.
        let box = null;
        for (const y of [n.r + fontPx + 2 * ls, -n.r - 4 * ls]) {
          box = put(text, n.x, n.y, y);
          if (free(box)) break;
          box = null;
        }
        if (keep(i) && !box) placed.push(put(text, n.x, n.y, n.r + fontPx + 2 * ls)); // the reader's or hovered article always keeps its label
        else if (box) placed.push(box);
        else {
          put(text, n.x, n.y, n.r + fontPx + 2 * ls);
          text.classList.add('crowded');
        }
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
      e.preventDefault(); // dragging moves the map, it doesn't select text
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
      if (selected != null) return;
      if (el) highlight(Number(el.dataset.i));
      else if (e.target.matches('.bundle')) highlight(null, bundles[Number(e.target.dataset.b)]);
    });
    svg.addEventListener('pointerout', (e) => {
      if ((e.target.closest('.node') || e.target.matches('.bundle')) && selected == null) highlight(null);
    });
    svg.addEventListener('click', (e) => {
      const el = e.target.closest('.node');
      if (el) select(Number(el.dataset.i));
      else if (e.target.closest('.cluster text')) toggleTheme(e.target.closest('.cluster').dataset.facet);
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
    // In the sidebar, Escape closes the article card before it closes the panel.
    else
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && selected != null) {
          e.stopPropagation();
          select(null);
        }
      });

    box.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.matches('.map-close')) close();
      else if (t.matches('.map-expand')) onExpand?.();
      else if (t.matches('.map-list')) {
        if (isOverlay) close();
        onList?.();
      }
      else if (t.matches('.card-close')) select(null);
      else if (t.matches('.open-article')) onOpenArticle(nodes[selected].id);
      else if (t.matches('.ask-article')) {
        onAsk(nodes[selected].id);
        if (isOverlay) close();
      } else if (t.matches('.legend-item')) toggleTheme(t.dataset.facet);
    });

    function toggleTheme(facet) {
      themeFilter = themeFilter === facet ? null : facet;
      box.querySelectorAll('.legend-item').forEach((b) => b.classList.toggle('active', b.dataset.facet === themeFilter));
      svg.querySelectorAll('.cluster').forEach((c) => c.classList.toggle('active', c.dataset.facet === themeFilter));
      select(null);
    }

    return close;
  }

  W.topicMap = { open, mount, layout };
})(globalThis);
