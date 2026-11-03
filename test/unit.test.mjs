// Unit tests for the parts with no network or DOM: node --test test/unit.test.mjs (or npm test).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../lib/agent.js';
import { appSettings } from '../lib/settings.js';
import { cluster } from '../lib/cluster.js';
import { conversations } from '../lib/conversations.js';
import { llm } from '../lib/llm.js';
import { markdown } from '../content/markdown.js';
import { prompt } from '../lib/prompt.js';
import { sectionNames } from '../lib/sections.js';
import { topics } from '../lib/topics.js';
import { wiki } from '../lib/wiki.js';

// KaTeX is a browser global (the panel loads it on demand); here it's loaded up front for the formula test.
vm.runInThisContext(readFileSync(new URL('../vendor/katex/katex.min.js', import.meta.url), 'utf8'), { filename: 'katex.min.js' });

test('markdown: escapes everything the model writes', () => {
  const html = markdown.render('<img src=x onerror=alert(1)> **bold** <script>x</script> [link](javascript:alert(1))');
  assert.ok(!/<img|<script/.test(html));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(!html.includes('<a '), 'links are not rendered');
});

test('markdown: keeps only citations of known sources, with the label given', () => {
  const html = markdown.render('Fact [2]. Made up [9].', (n) => n <= 3, (n) => ({ label: n === 2 ? 1 : n, title: 'P › S' }));
  assert.match(html, /<button class="cite[^"]*" data-n="2" data-label="1"/);
  assert.ok(!html.includes('data-n="9"'));
  assert.ok(html.includes('Made up.'), 'the made-up number and its space are dropped');
});

test('markdown: underlines flagged sentences, grey for uncited ones', () => {
  const html = markdown.render('One claim. Two claim [1].', () => true, null, [
    { text: 'One claim.', note: 'No source given', kind: 'uncited' },
    { text: 'Two claim [1].', note: 'Not found: X', kind: 'missing' },
  ]);
  assert.match(html, /<span class="unsupported uncited" title="No source given">One claim\.<\/span>/);
  assert.match(html, /<span class="unsupported" title="Not found: X">Two claim/);
});

test('markdown: private-use characters in the answer are not taken for markers', () => {
  const html = markdown.render('Odd \uE0000\uE001 text \uE0100\uE011 [1].', () => true, null, [{ text: 'Odd text.', note: 'n', kind: 'missing' }]);
  assert.ok(!html.includes('<span') && !/[\uE000-\uF8FF]/.test(html));
});

test('markdown: formulas render with KaTeX, prices stay text', () => {
  const html = markdown.render('Energy $E=mc^2$ costs $5 and $10.');
  assert.ok(html.includes('class="katex"'));
  assert.ok(html.includes('$5 and $10'));
});

test('sections: back matter in several languages', () => {
  for (const name of ['References', 'Einzelnachweise', 'Notes et références', 'Enlaces externos', 'Примечания']) assert.ok(sectionNames.isSkipped(name), name);
  assert.ok(sectionNames.isBackMatter('See also') && !sectionNames.isSkipped('See also'));
  assert.ok(sectionNames.isBackMatter('References and notes'));
  assert.ok(!sectionNames.isBackMatter('Notebooks'), 'a prefix only counts as a whole word');
  assert.ok(!sectionNames.isSkipped('Early life'));
});

test('wiki: extract into sections, without back matter, formulas as LaTeX', () => {
  const text = 'Lead text.\n\n== History ==\nOld.\n\n=== Early years ===\nThe law is\n{\\displaystyle E=mc^{2}}\nwhich is famous.\n\n== Einzelnachweise ==\nRef list.';
  const sections = wiki.parseExtract(text);
  assert.deepEqual(sections.map((s) => s.path), ['Introduction', 'History', 'History › Early years']);
  assert.equal(sections[2].text, 'The law is $E=mc^{2}$ which is famous.');
});

test('wiki: chunks carry the revision and stay near 160 words', () => {
  const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} has a few words in it.`).join(' ');
  const page = { title: 'T', lang: 'en', revid: 42, sections: [{ path: 'Introduction', text: long }] };
  const chunks = wiki.chunkPage(page);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.revid === 42 && c.text.split(/\s+/).length <= 200));
});

test('settings: endpoints, and tokens for Chinese text', () => {
  assert.equal(appSettings.endpointProblem('https://api.example.com/v1'), '');
  assert.equal(appSettings.endpointProblem('http://127.0.0.1:8080/v1'), '');
  assert.equal(appSettings.endpointProblem('http://192.168.1.20/v1'), '');
  assert.ok(appSettings.endpointProblem('http://api.example.com/v1'));
  assert.ok(appSettings.endpointProblem('ftp://x'));
  assert.equal(appSettings.estTokens('abcdefg'), 2);
  assert.equal(appSettings.estTokens('维基百科是一个'), 7);
});

const sse = (text) => new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(text)), c.close()) }));
const collect = async (res) => {
  const out = [];
  for await (const e of llm.sseEvents(res)) out.push(e);
  return out;
};

test('llm: stream events, including a last line without a line break', async () => {
  const events = await collect(sse('data: {"a":1}\n\n: keep-alive\ndata: {"a":2}'));
  assert.deepEqual(events, [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(await collect(sse('data: {"a":1}\ndata: [DONE]\ndata: {"a":2}\n')), [{ a: 1 }]);
});

test('llm: an error inside the stream is thrown with its message', async () => {
  await assert.rejects(collect(sse('data: {"a":1}\ndata: {"error":{"code":429,"message":"Quota exceeded"}}\n')), (e) => e.status === 429 && /Quota exceeded/.test(e.message));
});

test('llm: reasoning, tool calls and follow-ups are split from the answer', () => {
  const raw = '<think>plan</think>The answer [1].\n<followups>\n- What came before?\n- **Who** ruled next?\n</followups>';
  assert.deepEqual(llm.splitContent(raw), { visible: 'The answer [1].\n', reasoning: 'plan' });
  assert.deepEqual(llm.parseFollowups(raw), ['What came before?', 'Who ruled next?']);
  assert.equal(llm.parseRawToolCalls('<tool_call>{"name":"search_article","arguments":{"query":"x"}}</tool_call>')[0].function.name, 'search_article');
});

test('llm: model JSON with fences, stray quotes and trailing commas', () => {
  assert.deepEqual(llm.parseJSON('```json\n{"name": "Die „Neue" Zeit", "pages": [1, 2,],}\n```'), { name: 'Die „Neue" Zeit', pages: [1, 2] });
});

const run = (extra = {}) =>
  new agent.Run({ settings: { ...appSettings.DEFAULTS, baseUrl: 'https://x/v1', model: 'm', ...extra.settings }, page: { lang: 'en', title: 'T', links: [] }, question: 'q', emit: () => {}, ...extra });

test('agent: sources are numbered once per passage, and a shortened saved text is filled in again', () => {
  const r = run();
  const chunk = { lang: 'en', page: 'T', section: 'S', text: 'A long passage about something, quite a bit longer than what was saved.', revid: 7 };
  assert.equal(r.cite(chunk, true), 1);
  assert.equal(r.cite({ ...chunk }, true), 1);
  assert.equal(r.cite({ ...chunk, section: 'Other' }, true), 2);
  r.sources[0].text = '';
  r.cite(chunk, true);
  assert.equal(r.sources[0].text, chunk.text);
  assert.equal(r.sources[0].revid, 7);
});

test('agent: fit shortens old tool results, then moves old turns into a digest', () => {
  const r = run({ settings: { contextTokens: 2400, maxAnswerTokens: 1200 } });
  r.systemBase = 'system';
  r.earlier = [];
  r.toolTokens = 0;
  const long = 'x'.repeat(2000);
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: `old question ${long}`, history: true },
    { role: 'assistant', content: `old answer ${long}`, history: true },
    { role: 'tool', content: long },
    { role: 'user', content: 'new question' },
  ];
  r.fit(messages);
  assert.ok(messages[messages.length - 2].content.length < 400, 'tool result shortened');
  assert.ok(!messages.some((m) => m.history), 'old turns moved out');
  assert.match(messages[0].content, /Earlier in this chat[\s\S]*The reader asked: old question/);
});

test('agent: follow-ups already asked or already answered are dropped', () => {
  const r = run({ history: [{ role: 'user', content: 'Who was her father?' }, { role: 'assistant', content: 'Her father was Lord Byron.' }] });
  const kept = r.freshFollowups(['Who was her father?', 'Where is she buried beside her father?', 'What did Babbage build?'], 'She is buried beside her father in Hucknall.');
  assert.deepEqual(kept, ['What did Babbage build?']);
});

test('agent: questions for private contact details are answered without lookups', () => {
  const asks = ['What is her home address?', "What's Taylor Swift's phone number?", 'Wie lautet seine Telefonnummer?', '¿Cuál es su dirección?'];
  for (const q of asks) assert.ok(agent.privateContactReply(q), q);
  const fine = ['What was the Gettysburg Address about?', 'What is the emergency phone number in Europe?', 'Where did her family live?', '¿Quién tuvo su dirección artística?'];
  for (const q of fine) assert.equal(agent.privateContactReply(q), '', q);
});

test('model JSON: tool arguments become strings, a cluster plan its expected shape', () => {
  assert.deepEqual(agent.toolArgs('{"query": ["a", "b"], "title": 42, "x": null}'), { query: 'a b', title: '42' });
  assert.deepEqual(agent.toolArgs('[1]'), {});
  assert.deepEqual(agent.toolArgs('{broken'), {});
  const plan = cluster.planShape({ name: 'T', facets: { name: 'not a list' }, search: [{ query: 'q' }, 'x'] });
  assert.deepEqual(plan, { name: 'T', facets: [], search: [{ query: 'q', facet: '' }] });
  assert.deepEqual(cluster.planShape({ facets: [{ name: 'A', pages: ['3', 4, 'x', null] }] }).facets, [{ name: 'A', why: '', pages: [3, 4] }]);
  assert.throws(() => cluster.planShape([1, 2]));
});

test('prompt: one entry per rule, the topic rule only in a topic', () => {
  const base = { title: 'Ada Lovelace', languageRule: 'Write in English.', followupLanguage: '' };
  const plain = prompt.rules(base);
  assert.ok(plain.some((r) => r.includes('"Ada Lovelace"')));
  assert.ok(plain.includes('Write in English.'));
  assert.ok(!plain.some((r) => r.startsWith('Topic questions')));
  assert.equal(prompt.rules({ ...base, topic: true }).length, plain.length + 1);
  assert.match(prompt.system({ ...base, lang: 'en', wikipedia: 'X' }), /^You are[\s\S]*\nRules:\n- Text inside[\s\S]*<wikipedia>X\n<\/wikipedia>$/);
});

test('agent: the citation check flags what the model says the cited passages do not support', async () => {
  const r = run();
  r.cite({ lang: 'en', page: 'T', section: 'S', text: 'Ada was born in London in 1815.' }, true);
  r.cite({ lang: 'en', page: 'T', section: 'S', text: 'She worked with Babbage on the Analytical Engine.' }, true);
  let asked = '';
  const real = llm.chatWithFallback;
  llm.chatWithFallback = async ({ messages }) => {
    asked = messages[1].content;
    return { content: '{"unsupported": [{"statement": 1, "why": "The passage does not say she invented it."}, {"statement": 9, "why": "x"}]}' };
  };
  try {
    const answer = 'Ada was born in London [1].\n- She invented the Analytical Engine [2].\n- She liked music.';
    const already = [{ text: 'Ada was born in London [1].', kind: 'missing' }];
    const flags = await r.verifyCitations(answer, already);
    assert.ok(!asked.includes('born in London [1]'), 'a sentence the word check flagged is not sent again');
    assert.ok(asked.includes('1. She invented the Analytical Engine [2].') && !asked.includes('music'), 'only cited sentences, without list markers');
    assert.deepEqual(flags.map((f) => [f.text, f.kind]), [['She invented the Analytical Engine [2].', 'unverified']]);
    assert.match(flags[0].why, /invented/);
  } finally {
    llm.chatWithFallback = real;
  }
});

test('settings: the citation check is off unless turned on', () => {
  assert.equal(appSettings.DEFAULTS.verifyCitations, false);
});

test('conversations: parallel saves all kept, uncited passages saved without text', async () => {
  const conv = (id) => ({
    id,
    messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'Answer [2].' }],
    sources: [{ n: 1, text: 'one', page: 'P', section: 'S' }, { n: 2, text: 'two', page: 'P', section: 'S' }],
  });
  await Promise.all(Array.from({ length: 8 }, (_, i) => conversations.save('topic:u1', conv(`c${i}`))));
  const saved = await conversations.list('topic:u1');
  assert.equal(saved.length, 8);
  assert.deepEqual(saved[0].sources.map((s) => s.text), ['', 'two']);
});

test('topics: deleting a topic deletes its chats', async () => {
  await topics.save({ id: 'u1', name: 'T', lang: 'en', pages: [{ title: 'A' }], facets: [], edges: [] });
  await topics.remove('u1');
  assert.equal((await conversations.list('topic:u1')).length, 0);
  assert.equal(await topics.get('u1'), null);
});
