// Loads the sidebar into a normal Wikipedia tab without installing the extension, for UI testing.
// Serve the repo first:  python3 -m http.server 8765 --bind 127.0.0.1
// The agent runs in the page with real Wikipedia retrieval and a scripted fake model (no API key involved).
(async () => {
  const BASE = location.hostname.endsWith('wikipedia.org') ? 'http://localhost:8765/' : location.origin + '/';
  const load = (src) =>
    new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = BASE + src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  for (const f of ['lib/settings.js', 'lib/cache.js', 'lib/bm25.js', 'lib/tables.js', 'lib/wiki.js', 'lib/llm.js', 'lib/links.js', 'lib/grounding.js', 'lib/agent.js', 'lib/topics.js', 'lib/conversations.js', 'lib/cluster.js', 'vendor/katex/katex.min.js', 'content/markdown.js', 'content/map.js']) await load(f);
  const W = globalThis.WikiAI;
  const settings = { ...W.settings.DEFAULTS, model: 'fake-model' };

  // Fake model: searches the article, opens one linked article, then answers citing what it got.
  W.llm.chat = async ({ messages, tools, onUpdate }) => {
    // Cluster planning: pick candidate numbers into three themes.
    if (!tools && messages[0].content.includes('topic cluster')) {
      await new Promise((r) => setTimeout(r, 600));
      const n = (messages[1].content.match(/^\d+\. /gm) || []).length;
      const take = (from, k) => Array.from({ length: k }, (_, i) => from + i).filter((x) => x <= n);
      return {
        content: JSON.stringify({
          name: document.title.replace(' - Wikipedia', ''),
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
    const question = messages.filter((m) => m.role === 'user' && !/^(Parts of your answer|Answer now|Don't send me|Write your answer)/.test(m.content)).pop().content.split('\n---')[0];
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
    const answer = `Here is what I found about **${question.trim().slice(0, 60)}**.\n\nThe article covers this in a few places ${ref(0)}${ref(0, 1)}. Linked articles add detail ${ref(2)}${ref(3)}.\n\n- First point [1]\n- Second point ${ref(4)}${ref(2, 1)}${invented}`;
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
    const q = question.trim().replace(/\?$/, '');
    const raw = `${answer}\n\n<followups>\n- What came before: ${q}?\n- Which article explains the background of ${q}?\n- How does this compare with neighbouring dynasties?\n</followups>`;
    return { content: answer, raw, toolCalls: [] };
  };
  const listeners = [];
  window.chrome = {
    runtime: {
      id: 'wikiai-harness',
      getURL: (p) => BASE + p,
      sendMessage: async (msg) => {
        try {
          return { result: await W.topics.handle(msg) };
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
              return W.cluster
                .build({ settings, page: msg.page, emit, signal: ctrl.signal })
                .then((topic) => emit({ type: 'topicBuilt', topic }))
                .catch((e) => emit({ type: 'topicError', message: e.message }));
            }
            ctrl = new AbortController();
            const signal = ctrl.signal;
            W.topics
              .get(msg.topicId)
              .then((topic) => W.agent.run({ settings, page: msg.page, topic, question: msg.question, history: msg.history, sources: msg.sources, emit, signal }))
              .catch((e) => (signal.aborted ? emit({ type: 'done', stopped: true }) : emit({ type: 'error', message: e.message })));
          },
        };
      },
    },
  };
  window.__wikiaiSend = (msg) => listeners.forEach((fn) => fn(msg));
  await load('content/content.js');
})();
