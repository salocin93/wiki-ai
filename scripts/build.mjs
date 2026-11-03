// Builds the extension into dist/wiki-ai/, the folder to load in Chrome ("Load unpacked").
//   node scripts/build.mjs            development build, with source maps
//   node scripts/build.mjs --watch    the same, rebuilt on every save (reload the extension in Chrome after)
//   node scripts/build.mjs --release --out <dir>   no source maps, into <dir>; what scripts/package.sh zips
// Each entry (service worker, content script, settings page) is bundled with its imports into one classic
// script, not minified, so the Chrome Web Store review reads the same code. The test harness is bundled to
// dist/harness.js.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, watch as watchFiles } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(root, 'dist/wiki-ai');
const watching = args.includes('--watch');
const release = args.includes('--release');

// Copied as they are: the manifest, pages, styles, icons and KaTeX (loaded on demand).
const STATIC = ['manifest.json', 'options/options.html', 'options/options.css', 'content/sidebar.css', 'icons', 'vendor'];
const LEFT_OUT = new Set(['icons/logo-dark.svg']); // only the README uses it

function copyStatic() {
  for (const p of STATIC) {
    cpSync(join(root, p), join(out, p), {
      recursive: true,
      filter: (src) => !src.endsWith('.DS_Store') && !LEFT_OUT.has(src.slice(root.length + 1)),
    });
  }
}

const shared = {
  bundle: true,
  format: 'iife',
  target: 'chrome116', // manifest.json's minimum_chrome_version
  sourcemap: release ? false : 'inline',
  logLevel: release ? 'warning' : 'info',
};
const builds = [
  { ...shared, entryPoints: { 'background/background': 'background/background.js', 'content/content': 'content/content.js', 'options/options': 'options/options.js' }, outdir: out },
];
if (!release) builds.push({ ...shared, entryPoints: { harness: 'test/harness.js' }, outdir: join(root, 'dist') });

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyStatic();

if (watching) {
  for (const options of builds) await (await esbuild.context({ ...options, absWorkingDir: root })).watch();
  for (const p of STATIC) {
    watchFiles(join(root, p), { recursive: true }, () => {
      copyStatic();
      console.log(`copied ${p}`);
    });
  }
  console.log(`Watching. Load ${out} in Chrome and reload the extension after a change.`);
} else {
  await Promise.all(builds.map((options) => esbuild.build({ ...options, absWorkingDir: root })));
}
