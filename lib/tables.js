// Tables and infoboxes from an article's HTML, as text lines the search index can use.
// The plain-text extract leaves them out, yet list, sports and science pages keep most of their facts there.
// Runs in the service worker, which has no DOMParser, so this reads the parser's (regular) HTML with patterns.
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});

  const MAX_ROWS = 400; // per table
  const MAX_LINES = 3000; // per article

  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', minus: '−', ndash: '–', mdash: '—', times: '×', deg: '°', thinsp: ' ', hairsp: ' ', ensp: ' ', emsp: ' ', middot: '·', plusmn: '±' };

  function decode(s) {
    return s
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m)
      .replace(/[­​⁠]/g, '');
  }

  // A cell's visible text: without citation marks, hidden sort keys and markup.
  function text(html) {
    return decode(
      html
        .replace(/<sup\b[^>]*\breference\b[\s\S]*?<\/sup>/gi, '')
        .replace(/<div\b[^>]*class="(?:[^"]*\s)?navbar(?:\s[^"]*)?"[^>]*>[\s\S]*?<\/div>/gi, '') // "v · t · e" template links
        .replace(/<span\b[^>]*(display:\s*none|\bsortkey\b)[^>]*>[^<]*<\/span>/gi, '')
        .replace(/<(br|\/p|\/li|\/div|\/dd|\/dt|\/caption)\b[^>]*>/gi, ' ')
        .replace(/<[^>]+>/g, '')
    )
      .replace(/\s+/g, ' ')
      .replace(/(\p{L})- (\p{Ll})/gu, '$1-$2') // "Electro-<br>negativity"
      .trim();
  }

  // The end of the table that opens at `start`, counting nested tables.
  function tableEnd(html, start) {
    const re = /<table\b|<\/table>/gi;
    re.lastIndex = start + 1;
    let depth = 1;
    for (let m; (m = re.exec(html)); ) {
      depth += m[0][1] === '/' ? -1 : 1;
      if (!depth) return re.lastIndex;
    }
    return html.length;
  }

  // Rows as arrays of {text, th, id}, with colspan and rowspan spread out so columns line up.
  function grid(tableHtml) {
    let inner = tableHtml.replace(/^<table\b[^>]*>/i, '').replace(/<\/table>\s*$/i, '');
    // Tables inside cells become plain text of their cell.
    for (let prev; prev !== inner; ) {
      prev = inner;
      inner = inner.replace(/<table\b[^>]*>((?:(?!<table\b)[\s\S])*?)<\/table>/gi, (_, body) => ` ${text(body)} `);
    }
    const caption = text(inner.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i)?.[1] || '');
    const rows = [];
    const carry = []; // column → {cell, left} for rowspans
    let id = 0;
    for (const rowHtml of inner.split(/<tr\b[^>]*>/i).slice(1)) {
      const row = [];
      let col = 0;
      const fillCarried = () => {
        while (carry[col]?.left > 0) {
          row.push(carry[col].cell);
          carry[col].left--;
          col++;
        }
      };
      for (const m of rowHtml.matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
        fillCarried();
        const span = (name) => Math.min(Number(m[2].match(new RegExp(`${name}="?(\\d+)`, 'i'))?.[1]) || 1, 50);
        const cell = { text: text(m[3]), th: m[1].toLowerCase() === 'th', id: id++ };
        const rowspan = span('rowspan');
        for (let i = 0; i < span('colspan'); i++, col++) {
          row.push(cell);
          if (rowspan > 1) carry[col] = { cell, left: rowspan - 1 };
        }
      }
      fillCarried();
      if (row.length) rows.push(row);
    }
    return { caption, rows };
  }

  // Each cell once, however many columns it spans.
  const distinct = (row) => row.filter((c, i) => i === 0 || c.id !== row[i - 1].id);

  function infoboxLines(rows) {
    return rows
      .map((row) => {
        const cells = distinct(row).filter((c) => c.text);
        if (cells.length > 1 && cells[0].th) return `${cells[0].text}: ${cells.slice(1).map((c) => c.text).join('; ')}`;
        return cells.map((c) => c.text).join(' · ');
      })
      .filter(Boolean);
  }

  // The column names once ("Z | Element | Density (g/cm3)") and each row as values in that order:
  // compact enough that the model can read a whole 100-row table at once.
  function tableLines(rows, caption) {
    const width = Math.max(...rows.map((r) => r.length));
    let i = 0;
    const names = [];
    for (; i < rows.length && rows[i].every((c) => c.th); i++) {
      const cells = distinct(rows[i]);
      // A heading row across the whole table names it.
      if (cells.length === 1 && width > 1) {
        caption ||= cells[0].text;
        continue;
      }
      rows[i].forEach((c, col) => {
        if (c.text && !(names[col] || '').includes(c.text)) names[col] = names[col] ? `${names[col]} ${c.text}` : c.text;
      });
    }
    const lines = [];
    for (const row of rows.slice(i, i + MAX_ROWS)) {
      const cells = distinct(row);
      if (cells.length === 1 || row.every((c) => c.th)) {
        // Sub-headings ("Period 2") and notes across the table.
        const t = cells.map((c) => c.text).filter(Boolean).join(' · ');
        if (t) lines.push(t);
        continue;
      }
      // A cell spanning several columns is written once; the columns it covers stay empty.
      const values = row.map((c, col) => (col && row[col - 1].id === c.id ? '' : c.text));
      if (values.some(Boolean)) lines.push(values.join(' | '));
    }
    const columns = names.length ? Array.from({ length: width }, (_, col) => names[col] || '').join(' | ') : '';
    return { caption, columns, lines };
  }

  // [{path, caption, columns, infobox, lines}] for every data table and infobox, under the section it appears in
  // (paths as in the extract: "History › Early years"; "Introduction" before the first heading).
  function extract(html) {
    html = html.replace(/<style\b[\s\S]*?<\/style>|<script\b[\s\S]*?<\/script>|<!--[\s\S]*?-->/gi, '');
    const out = [];
    const stack = [];
    let total = 0;
    const re = /<h([2-6])\b[^>]*>([\s\S]*?)<\/h\1>|<table\b([^>]*)>/gi;
    for (let m; (m = re.exec(html)); ) {
      if (m[1]) {
        const level = Number(m[1]);
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        stack.push({ level, name: text(m[2]) });
        continue;
      }
      const start = m.index;
      const end = tableEnd(html, start);
      re.lastIndex = end; // headings and tables inside it belong to it
      const cls = m[3].match(/class="([^"]*)"/i)?.[1] || '';
      const infobox = /\binfobox\b/.test(cls);
      if (!infobox && !/\bwikitable\b/.test(cls)) continue;
      const { caption, rows } = grid(html.slice(start, end));
      if (!rows.length) continue;
      const t = infobox ? { caption: caption || 'Infobox', columns: '', lines: infoboxLines(rows) } : tableLines(rows, caption);
      const lines = t.lines.slice(0, MAX_LINES - total);
      if (!lines.length) continue;
      total += lines.length;
      out.push({ path: stack.length ? stack.map((s) => s.name).join(' › ') : 'Introduction', caption: t.caption, columns: t.columns, infobox, lines });
      if (total >= MAX_LINES) break;
    }
    return out;
  }

  W.tables = { extract, text };
})(globalThis);
