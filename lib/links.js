// How central a linked article is to the page it's linked from, based on where and how often it's linked.
// Used to recommend what to read next, to build topic clusters, and to break ties in link search.
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});

  // Words that don't identify a subject, so they don't tie a navigation box to the page.
  const GENERIC = new Set(
    'house of the and in on at for list history kingdom family royal dynasty war battle empire state county duchy city university river church people language culture'.split(' ')
  );
  const DATE_LIKE = /^(\d{1,4}s?( BC| AD)?|\d{1,2}(st|nd|rd|th) century( BC)?|(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2})$/i;

  function distinctiveWords(title) {
    return title
      .replace(/\s*\(.*\)$/, '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !GENERIC.has(w));
  }

  // A navigation box about this page's own subject ("House of Oldenburg"), not a sibling list ("Royal houses of Sweden").
  function isOwnNavbox(box, pageTitle) {
    const b = box.toLowerCase();
    return distinctiveWords(pageTitle).some((w) => b.includes(w));
  }

  function importance(l, pageTitle, focusSection) {
    if (DATE_LIKE.test(l.title) || /^List of /i.test(l.title)) return -5;
    const s = l.signals || [];
    const inProse = (l.sections || []).length > 0;
    let score = Math.min(l.count || 0, 5);
    if (s.includes('main')) score += 4;
    if (s.includes('infobox')) score += 2;
    if (s.includes('seealso')) score += 2; // editors picked it as related reading
    if (l.sections?.includes('Introduction')) score += 3;
    if (s.includes('navbox')) {
      const boxes = l.navboxes || [];
      score += !boxes.length ? 1 : boxes.some((b) => isOwnNavbox(b, pageTitle)) ? 3 : 0.5;
      if (!inProse && !s.includes('infobox')) score -= 1; // only listed in a box, never mentioned in the text
    }
    if (focusSection && focusSection !== 'Introduction' && l.sections?.includes(focusSection)) score += 3;
    return score;
  }

  function rank(links, pageTitle, { focusSection, exclude } = {}) {
    return links
      .filter((l) => !exclude?.has(l.title))
      .map((l) => ({ link: l, score: importance(l, pageTitle, focusSection) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  // Plain-language reasons, so the model can explain why an article is worth reading.
  function reasons(l, pageTitle) {
    const s = l.signals || [];
    const out = [];
    if (l.sections?.includes('Introduction')) out.push('linked in the introduction');
    if (s.includes('main')) out.push('main article of a section');
    if (s.includes('infobox')) out.push('in the fact box');
    if (s.includes('seealso')) out.push('listed under "See also"');
    if ((l.navboxes || []).some((b) => isOwnNavbox(b, pageTitle))) out.push(`listed in the "${l.navboxes.find((b) => isOwnNavbox(b, pageTitle))}" navigation box`);
    if ((l.count || 1) > 2) out.push(`linked ${l.count} times`);
    const other = (l.sections || []).filter((x) => x !== 'Introduction');
    if (other.length) out.push(`mentioned in ${other.map((x) => `"${x}"`).join(', ')}`);
    return out.join('; ');
  }

  W.links = { importance, rank, reasons, isOwnNavbox };
})(globalThis);
