// KaTeX's fonts, registered on the page with the FontFace API. Chrome ignores @font-face inside the panel's shadow
// root, and the copy in katex.min.css can't be used on the page either: its relative font URLs resolve against the
// extension's fixed id, which pages may not load (use_dynamic_url). Fonts the content script registers itself load.
// One entry per @font-face rule in vendor/katex/katex.min.css; a unit test keeps the two in step.
const FILES = [
  'AMS-Regular', 'Caligraphic-Bold', 'Caligraphic-Regular', 'Fraktur-Bold', 'Fraktur-Regular', 'Main-Bold',
  'Main-BoldItalic', 'Main-Italic', 'Main-Regular', 'Math-BoldItalic', 'Math-Italic', 'SansSerif-Bold',
  'SansSerif-Italic', 'SansSerif-Regular', 'Script-Regular', 'Size1-Regular', 'Size2-Regular', 'Size3-Regular',
  'Size4-Regular', 'Typewriter-Regular',
];

/** @returns {{ family: string, style: string, weight: string, file: string }[]} */
function faces() {
  return FILES.map((name) => {
    const [family, variant] = name.split('-');
    return {
      family: `KaTeX_${family}`,
      style: /Italic/.test(variant) ? 'italic' : 'normal',
      weight: /Bold/.test(variant) ? '700' : '400',
      file: `KaTeX_${name}.woff2`,
    };
  });
}

// Adds the fonts to the page; each one loads the first time a formula uses it.
/** @param {(path: string) => string} urlOf */
function register(urlOf) {
  for (const f of faces()) {
    const face = new FontFace(f.family, `url(${urlOf(`vendor/katex/fonts/${f.file}`)}) format("woff2")`, {
      style: f.style,
      weight: f.weight,
      display: 'block',
    });
    document.fonts.add(face);
  }
}

export const katexFonts = { faces, register };
