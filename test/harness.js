// Loads the sidebar into a normal Wikipedia tab without installing the extension, for UI testing.
// Build it (npm run build, which writes dist/harness.js), then serve the repo:  python3 -m http.server 8765 --bind 127.0.0.1
// The agent runs in the page with real Wikipedia retrieval and a scripted fake model (no API key involved).
import { agent } from '../lib/agent.js';
import { appSettings } from '../lib/settings.js';
import { cluster } from '../lib/cluster.js';
import { grounding } from '../lib/grounding.js';
import { llm } from '../lib/llm.js';
import { topics } from '../lib/topics.js';

(async () => {
  const BASE = location.hostname.endsWith('wikipedia.org') ? 'http://localhost:8765/' : location.origin + '/';
  const settings = { ...appSettings.DEFAULTS, model: 'fake-model' };
  let suggestionSets = 0;
  window.__wikiaiSettings = settings; // e.g. __wikiaiSettings.verifyCitations = true, to try the citation check
  // __wikiaiNoCheck = true: nothing gets left out by the source check, to see the scripted answer as written.
  const realCheck = grounding.check;
  grounding.check = (...args) => (window.__wikiaiNoCheck ? [] : realCheck(...args));

  // Fake model: searches the article, opens one linked article, then answers citing what it got.
  llm.chat = async ({ messages, tools, onUpdate }) => {
    // The extra request for follow-up questions (made when the answer brought fewer than two): slow, to see the answer
    // finish first and the questions arrive after it.
    if (!tools && messages[0].content.startsWith('You suggest follow-up questions')) {
      const set = ++suggestionSets; // numbered, to see which answer a set of suggestions ended up under
      await new Promise((r) => setTimeout(r, 3000));
      return { content: `- Set ${set}: what happened after this period?\n- Set ${set}: who else was involved in these events?\n- Set ${set}: where can I read more about the background?`, toolCalls: [], model: 'fake-model' };
    }
    // Citation check: a second or so, then calls the first statement unsupported (it gets fixed, or left out).
    if (!tools && messages[0].content.startsWith('You check whether Wikipedia passages')) {
      await new Promise((r) => setTimeout(r, 1200));
      return { content: JSON.stringify({ unsupported: [{ statement: 1, why: 'The passage names her but not this detail (scripted test).' }] }), toolCalls: [], model: 'fake-model' };
    }
    // Cluster planning: pick candidate numbers into three themes.
    if (!tools && messages[0].content.includes('topic cluster')) {
      await new Promise((r) => setTimeout(r, 600));
      const n = (messages[1].content.match(/^\d+\. /gm) || []).length;
      const take = (from, k) => Array.from({ length: k }, (_, i) => from + i).filter((x) => x <= n);
      return {
        content: JSON.stringify({
          name: document.title.replace(' - Wikipedia', ''),
          kind: 'people',
          facets: [
            { name: 'Core lines', why: 'The main branches.', pages: take(1, 6) },
            { name: 'Related houses', why: 'Families tied by marriage or descent.', pages: take(7, 5) },
            { name: 'Events', why: 'Turning points.', pages: take(12, 4) },
          ],
          search: [{ facet: 'Events', query: 'Schleswig-Holstein question' }],
        }),
        toolCalls: [],
      };
    }
    const toolMsgs = messages.filter((m) => m.role === 'tool');
    // The reader's question, not the agent's own nudges ("Answer now…", the source check).
    const question = messages.filter((m) => m.role === 'user' && !/^(Parts of your answer|Answer now|Don't send me|Write your answer|No more lookups)/.test(m.content)).pop().content.split('\n---')[0];
    const call = (name, args) => ({ content: '', toolCalls: [{ id: 'c' + toolMsgs.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    await new Promise((r) => setTimeout(r, 400));
    if (tools && toolMsgs.length === 0) return call(tools.some((t) => t.function.name === 'search_topic') ? 'search_topic' : 'search_article', { query: question });
    if (tools && toolMsgs.length === 1) return call('find_linked_articles', { query: question });
    const linked = [...(toolMsgs[1]?.content || '').matchAll(/^- (.+?)(?: \(linked as| —)/gm)].map((m) => m[1]);
    if (tools && toolMsgs.length >= 2 && toolMsgs.length < 2 + Math.min(3, linked.length)) {
      return call('search_linked_article', { title: linked[toolMsgs.length - 2], query: question });
    }
    const nums = (k) => (toolMsgs[k]?.content.match(/^\[(\d+)\]/gm) || []).map((x) => x.slice(1, -1));
    const ref = (k, i = 0) => (nums(k)[i] ? `[${nums(k)[i]}]` : '');
    // "invent" in the question: a detail from memory, dropped when asked to check (unless also "stubborn").
    const checked = messages.some((m) => m.role === 'user' && m.content.startsWith("Parts of your answer aren't backed"));
    const invented = /invent/i.test(question) && (!checked || /stubborn/i.test(question)) ? '\n\nShe later moved to Montevideo in 1799 [1].' : '';
    // "table" in the question: a short table with citations and alignment; "wide table": one too wide for the panel.
    const table = /wide table/i.test(question)
      ? `\n\n| Year | Event | Place | People involved | Written about in | Outcome | Notes |\n| ---: | :--- | :---: | --- | --- | --- | --- |\n| 1833 | Meets **Charles Babbage** at a party ${ref(0)} | London | Ada Lovelace, Charles Babbage, Mary Somerville | Correspondence | A long friendship | Babbage shows her the Difference Engine |\n| 1843 | Publishes the *Notes* ${ref(0, 1)} | London | Ada Lovelace, Luigi Menabrea | Taylor's Scientific Memoirs | Described as the first program | Note G computes Bernoulli numbers |`
      : /table/i.test(question)
        ? `\n\n| Year | Event | Pages |\n| ---: | :--- | :---: |\n| 1833 | Meets **Charles Babbage** ${ref(0)} | 12 |\n| 1843 | Publishes the *Notes* ${ref(0, 1)} | 66 |\n| 1852 | Dies, aged 36 \`<script>\` a\\|b | 3 |`
        : '';
    const answer = `Here is what I found about **${question.trim().slice(0, 60)}**.\n\nThe article covers this in a few places ${ref(0)}${ref(0, 1)}. Linked articles add detail ${ref(2)}${ref(3)}.${table}\n\n- First point [1]\n- Second point ${ref(4)}${ref(2, 1)}${invented}`;
    // "think" in the question: a long reasoning stream first, to test the Thinking box.
    const reasoning = /think/i.test(question) ? Array.from({ length: 60 }, (_, i) => `Reasoning line ${i + 1} about the question.`).join('\n') : '';
    for (let i = 1; i <= 60 && reasoning; i++) {
      onUpdate?.({ answer: '', reasoning: reasoning.split('\n').slice(0, i).join('\n') });
      await new Promise((r) => setTimeout(r, 60));
    }
    for (let i = 1; i <= answer.length; i += 12) {
      onUpdate?.({ answer: answer.slice(0, i), reasoning });
      await new Promise((r) => setTimeout(r, 15));
    }
    // "cutoff" in the question: every reply stops mid-sentence, to see it asked for again and then shown with a note.
    if (/cutoff/i.test(question)) return { content: 'The article covers this in a few places [1],', raw: 'The article covers this in a few places [1],', toolCalls: [], model: 'fake-model', cutOff: true, finish: 'content_filter' };
    const q = question.trim().replace(/\?$/, '');
    // "late" in the question: no follow-up questions with the answer, so the slow extra request above is made.
    const raw = /late/i.test(question) ? answer : `${answer}\n\n<followups>\n- What came before: ${q}?\n- Which article explains the background of ${q}?\n- How does this compare with neighbouring dynasties?\n</followups>`;
    return { content: answer, raw, toolCalls: [] };
  };
  const listeners = [];
  window.chrome = {
    runtime: {
      id: 'wikiai-harness',
      getURL: (p) => BASE + p,
      sendMessage: async (msg) => {
        if (msg.type === 'getSettings') return { hasKey: true, recipient: 'the scripted test model', privacyUrl: appSettings.PRIVACY_URL, noticeSeen: !!window.__wikiaiNoticeSeen };
        if (msg.type === 'privacyNoticeSeen') return { result: (window.__wikiaiNoticeSeen = true) };
        try {
          return { result: await topics.handle(msg) };
        } catch (e) {
          return { error: e.message };
        }
      },
      onMessage: { addListener: (fn) => listeners.push(fn) },
      connect() {
        const onMsg = [];
        let ctrl;
        return {
          onMessage: { addListener: (fn) => onMsg.push(fn) },
          onDisconnect: { addListener() {} },
          postMessage(msg) {
            const emit = (m) => onMsg.forEach((fn) => fn(m));
            if (msg.type === 'stop' || msg.type === 'stopTopic') return ctrl?.abort();
            window.__wikiaiLastPage = msg.page; // for inspecting what the sidebar sends
            if (msg.type === 'buildTopic') {
              ctrl = new AbortController();
              return cluster
                .build({ settings, page: msg.page, emit, signal: ctrl.signal })
                .then((topic) => emit({ type: 'topicBuilt', topic }))
                .catch((e) => emit({ type: 'topicError', message: e.message }));
            }
            ctrl = new AbortController();
            const signal = ctrl.signal;
            const send = (e) => emit({ ...e, rid: msg.rid }); // as the service worker does
            topics
              .get(msg.topicId)
              .then((topic) => agent.run({ settings, page: msg.page, topic, question: msg.question, history: msg.history, sources: msg.sources, emit: send, signal }))
              .catch((e) => (signal.aborted ? send({ type: 'done', stopped: true }) : send({ type: 'error', message: e.message })));
          },
        };
      },
    },
  };
  window.__wikiaiSend = (msg) => listeners.forEach((fn) => fn(msg));
  window.__wikiaiTopics = topics; // to set up a topic state by hand (e.g. one open that doesn't contain this article)
  // The panel starts on import, so only once the fakes above are in place.
  await import('../content/content.js');
})();
