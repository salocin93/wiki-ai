// Unit tests for the parts with no network or DOM: node --test test/unit.test.mjs (or npm test).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../lib/agent.js';
import { appSettings } from '../lib/settings.js';
import { cluster } from '../lib/cluster.js';
import { conversations } from '../lib/conversations.js';
import { grounding } from '../lib/grounding.js';
import { llm } from '../lib/llm.js';
import { answerLinks } from '../content/answerlinks.js';
import { markdown } from '../content/markdown.js';
import { prompt } from '../lib/prompt.js';
import { sectionNames } from '../lib/sections.js';
import { textUtil } from '../lib/text.js';
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
  assert.deepEqual(plan, { name: 'T', kind: 'mixed', facets: [], search: [{ query: 'q', facet: '' }] });
  assert.equal(cluster.planShape({ kind: 'events' }).kind, 'events');
  assert.equal(cluster.planShape({ kind: 'stuff' }).kind, 'mixed', 'an unknown kind counts as mixed');
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

test('agent: the citation check sends every cited sentence and returns the ones the model rejects', async () => {
  const r = run();
  r.cite({ lang: 'en', page: 'T', section: 'S', text: 'Ada was born in London in 1815.' }, true);
  r.cite({ lang: 'en', page: 'T', section: 'S', text: 'She worked with Babbage on the Analytical Engine.' }, true);
  let asked = '';
  const real = llm.chatWithFallback;
  llm.chatWithFallback = async ({ messages }) => {
    asked = messages[1].content;
    return { content: '{"unsupported": [{"statement": 2, "why": "The passage does not say she invented it."}, {"statement": 9, "why": "x"}]}' };
  };
  try {
    const rejected = await r.verifyCitations('Ada was born in London [1].\n- She invented the Analytical Engine [2].\n- She liked music.');
    assert.ok(asked.includes('1. Ada was born in London [1].') && asked.includes('2. She invented the Analytical Engine [2].'));
    assert.ok(!asked.includes('music'), 'sentences without a citation are not sent');
    assert.deepEqual(rejected.map((x) => x.text), ['She invented the Analytical Engine [2].']);
    assert.match(rejected[0].why, /invented/);
  } finally {
    llm.chatWithFallback = real;
  }
});

test('agent: with the citation check on, the model decides for cited sentences, the word check for the rest', async () => {
  const answer = 'Ada was born in Paris [1]. She once met Charles Dickens.';
  const make = (verifyCitations) => {
    const r = run({ settings: { verifyCitations } });
    r.current = { page: { title: 'T' } };
    r.trace = { notes: [] };
    r.checkMs = 0;
    r.cite({ lang: 'en', page: 'T', section: 'S', text: 'Ada was born in London in 1815.' }, true);
    return r;
  };
  const real = llm.chatWithFallback;
  llm.chatWithFallback = async () => ({ content: '{"unsupported": []}' }); // the model finds the cited sentence fine
  try {
    const off = await make(false).unbacked(answer, []);
    assert.deepEqual(off.map((x) => x.text).sort(), ['Ada was born in Paris [1].', 'She once met Charles Dickens.'].sort(), 'word check alone: both');
    const on = await make(true).unbacked(answer, []);
    assert.deepEqual(on.map((x) => x.text), ['She once met Charles Dickens.'], 'the model clears the cited sentence; the uncited one still fails');
  } finally {
    llm.chatWithFallback = real;
  }
});

test('grounding: sentences are left out cleanly, empty list items too', () => {
  const answer = 'Intro sentence [1]. Wrong claim [2].\n\n- Good item [1].\n- Bad item [3].\n- Another good one [2].';
  assert.equal(
    grounding.withoutSentences(answer, ['Wrong claim [2].', 'Bad item [3].']),
    'Intro sentence [1].\n\n- Good item [1].\n- Another good one [2].'
  );
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

test('topics: a closed topic stays closed on its articles until opened again', async () => {
  await topics.save({ id: 'u2', name: 'T', lang: 'en', seed: 'A', pages: [{ title: 'A' }], facets: [], edges: [] });
  await topics.setActive('u2');
  assert.equal((await topics.forPage('en', 'A'))?.id, 'u2');
  await topics.setActive(null, 'u2');
  assert.equal(await topics.forPage('en', 'A'), null, 'closing it hides it on its own article');
  await topics.setActive('u2');
  assert.equal((await topics.forPage('en', 'A'))?.id, 'u2', 'opening it again brings it back');
  await topics.remove('u2');
});

test('cache: stats count the cached data itself, and drop to zero when cleared', async () => {
  const { cache } = await import('../lib/cache.js');
  await cache.clear();
  await cache.set('t:a', { text: 'x'.repeat(1000) });
  await cache.set('t:b', { text: 'é'.repeat(500) }); // two bytes each in UTF-8
  const s = await cache.stats();
  assert.equal(s.entries, 2);
  assert.ok(s.bytes > 2000 && s.bytes < 2100, String(s.bytes));
  await cache.clear();
  assert.deepEqual(await cache.stats(), { entries: 0, bytes: 0 });
});

test('types: priority order, dated items as events, a query that walks up from the item', async () => {
  const { articleTypes } = await import('../lib/types.js');
  assert.equal(articleTypes.pick(['group', 'place']), 'place', 'Paris is a settlement before a public body');
  assert.equal(articleTypes.pick(['concept', 'dated']), 'event', 'an earthquake has a date, photosynthesis has not');
  assert.equal(articleTypes.pick(['concept']), 'concept');
  assert.equal(articleTypes.pick([]), 'other');
  const q = articleTypes.sparql('Q7259');
  assert.ok(q.includes('wd:Q7259 wdt:P31') && q.includes('gearing "forward"'));
  assert.equal(await articleTypes.articleType('not an id'), 'other', 'no request for a malformed id');
});

test('llm: a JSON reply cut off goes to the fallback model, other replies are kept', async () => {
  const realFetch = globalThis.fetch;
  const realLog = [console.info, console.warn];
  console.info = console.warn = () => {};
  const line = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const part = line({ choices: [{ delta: { content: '{"a":' } }] });
  const whole = line({ choices: [{ delta: { content: '{"a":1}' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
  const models = [];
  let replies = [];
  globalThis.fetch = async (_url, { body }) => {
    models.push(JSON.parse(body).model);
    return new Response(replies.shift(), { status: 200 });
  };
  const settings = { ...appSettings.DEFAULTS, apiKey: 'k', model: 'main', fallbackModel: 'other' };
  const ask = (o = {}) => llm.chatWithFallback({ settings, messages: [], json: true, ...o });
  try {
    replies = [part, whole];
    assert.equal((await ask()).content, '{"a":1}', 'the stream ended early');
    assert.deepEqual(models, ['main', 'other']);

    models.length = 0;
    replies = [line({ choices: [{ delta: { content: '{"a":' }, finish_reason: 'length' }] }), whole];
    assert.equal((await ask()).content, '{"a":1}', 'the token limit ran out');
    assert.deepEqual(models, ['main', 'other']);

    models.length = 0;
    replies = [part, part];
    await assert.rejects(ask(), /cut off/, 'no third request');
    assert.deepEqual(models, ['main', 'other']);

    models.length = 0;
    replies = [part, whole];
    assert.equal((await ask({ json: false })).content, '{"a":1}', 'a cut-off answer goes to the fallback too');
    assert.deepEqual(models, ['main', 'other']);

    models.length = 0;
    replies = [line({ choices: [{ delta: { content: 'It went to Belgium [1] and to France [29' } }] })];
    const alone = await llm.chatWithFallback({ settings: { ...settings, fallbackModel: '' }, messages: [] });
    assert.equal(alone.content, 'It went to Belgium [1] and to France', 'nowhere to switch to: kept, without the half citation');
    assert.equal(alone.cutOff, true);
    assert.deepEqual(models, ['main']);

    models.length = 0;
    replies = [line({ choices: [{ delta: { content: '{"a":1}' } }] }) + 'data: [DONE]\n\n'];
    assert.equal((await ask()).content, '{"a":1}', 'a server that ends without a finish reason');
  } finally {
    globalThis.fetch = realFetch;
    [console.info, console.warn] = realLog;
  }
});

test('phrases: a question built on the fact the article names most', async () => {
  const { phraseBook } = await import('../content/phrases.js');
  const { articleTypes } = await import('../lib/types.js');
  for (const [code, book] of Object.entries(phraseBook.TYPED)) {
    assert.deepEqual(Object.keys(book.facts), articleTypes.FACT_PROPERTIES, `${code} has a question for each fact`);
  }
  const q = (facts, text, o = {}) => phraseBook.factQuestion('en', { title: 'Ada Lovelace', facts, text, ...o });
  const fact = (property, title) => ({ property, title });
  assert.equal(q([], 'Text'), '');
  assert.equal(q([fact('P108', 'University of Cambridge')], 'University of Cambridge'), '', 'no question for this kind of fact');
  assert.equal(q([fact('P737', 'University of Cambridge')], 'Nothing about it.'), '', 'a fact the text does not name');
  assert.equal(q([fact('P737', 'Charles Babbage')], 'She met Charles Babbage.'), 'How did Charles Babbage influence Ada Lovelace?');
  assert.equal(q([fact('P737', 'Babbage')], 'Babbages and more'), '', 'whole names only');
  assert.equal(q([fact('P22', 'Lord Byron'), fact('P737', 'Charles Babbage')], 'Charles Babbage. Lord Byron. Lord Byron.'), 'How did Lord Byron shape the life of Ada Lovelace?');
  assert.equal(q([fact('P22', 'Lord Byron'), fact('P737', 'Charles Babbage')], 'Lord Byron. Charles Babbage.'), 'How did Charles Babbage influence Ada Lovelace?', 'a tie goes to the better question');
  assert.equal(q([fact('P737', 'Mercury (planet)')], 'Near Mercury.'), 'How did Mercury influence Ada Lovelace?', 'brackets left out');
  assert.equal(q([fact('P737', 'George Byron')], 'Her father, Lord Byron.', { links: [{ title: 'George Byron', anchors: ['Lord Byron'] }] }), 'How did George Byron influence Ada Lovelace?', 'the name the article links it by');
  assert.equal(
    phraseBook.factQuestion('en', { title: 'I, Robot (film)', facts: [fact('P179', 'I, Robot')], text: 'I, Robot' }),
    'How does “I, Robot (film)” fit into “I, Robot”?',
    'titles that differ only by their brackets keep them'
  );
  assert.equal(q([fact('P737', 'Ada Lovelace')], 'Ada Lovelace'), '', 'not about itself');
  assert.match(phraseBook.factQuestion('de', { title: 'X', facts: [fact('P161', 'Yvonne')], text: 'Yvonne' }), /^Welche Rolle spielt Yvonne in „X“/);
  assert.equal(phraseBook.factQuestion('en', { title: 'Skydance', facts: [fact('P112', 'David Ellison')], text: 'David Ellison' }), 'What was the role of David Ellison in “Skydance”?', 'worded so it does not assume a founding');

  const starter = (o) => phraseBook.starterQuestions('en', { title: 'X', sections: ['Legacy'], reading: '', links: [], disambiguation: false, fact: 'A fact question?', ...o });
  assert.deepEqual(starter({ type: 'person' }), ['What is X best known for?', 'A fact question?', 'Summarize “X” in a few bullet points'], 'second, in place of the second typed question');
  assert.deepEqual(starter({ type: 'other', reading: 'Life' }), ['Summarize “X” in a few bullet points', 'A fact question?', 'Explain the section “Life”']);
  assert.deepEqual(starter({ type: 'other' }), ['Summarize “X” in a few bullet points', 'A fact question?', 'Which linked articles should I read next, and why?']);
  assert.deepEqual(starter({ type: 'person', fact: '' }), ['What is X best known for?', 'What is the legacy of X?', 'Summarize “X” in a few bullet points'], 'nothing changes without one');
  assert.equal(starter({ sections: [] }).includes('A fact question?'), false, 'stubs stay as they are');
  assert.equal(starter({ disambiguation: true }).includes('A fact question?'), false);
});

test('types: facts ask for this Wikipedia\'s titles, and take no bad input', async () => {
  const { articleTypes } = await import('../lib/types.js');
  const q = articleTypes.factsSparql('Q7259', 'de');
  assert.ok(q.includes('wd:Q7259 ?claim') && q.includes('<https://de.wikipedia.org/>') && q.includes('wdt:P161') && q.includes('DeprecatedRank'));
  assert.deepEqual(await articleTypes.articleFacts('not an id', 'en'), [], 'no request for a malformed id');
  assert.deepEqual(await articleTypes.articleFacts('Q1', 'en.evil/'), [], 'no request for a malformed language');
});

test('cluster: a link is strong when the article names the other one in its introduction', () => {
  const intros = new Map([
    ['A', 'A led to the july crisis (1914) and to Mercury.'],
    ['B', 'B is about Lifestyles.'],
  ]);
  const edges = [['A', 'July Crisis'], ['A', 'Mercury (planet)'], ['A', 'B'], ['B', 'Lifestyle'], ['C', 'A']];
  assert.deepEqual(cluster.markStrongLinks(edges, intros), [
    ['A', 'July Crisis', 1],
    ['A', 'Mercury (planet)', 1],
    ['A', 'B'],
    ['B', 'Lifestyle'],
    ['C', 'A'],
  ]);
});

test('agent: the links with something to say survive the cut in a topic article\'s list', () => {
  const r = run();
  const weak = Array.from({ length: 20 }, (_, i) => ['A', `W${i}`]);
  r.topic = { pages: [{ title: 'A' }], edges: [...weak, ['A', 'Strong', 1]] };
  r.corpus = { byPage: new Map() };
  const list = r.connections('A');
  assert.ok(list.split('\n')[1].includes('A → Strong'), list);
  assert.equal(list.split('\n').length, 15, 'the list stays at 14 links');
});

test('agent: a rewrite that comes back empty or cut off keeps the draft, without its unbacked sentences', async () => {
  const draft = 'Ada was born in 1815 [1]. She visited Paris in 1999 [1].';
  const raw = `${draft}\n<followups>\n- One about Babbage?\n- Two about Byron?\n- Three about engines?\n</followups>`;
  const passage = { lang: 'en', page: 'T', section: 'Introduction', text: 'Ada was born in 1815.' };
  const realChat = llm.chat;
  const realPage = wiki.getIndexedPage;
  wiki.getIndexedPage = async () => ({ page: { title: 'T' }, chunks: [passage], index: { search: () => [] } });
  const answerWith = async (rewrite) => {
    const replies = [{ content: draft, raw }, rewrite];
    let calls = 0;
    llm.chat = async () => ({ reasoning: '', raw: '', toolCalls: [], model: 'm', ...replies[calls++] });
    const r = run({ settings: { maxSteps: 6, fallbackModel: '' } });
    r.emit = () => {};
    r.page.visibleSection = null;
    const answer = await r.run();
    return { answer, calls, followups: r.followups };
  };
  try {
    for (const rewrite of [{ content: '' }, { content: 'Ada was born', cutOff: true }]) {
      const { answer, calls, followups } = await answerWith(rewrite);
      assert.equal(answer, 'Ada was born in 1815 [1].');
      assert.equal(calls, 2, 'no third request');
      assert.equal(followups.length, 3, "the draft's follow-ups");
    }
    const whole = await answerWith({ content: 'Ada, born in 1815 [1].', raw: '<followups>\n- A one?\n- A two?\n</followups>' });
    assert.equal(whole.answer, 'Ada, born in 1815 [1].', 'a finished rewrite is used');
  } finally {
    llm.chat = realChat;
    wiki.getIndexedPage = realPage;
  }
});

// The follow-up questions need an extra request when the answer brings fewer than two. It must not hold the answer back.
async function withLateFollowups(fn, { raw = 'Ada was born in 1815 [1].', suggest = '- First one?\n- Second one?\n- Third one?' } = {}) {
  const passage = { lang: 'en', page: 'T', section: 'Introduction', text: 'Ada was born in 1815.' };
  const realChat = llm.chat;
  const realPage = wiki.getIndexedPage;
  wiki.getIndexedPage = async () => ({ page: { title: 'T' }, chunks: [passage], index: { search: () => [] } });
  let release;
  const suggestGate = new Promise((resolve) => (release = resolve));
  const asked = { answer: 0, suggest: 0 };
  llm.chat = async ({ messages }) => {
    if (/suggest follow-up questions/.test(messages[0].content)) {
      asked.suggest++;
      await suggestGate;
      return { content: suggest, toolCalls: [], model: 'm' };
    }
    asked.answer++;
    return { content: raw.replace(/<followups>[\s\S]*/, '').trim(), raw, reasoning: '', toolCalls: [], model: 'm' };
  };
  const events = [];
  const ctrl = new AbortController();
  const r = run({ settings: { maxSteps: 6, fallbackModel: '' }, signal: ctrl.signal });
  r.emit = (e) => events.push(e);
  r.page.visibleSection = null;
  const doneEmitted = () => new Promise((resolve) => { const t = setInterval(() => events.some((e) => e.type === 'done') && (clearInterval(t), resolve(undefined)), 2); });
  try {
    await fn({ r, events, ctrl, release, asked, finished: r.run(), doneEmitted });
  } finally {
    release(); // a run still waiting for its suggestions must not outlive the test
    llm.chat = realChat;
    wiki.getIndexedPage = realPage;
  }
}

test('agent: the answer is done before its follow-up questions, which arrive as their own event', async () => {
  await withLateFollowups(async ({ events, release, asked, finished, doneEmitted }) => {
    await doneEmitted();
    const done = events.find((e) => e.type === 'done');
    assert.equal(done.followupsPending, true);
    assert.deepEqual(done.followups, [], 'none yet');
    assert.equal(done.answer, 'Ada was born in 1815 [1].');
    assert.ok(!events.some((e) => e.type === 'followups') && asked.suggest === 1, 'the suggestion request is still out');
    release();
    await finished;
    const types = events.map((e) => e.type);
    assert.ok(types.indexOf('done') < types.indexOf('followups'), 'done first');
    const late = events.find((e) => e.type === 'followups');
    assert.equal(late.followups.length, 3);
    assert.deepEqual(late.trace.followups, late.followups, 'the debug info has them too');
    assert.ok(late.trace.notes.some((n) => /Follow-up questions took \d+ ms after the answer was shown/.test(n)));
    assert.ok(!events.some((e) => e.type === 'status' && /Suggesting/.test(e.text)), 'no longer a step before the answer');
  });
});

test('agent: follow-up questions are dropped when the reader stopped or asked again meanwhile', async () => {
  await withLateFollowups(async ({ events, ctrl, release, finished, doneEmitted }) => {
    await doneEmitted();
    ctrl.abort(); // a new question aborts the old run the same way
    release();
    await finished;
    assert.ok(!events.some((e) => e.type === 'followups'));
  });
});

test('agent: an answer that brings its own follow-up questions makes no extra request', async () => {
  const raw = 'Ada was born in 1815 [1].\n<followups>\n- Who taught her mathematics as a child?\n- What was her partnership with Charles Babbage?\n- Which notes did she add to the translation?\n</followups>';
  await withLateFollowups(async ({ events, asked, finished }) => {
    await finished;
    const done = events.find((e) => e.type === 'done');
    assert.equal(done.followupsPending, false);
    assert.equal(done.followups.length, 3);
    assert.equal(asked.suggest, 0);
    assert.ok(!events.some((e) => e.type === 'followups'));
  }, { raw });
});

test('titles: a bracket that names which one of several is told from one that describes', () => {
  for (const t of ['Imperial Guard (Russia)', 'Treaty of Paris (1763)', 'Georgia (U.S. state)', 'Napoleon (1955 film)']) assert.ok(textUtil.qualifiedByName(t), t);
  for (const t of ['Mercury (planet)', 'Theo van Gogh (art dealer)', 'Ada Lovelace (microarchitecture)', 'Treaty of Versailles', 'Imperial Guard']) assert.ok(!textUtil.qualifiedByName(t), t);
});

test('answer links: a title bracketed with a name or year is not linked by its bare name', () => {
  const titles = (text, list) => answerLinks.find(text, list.map((title) => ({ title, lang: 'en' })), 'Napoleonic Wars').map((x) => x.title);
  assert.deepEqual(titles('Neither article mentions the French Imperial Guard or its history.', ['Imperial Guard (Russia)']), [], '"French Imperial Guard" is not the Russian one');
  assert.deepEqual(titles('Napoleon sent the Imperial Guard forward.', ['Imperial Guard (Russia)']), [], 'nor is the bare name');
  assert.deepEqual(titles('Near Treaty of Paris today.', ['Treaty of Paris (1763)']), [], 'a year bracket either, even as the only candidate');
  assert.deepEqual(titles('It orbits close to Mercury today.', ['Mercury (planet)']), ['Mercury (planet)'], 'a descriptive bracket still links by the bare name');
});

test('agent: a question using a bare name does not read ahead the article bracketed with a name', () => {
  const r = run({ page: { lang: 'en', title: 'Napoleonic Wars', links: [{ title: 'Imperial Guard (Russia)', anchors: [], context: '', sections: [] }, { title: 'Theo van Gogh (art dealer)', anchors: [], context: '', sections: [] }] } });
  r.current = { page: { title: 'Napoleonic Wars' } };
  assert.deepEqual(r.mentionedArticles('I meant the Imperial Guard (Napoleon I), not the Russian'), []);
  assert.deepEqual(r.mentionedArticles('What did Theo van Gogh do for him?'), ['Theo van Gogh (art dealer)'], 'a descriptive bracket is still known by the bare name');
});

test('answer links: the first mention of an article, where it is safe', () => {
  const titles = (text, list, self = 'World War I') => answerLinks.find(text, list.map((title) => ({ title, lang: 'en' })), self).map((x) => x.title);
  assert.deepEqual(titles('The Treaty of Versailles came later. The Treaty of Versailles was signed.', ['Treaty of Versailles']), ['Treaty of Versailles'], 'once per answer');
  assert.deepEqual(answerLinks.spans('The Treaty of Versailles', [{ title: 'Treaty of Versailles', lang: 'en' }])[0].start, 4);
  assert.deepEqual(titles('Under the Treaty of Versailles.', ['Treaty of Versailles (1871)', 'Treaty of Versailles']), ['Treaty of Versailles'], 'the exact title wins');
  assert.deepEqual(titles('Near Treaty of Paris.', ['Treaty of Paris (1763)', 'Treaty of Paris (1898)']), [], 'an ambiguous short name links nowhere');
  assert.deepEqual(titles('It orbits close to Mercury today.', ['Mercury (planet)']), ['Mercury (planet)']);
  assert.deepEqual(titles('Article 231 of the Treaty of Versailles.', ['Article 231 of the Treaty of Versailles', 'Treaty of Versailles']), ['Article 231 of the Treaty of Versailles'], 'the longer name');
  assert.deepEqual(titles('In World War I and World War.', ['World War']), ['World War'], 'not inside the article itself');
  assert.deepEqual(titles('In World War I.', ['World War I', 'World War']), [], 'never the article itself');
  assert.deepEqual(titles('They used trench warfare.', ['Trench warfare']), ['Trench warfare'], 'a title of several words, in lower case');
  assert.deepEqual(titles('It lasted a time.', ['Time']), [], 'a single word needs its capital');
  assert.deepEqual(titles('Church services ended. Time passed.', ['Church', 'Time']), [], 'a single word opening a sentence');
  assert.deepEqual(titles('He is Zohran Kwame Mamdani.', ['Kwame']), [], 'a single word inside a longer name');
  assert.deepEqual(titles("He wrote the column Kwame's Kolumnalu and more.", ['Kwame']), [], 'or a possessive inside a name');
  assert.deepEqual(titles('It was the Church of England then.', ['Church']), [], 'or a name with "of"');
  assert.deepEqual(titles('It then praised Bolsonaro again.', ['Bolsonaro'], 'Jair Bolsonaro'), [], "a word of the article's own title");
  assert.deepEqual(titles('It went to Germany after.', ['Germany']), ['Germany']);
  assert.deepEqual(titles('### Treaty of Paris\nNothing.', ['Treaty of Paris']), [], 'not in headings');
  assert.deepEqual(titles('See `Treaty of Paris` here.', ['Treaty of Paris']), [], 'not in code');
  assert.deepEqual(titles('Treaties of Parisian note.', ['Treaty of Paris']), [], 'whole words');
  const many = Array.from({ length: 12 }, (_, i) => `Treaty Number${i}`);
  assert.equal(titles(many.join(', '), many).length, answerLinks.MAX_LINKS);
});

test('markdown: article links go where they should, and only those given', () => {
  const links = { items: [{ title: 'Treaty of Brest-Litovsk', lang: 'en' }], self: 'World War I' };
  const html = markdown.render('**Terms:** The Treaty of Brest-Litovsk [1]. The Treaty of Brest-Litovsk again.', () => true, null, [], links);
  assert.equal(html.match(/<a /g).length, 1);
  assert.ok(html.includes('<a class="answer-link" href="https://en.wikipedia.org/wiki/Treaty_of_Brest-Litovsk" target="_blank" rel="noopener noreferrer" title="Open “Treaty of Brest-Litovsk”">Treaty of Brest-Litovsk</a>'), html);
  assert.ok(html.includes('class="cite'), 'citations still work');
  assert.ok(!markdown.render('Treaty of Paris [link](https://evil.example).').includes('<a '), 'model text makes no links');
  const odd = markdown.render('See "Tom & Jerry" now.', () => true, null, [], { items: [{ title: 'Tom & Jerry', lang: 'en' }], self: '' });
  assert.ok(odd.includes('wiki/Tom_%26_Jerry') && odd.includes('Tom &amp; Jerry</a>'), odd);
  assert.ok(!markdown.render('Treaty of Paris.', () => true, null, [], { items: [{ title: 'Treaty of Paris', lang: 'evil.example/x' }], self: '' }).includes('<a '), 'a bad language makes no link');
  assert.ok(!markdown.render('Use \uE0200\uE021 here.', () => true, null, [], null).includes('<a '), "the renderer's markers can't come from the model");
});

test('agent: tracks the articles shown to the model', () => {
  const r = run();
  r.current = { page: { title: 'T' } };
  r.format([{ lang: 'en', page: 'Other', section: 'S', text: 'Text.' }], 1000);
  assert.deepEqual([...r.read], [['Other', 'en']]);
});

test('sections: the heading the reader is at', () => {
  const at = (tops) => sectionNames.readingIndex(tops, 768);
  assert.equal(at([300, 900]), -1, 'still in the introduction');
  assert.equal(at([-500, 200, 400]), 1, 'the last one in the top third');
  assert.equal(at([-81, 71, 229, 400]), 1, 'a link to a short section: not the next heading, also in the top third');
  assert.equal(at([20, 60, 200]), 1, 'a subsection right under its section');
  assert.equal(at([-229, -71, 150, 400]), 2, 'once the short section has scrolled away');
});

test('phrases: typed questions only where a section can answer them', async () => {
  const { phraseBook } = await import('../content/phrases.js');
  const q = (code, type, headings) => phraseBook.typedQuestions(code, type, 'X', headings);
  assert.deepEqual(q('en', 'person', ['Early life', 'Work']), ['What is X best known for?', 'What were the turning points in the life of X?']);
  assert.deepEqual(q('en', 'person', ['Early life', 'Work', 'Legacy']), ['What is X best known for?', 'What is the legacy of X?'], 'its effect on the world beats more about the subject itself');
  assert.equal(q('en', 'work', ['Background', 'Plot', 'Reception'])[1], 'How was “X” received, then and later?');
  assert.equal(q('en', 'person', ['Lifestyle']).length, 1, '"life" is not "Lifestyle"');
  assert.equal(q('en', 'religion', ['Culture']).length, 1, '"cult" is not "Culture"');
  assert.equal(q('en', 'event', ['Causes of the war']).length, 2, 'plurals count, anywhere in the heading');
  assert.equal(q('en', 'person', ['Personal life']).length, 2, 'keywords of several words');
  assert.equal(q('fr', 'person', ['Vieux Paris']).length, 1, '"vie" is not "Vieux"');
  assert.equal(q('de', 'person', ['Vermächtnis']).length, 2, 'letters beyond English');
  assert.equal(q('de', 'religion', ['Kultur']).length, 1, 'German "Kult" is not "Kultur"');
  assert.equal(q('de', 'religion', ['Kult']).length, 2);
  assert.deepEqual(q('en', 'event', ['Armies', 'Battle']), ['What happened in “X”, and why did it matter?'], 'no causes or aftermath section');
  assert.deepEqual(q('en', 'concept', ['Causes']), ['Explain “X” in simple terms'], '"uses" only counts at the start of a word');
  assert.equal(q('de', 'person', ['Lebenslauf'])[1], 'Was waren die Wendepunkte im Leben von X?', 'German compounds match by their start');
  assert.deepEqual(q('en', 'other', ['History']), []);
  assert.deepEqual(q('xx', 'work', ['Reception']).length, 2, 'unknown languages get English');
  assert.equal(phraseBook.topicQuestion('en', 'events'), 'In what order did these events happen, and how did each lead to the next?');
  assert.equal(phraseBook.topicQuestion('en', 'mixed'), '');
});

test('phrases: starter questions for an article', async () => {
  const { phraseBook } = await import('../content/phrases.js');
  const links = [{ title: 'A', count: 1 }, { title: 'B', count: 5 }, { title: 'C', count: 2 }];
  const q = (o) => phraseBook.starterQuestions('en', { title: 'X', type: undefined, sections: ['History'], reading: '', links, disambiguation: false, ...o });
  const summary = 'Summarize “X” in a few bullet points';
  const readNext = 'Which linked articles should I read next, and why?';
  assert.deepEqual(q({ disambiguation: true }), ['Which meanings of “X” are listed here?', 'What is “A”?', 'What is “B”?']);
  assert.deepEqual(q({ sections: [] }), [summary, readNext], 'a stub');
  assert.deepEqual(q({}), [summary, 'How is “X” connected to “B”?', readNext], 'no type yet: the most-mentioned link');
  assert.deepEqual(q({ type: 'other', reading: 'Life' }), [summary, 'Explain the section “Life”', readNext]);
  assert.deepEqual(q({ links: [] }), [summary, 'Explain the section I am reading', readNext]);
  assert.deepEqual(q({ type: 'person', sections: ['Legacy'], reading: 'Legacy' }), ['What is X best known for?', 'What is the legacy of X?', 'Explain the section “Legacy”']);
  assert.deepEqual(q({ type: 'person' }), ['What is X best known for?', summary], 'the introduction on screen');
});

test('phrases: starter questions for a topic', async () => {
  const { phraseBook } = await import('../content/phrases.js');
  const q = (o) => phraseBook.topicQuestions('en', { kind: 'mixed', themes: [], here: '', ...o });
  const overview = 'Give me an overview of this topic and its main themes';
  const readFirst = 'Which articles in this topic should I read first, and why?';
  assert.deepEqual(q({}), [overview, 'How are the articles in this topic connected?', readFirst]);
  assert.deepEqual(q({ themes: ['A', 'B', 'C'], here: 'Y' }), [overview, 'How is “A” connected to “B”?', 'What should I know about “C”?', 'How does Y fit into this topic?']);
  assert.deepEqual(q({ kind: 'works', themes: ['A', 'B', 'C'] }), [overview, 'How do these works relate to each other?', 'How is “A” connected to “B”?', readFirst], 'the kind takes the third theme\'s place');
});

// What is read ahead before the model starts: more than the first two or three passages, but never more than the budget allows.
function readAheadRun(extra = {}) {
  const chunks = Array.from({ length: 12 }, (_, i) => ({ lang: 'en', page: 'T', section: `S${i}`, text: `Passage ${i} about coffee trade and plantations. `.repeat(6) }));
  const asked = [];
  const r = run({ question: 'what about the coffee trade', ...extra });
  r.current = { page: { title: 'T' }, chunks, index: { search: (q, k) => (asked.push(k), chunks.slice(0, k).map((doc) => ({ doc, score: 1 }))) } };
  r.page.visibleSection = null;
  return { r, asked, chunks };
}
const shown = (text) => (text.match(/^\[\d+\] /gm) || []).length;

test('agent: the read-ahead shows six passages of this article, four when another article is named', async () => {
  const { r, asked } = readAheadRun();
  const out = await r.hints();
  assert.equal(asked[0], 6);
  assert.equal(shown(out), 6);
  const named = readAheadRun({ page: { lang: 'en', title: 'T', links: [{ title: 'Other article', anchors: [], context: '', sections: [] }] }, question: 'what about the Other article and coffee' });
  named.r.mentionedArticles = () => ['Other article'];
  const other = { page: { title: 'Other article' }, chunks: named.chunks.map((c) => ({ ...c, page: 'Other article' })) };
  other.index = { search: (q, k) => (named.asked.push(k), other.chunks.slice(0, k).map((doc) => ({ doc, score: 1 }))) };
  const real = wiki.getIndexedPage;
  wiki.getIndexedPage = async () => other;
  try {
    const both = await named.r.hints();
    assert.deepEqual(named.asked, [5, 4], '5 passages of the named article, 4 of this one');
    assert.equal(shown(both), 5 + 4);
  } finally {
    wiki.getIndexedPage = real;
  }
});

test('agent: the read-ahead is still cut to its token budget', async () => {
  const { r } = readAheadRun({ settings: { contextTokens: 2000 } }); // 10% of 2,000 tokens for this article
  const out = await r.hints();
  assert.ok(shown(out) < 6, `only what fits: ${shown(out)}`);
  assert.match(out, /more text omitted/);
});

test('prompt: asks for as much detail as the passages support, not for brevity', () => {
  const rules = prompt.rules({ title: 'T', languageRule: 'x', followupLanguage: 'x', topic: false }).join('\n');
  assert.match(rules, /Cover what the passages say in as much detail as they support/);
  assert.ok(!/Be concise/.test(rules));
});

test('agent: a search for words like "best known" reads the introduction instead', async () => {
  const r = run();
  r.current = {
    page: { title: 'T' },
    chunks: [
      { lang: 'en', page: 'T', section: 'Introduction', text: 'T was a painter, known for sunflowers.' },
      { lang: 'en', page: 'T', section: 'Flowers', text: 'The best sunflowers were painted in Arles.' },
    ],
  };
  r.current.index = { search: () => [{ doc: r.current.chunks[1] }] };
  r.toolTokens = 0;
  r.systemBase = '';
  const out = await r.tool('search_article', { query: 'best known' });
  assert.match(out, /introduction/i);
  assert.ok(out.includes('known for sunflowers') && !out.includes('Arles'));
  assert.equal(r.describe('search_article', { query: 'best known' }), 'Reading the introduction');
  assert.equal(r.describe('search_article', { query: 'sunflowers Arles' }), 'Searching this article for “sunflowers Arles”');
});

test('agent: a linked article named like part of this article is not read ahead', () => {
  const r = run({
    page: { lang: 'en', title: 'Vincent van Gogh', links: [{ title: 'Van Gogh (1948 film)' }, { title: 'Ada Lovelace (microarchitecture)' }, { title: 'Paul Gauguin' }, { title: 'Theo van Gogh (art dealer)' }] },
  });
  r.current = { page: { title: 'Vincent van Gogh' } };
  assert.deepEqual(r.mentionedArticles('What is Vincent van Gogh best known for?'), []);
  assert.deepEqual(r.mentionedArticles('What did Van Gogh paint in Arles?'), [], 'the surname alone is this article too');
  assert.deepEqual(r.mentionedArticles('How did Van Gogh meet Paul Gauguin?'), ['Paul Gauguin']);
  assert.deepEqual(r.mentionedArticles('What did Theo van Gogh do for him?'), ['Theo van Gogh (art dealer)'], 'a longer name with other words still counts');
});
