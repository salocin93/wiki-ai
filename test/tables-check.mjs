// Checks lib/tables.js on hand-written article HTML: node test/tables-check.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

vm.runInThisContext(readFileSync(new URL('../lib/tables.js', import.meta.url), 'utf8'), { filename: 'tables.js' });
const T = globalThis.WikiAI.tables;

const html = `
<table class="infobox vcard"><tbody>
<tr><th colspan="2" class="infobox-above">Ada Lovelace</th></tr>
<tr><th scope="row">Born</th><td>10 December 1815<sup class="reference"><a href="#n1">[1]</a></sup></td></tr>
<tr><th scope="row">Spouse</th><td>William King<br>(m. 1835)</td></tr>
</tbody></table>
<p>Lead text.</p>
<div class="mw-heading mw-heading2"><h2 id="List">List</h2></div>
<table class="wikitable sortable"><tbody>
<tr><th colspan="3"><div class="navbar plainlinks"><ul><li>v</li><li>t</li><li>e</li></ul></div><div class="navbar-ct-mini">Heavy metals</div></th></tr>
<tr><th rowspan="2">Element</th><th colspan="2">Properties</th></tr>
<tr><th>Density<br>(g/cm<sup>3</sup>)</th><th>Phase</th></tr>
<tr><td>Osmium</td><td><span data-sort-value="7001" style="display:none">7001</span>22.59</td><td rowspan="2">solid</td></tr>
<tr><td>Iridium</td><td>22.56&nbsp;</td></tr>
<tr><td colspan="3">Values at room temperature</td></tr>
<tr><td>Mercury</td><td><table><tr><td>13.53</td></tr></table></td><td>liquid</td></tr>
</tbody></table>
<div class="mw-heading mw-heading3"><h3 id="Notes">Notes</h3></div>
<table class="navbox"><tr><td>Not data</td></tr></table>
<table class="wikitable"><caption>Discoveries</caption><tr><td>1803</td><td>Osmium</td></tr></table>
`;

const out = T.extract(html);
assert.equal(out.length, 3, 'infobox and two data tables, no navbox');

const [infobox, metals, discoveries] = out;
assert.equal(infobox.path, 'Introduction');
assert.equal(infobox.infobox, true);
assert.deepEqual(infobox.lines, ['Ada Lovelace', 'Born: 10 December 1815', 'Spouse: William King (m. 1835)']);

assert.equal(metals.path, 'List');
assert.equal(metals.caption, 'Heavy metals', 'a heading row across the table names it, without the v·t·e links');
assert.equal(metals.columns, 'Element | Properties Density (g/cm3) | Properties Phase');
assert.deepEqual(metals.lines, [
  'Osmium | 22.59 | solid',
  'Iridium | 22.56 | solid', // rowspan carried down
  'Values at room temperature',
  'Mercury | 13.53 | liquid', // nested table flattened into its cell
]);

assert.equal(discoveries.path, 'List › Notes');
assert.equal(discoveries.caption, 'Discoveries');
assert.equal(discoveries.columns, '', 'no header row, no column names');
assert.deepEqual(discoveries.lines, ['1803 | Osmium']);

console.log('tables: all checks passed');
