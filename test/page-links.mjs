// Approximates the sidebar's link data (signals, sections, context) from article HTML with regexes,
// for command-line tests. The extension reads the real DOM.
const strip = (h) => h.replace(/<sup[\s\S]*?<\/sup>/g, '').replace(/<[^>]+>/g, '').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim();

export async function pageLinks(lang, title) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=parse&prop=text&formatversion=2&format=json&origin=*&page=${encodeURIComponent(title)}`;
  const html = (await (await fetch(url)).json()).parse.text;
  // Navigation boxes as [start, end] ranges: elements whose class list has "navbox" (not "navbox-styles"),
  // matched to their closing tag, like el.closest('.navbox') in the extension.
  const navRanges = [];
  for (const m of html.matchAll(/<(div|table)\b[^>]*class="(?:[^"]*\s)?navbox(?:\s[^"]*)?"[^>]*>/g)) {
    if (navRanges.some(([a, b]) => m.index > a && m.index < b)) continue;
    const tag = new RegExp(`<${m[1]}\\b|</${m[1]}>`, 'g');
    tag.lastIndex = m.index + 1;
    let depth = 1;
    let end = html.length;
    for (let t; (t = tag.exec(html)); ) {
      depth += t[0][1] === '/' ? -1 : 1;
      if (!depth) {
        end = tag.lastIndex;
        break;
      }
    }
    navRanges.push([m.index, end]);
  }
  const inNavbox = (at) => navRanges.some(([a, b]) => at > a && at < b);
  const info = html.match(/<table class="infobox[\s\S]*?<\/table>/)?.index ?? -1;
  const infoEnd = info >= 0 ? info + html.slice(info).indexOf('</table>') : -1;
  const map = new Map();
  let section = 'Introduction';
  const re = /<h[234][^>]*>([\s\S]*?)<\/h[234]>|<a href="\/wiki\/([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (let m; (m = re.exec(html)); ) {
    if (m[1] !== undefined) {
      section = strip(m[1]);
      continue;
    }
    const target = decodeURIComponent(m[2]).replace(/_/g, ' ');
    if (/^[A-Za-z ]+:/.test(target) || target === title) continue;
    const at = m.index;
    const signals = [];
    if (inNavbox(at)) signals.push('navbox');
    if (info >= 0 && at > info && at < infoEnd) signals.push('infobox');
    const blockStart = Math.max(html.lastIndexOf('<p>', at), html.lastIndexOf('<li', at), html.lastIndexOf('<div role="note"', at));
    const block = html.slice(blockStart, html.indexOf('</', at + m[0].length) + 400);
    const text = strip(block).slice(0, 220);
    if (html.slice(blockStart, blockStart + 40).includes('role="note"') && /^Main articles?/i.test(text)) signals.push('main');
    const e = map.get(target) || { title: target, count: 0, context: '', sections: [], anchors: [], signals: [] };
    e.count++;
    e.context ||= signals.includes('navbox') ? 'Navigation box' : text;
    if (!signals.includes('navbox') && !e.sections.includes(section)) e.sections.push(section);
    for (const s of signals) if (!e.signals.includes(s)) e.signals.push(s);
    map.set(target, e);
  }
  return [...map.values()];
}
