// Saved conversations (the sidebar's tabs), grouped by scope: a topic id, or "page:<lang>:<title>" without a topic.
// Capped per scope, by number of scopes, and by the bytes the whole storage area uses, so
// chrome.storage.local (10 MB) can't fill up.
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});
  const MAX_PER_SCOPE = 12;
  const MAX_SCOPES = 40;
  const SOURCE_CHARS = 700; // stored source passages are trimmed; enough to preview and to find them in the page
  const MAX_BYTES = 8 * 1024 * 1024; // whole area, settings and topics included; least recently used chats go first
  const LOCK = 'conversations';
  const store = W.storage;

  const keyOf = (scope) => `conv:${scope}`;

  // Drops what's only needed while an answer streams, trims source texts, and keeps the text and image only for
  // sources an answer cites. Uncited ones keep their number, page and section: answers number sources chat-wide.
  function compact(conv) {
    const cited = new Set(conv.messages.filter((m) => m.role === 'assistant').flatMap((m) => [...(W.grounding?.cited(m.content) || [])]));
    return {
      ...conv,
      messages: conv.messages
        .filter((m) => !m.pending)
        .map(({ pending, status, stepsOpen, reasoningOpen, reasoning, ...m }) => m),
      sources: (conv.sources || []).map(({ figure, ...s }) =>
        cited.has(s.n) || !W.grounding ? { ...s, text: (s.text || '').slice(0, SOURCE_CHARS), ...(figure ? { figure } : {}) } : { ...s, text: '' }
      ),
    };
  }

  async function list(scope) {
    const convs = await store.get(keyOf(scope));
    return Array.isArray(convs) ? convs : [];
  }

  function save(scope, conv) {
    return store.locked(LOCK, async () => {
      if (!conv.messages.some((m) => m.role === 'user')) return list(scope); // empty tabs aren't worth keeping
      const convs = (await list(scope)).filter((c) => c.id !== conv.id);
      convs.unshift({ ...compact(conv), updatedAt: Date.now() });
      convs.sort((a, b) => b.updatedAt - a.updatedAt);
      await store.set(keyOf(scope), convs.slice(0, MAX_PER_SCOPE));
      await touch(scope);
      return convs;
    });
  }

  function remove(scope, id) {
    return store.locked(LOCK, async () => {
      const convs = (await list(scope)).filter((c) => c.id !== id);
      await store.set(keyOf(scope), convs);
      return convs;
    });
  }

  // Least recently used scopes are dropped beyond MAX_SCOPES, then while the storage area is over MAX_BYTES.
  async function touch(scope) {
    const index = (await store.get('conv:index')) || {};
    index[scope] = Date.now();
    const scopes = Object.entries(index).sort((a, b) => b[1] - a[1]).map(([s]) => s);
    const drop = async (old) => {
      delete index[old];
      await store.remove(keyOf(old));
    };
    for (const old of scopes.slice(MAX_SCOPES)) await drop(old);
    for (const old of scopes.slice(1, MAX_SCOPES).reverse()) {
      if ((await store.bytesInUse()) <= MAX_BYTES) break;
      await drop(old);
    }
    await store.set('conv:index', index);
  }

  // Deletes the saved chats of every scope that matches (all of them by default).
  function clear(match = () => true) {
    return store.locked(LOCK, async () => {
      const index = (await store.get('conv:index')) || {};
      for (const scope of Object.keys(index).filter(match)) {
        delete index[scope];
        await store.remove(keyOf(scope));
      }
      await store.set('conv:index', index);
    });
  }

  // The chat's questions and answers, for searching the history.
  const chatText = (c) => c.messages.map((m) => m.content || '').join('\n').slice(0, 20000);

  // A summary of every saved chat, newest first, for the history across topics and articles.
  async function listAll() {
    const index = (await store.get('conv:index')) || {};
    const out = [];
    for (const scope of Object.keys(index)) {
      for (const c of await list(scope)) {
        if (!Array.isArray(c?.messages)) continue; // a damaged record
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
      case 'conv:clear': return clear();
      default: return undefined;
    }
  }

  W.conversations = { list, listAll, save, remove, clear, handle, compact };
})(globalThis);
