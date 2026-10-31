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
  for (const f of ['lib/settings.js', 'lib/cache.js', 'lib/bm25.js', 'lib/wiki.js', 'lib/llm.js', 'lib/agent.js', 'content/markdown.js']) await load(f);
  const W = globalThis.WikiAI;
  const settings = { ...W.settings.DEFAULTS, model: 'fake-model' };

  // Fake model: searches the article, opens one linked article, then answers citing what it got.
  W.llm.chat = async ({ messages, tools, onUpdate }) => {
    const toolMsgs = messages.filter((m) => m.role === 'tool');
    const question = messages.filter((m) => m.role === 'user').pop().content.split('\n---')[0];
    const call = (name, args) => ({ content: '', toolCalls: [{ id: 'c' + toolMsgs.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    await new Promise((r) => setTimeout(r, 400));
    if (tools && toolMsgs.length === 0) return call('search_article', { query: question });
    if (tools && toolMsgs.length === 1) return call('find_linked_articles', { query: question });
    const linked = [...(toolMsgs[1]?.content || '').matchAll(/^- (.+?)(?: \(linked as| —)/gm)].map((m) => m[1]);
    if (tools && toolMsgs.length >= 2 && toolMsgs.length < 2 + Math.min(3, linked.length)) {
      return call('search_linked_article', { title: linked[toolMsgs.length - 2], query: question });
    }
    const nums = (k) => (toolMsgs[k]?.content.match(/^\[(\d+)\]/gm) || []).map((x) => x.slice(1, -1));
    const ref = (k, i = 0) => (nums(k)[i] ? `[${nums(k)[i]}]` : '');
    const answer = `Here is what I found about **${question.trim().slice(0, 60)}**.\n\nThe article covers this in a few places ${ref(0)}${ref(0, 1)}. Linked articles add detail ${ref(2)}${ref(3)}.\n\n- First point [1]\n- Second point ${ref(4)}${ref(2, 1)}`;
    for (let i = 1; i <= answer.length; i += 12) {
      onUpdate?.({ answer: answer.slice(0, i), reasoning: '' });
      await new Promise((r) => setTimeout(r, 15));
    }
    return { content: answer, toolCalls: [] };
  };
  const listeners = [];
  window.chrome = {
    runtime: {
      getURL: (p) => BASE + p,
      sendMessage: () => {},
      onMessage: { addListener: (fn) => listeners.push(fn) },
      connect() {
        const onMsg = [];
        let ctrl;
        return {
          onMessage: { addListener: (fn) => onMsg.push(fn) },
          onDisconnect: { addListener() {} },
          postMessage(msg) {
            const emit = (m) => onMsg.forEach((fn) => fn(m));
            if (msg.type === 'stop') return ctrl?.abort();
            ctrl = new AbortController();
            const signal = ctrl.signal;
            W.agent
              .run({ settings, page: msg.page, question: msg.question, history: msg.history, sources: msg.sources, emit, signal })
              .catch((e) => (signal.aborted ? emit({ type: 'done', stopped: true }) : emit({ type: 'error', message: e.message })));
          },
        };
      },
    },
  };
  window.__wikiaiSend = (msg) => listeners.forEach((fn) => fn(msg));
  await load('content/content.js');
})();
