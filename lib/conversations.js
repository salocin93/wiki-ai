// Saved conversations (the sidebar's tabs), grouped by scope: a topic id, or "page:<lang>:<title>" without a topic.
// Capped per scope and overall so chrome.storage.local (10 MB) can't fill up.
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});
  const MAX_PER_SCOPE = 12;
  const MAX_SCOPES = 40;
  const SOURCE_CHARS = 700; // stored source passages are trimmed; enough to preview and to find them in the page

  const memoryStore = {};
  const store = {
    async get(key) {
      if (g.chrome?.storage?.local) return (await chrome.storage.local.get(key))[key];
      return memoryStore[key];
    },
    async set(key, value) {
      if (g.chrome?.storage?.local) await chrome.storage.local.set({ [key]: value });
      else memoryStore[key] = value;
    },
    async remove(key) {
      if (g.chrome?.storage?.local) await chrome.storage.local.remove(key);
      else delete memoryStore[key];
    },
  };

  const keyOf = (scope) => `conv:${scope}`;

  // Drops what's only needed while an answer streams, and trims source texts.
  function compact(conv) {
    return {
      ...conv,
      messages: conv.messages
        .filter((m) => !m.pending)
        .map(({ pending, status, stepsOpen, reasoningOpen, reasoning, ...m }) => m),
      sources: (conv.sources || []).map((s) => ({ ...s, text: s.text.slice(0, SOURCE_CHARS) })),
    };
  }

  async function list(scope) {
    return (await store.get(keyOf(scope))) || [];
  }

  async function save(scope, conv) {
    if (!conv.messages.some((m) => m.role === 'user')) return list(scope); // empty tabs aren't worth keeping
    const convs = (await list(scope)).filter((c) => c.id !== conv.id);
    convs.unshift({ ...compact(conv), updatedAt: Date.now() });
    convs.sort((a, b) => b.updatedAt - a.updatedAt);
    await store.set(keyOf(scope), convs.slice(0, MAX_PER_SCOPE));
    await touch(scope);
    return convs;
  }

  async function remove(scope, id) {
    const convs = (await list(scope)).filter((c) => c.id !== id);
    await store.set(keyOf(scope), convs);
    return convs;
  }

  // Least recently used scopes are dropped beyond MAX_SCOPES.
  async function touch(scope) {
    const index = (await store.get('conv:index')) || {};
    index[scope] = Date.now();
    const scopes = Object.entries(index).sort((a, b) => b[1] - a[1]);
    for (const [old] of scopes.slice(MAX_SCOPES)) {
      delete index[old];
      await store.remove(keyOf(old));
    }
    await store.set('conv:index', index);
  }

  // The chat's questions and answers, for searching the history.
  const chatText = (c) => c.messages.map((m) => m.content || '').join('\n').slice(0, 20000);

  // A summary of every saved chat, newest first, for the history across topics and articles.
  async function listAll() {
    const index = (await store.get('conv:index')) || {};
    const out = [];
    for (const scope of Object.keys(index)) {
      for (const c of await list(scope)) {
        out.push({
          scope,
          id: c.id,
          title: c.title,
          updatedAt: c.updatedAt || c.createdAt,
          questions: c.messages.filter((m) => m.role === 'user').length,
          text: chatText(c),
        });
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function handle(msg) {
    switch (msg.type) {
      case 'conv:list': return list(msg.scope);
      case 'conv:all': return listAll();
      case 'conv:save': return save(msg.scope, msg.conv);
      case 'conv:delete': return remove(msg.scope, msg.id);
      default: return undefined;
    }
  }

  W.conversations = { list, listAll, save, remove, handle };
})(globalThis);
