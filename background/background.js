// Service worker: runs the agent (Wikipedia + LLM requests) on behalf of the sidebar in each tab.
importScripts(
  '../lib/settings.js',
  '../lib/storage.js',
  '../lib/cache.js',
  '../lib/bm25.js',
  '../lib/tables.js',
  '../lib/wiki.js',
  '../lib/llm.js',
  '../lib/links.js',
  '../lib/grounding.js',
  '../lib/agent.js',
  '../lib/topics.js',
  '../lib/conversations.js',
  '../lib/cluster.js'
);

const W = globalThis.WikiAI;

async function loadSettings() {
  const settings = await W.settings.load();
  if (!settings.apiKey && settings.provider !== 'custom') { // a server of your own may not need one
    throw new Error('No API key set. Open the Wiki AI settings, pick where answers come from and paste the key.');
  }
  return settings;
}

// Chrome stops an idle service worker after 30 s, and waiting on a slow model or a rate limit doesn't count as
// activity. While an answer or a topic is being worked on, a cheap extension call every 20 s keeps it running.
let busy = 0;
let keepAlive = 0;
async function whileBusy(fn) {
  if (busy++ === 0) keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  try {
    return await fn();
  } finally {
    if (--busy === 0) clearInterval(keepAlive);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'wikiai-chat') return;
  let controller = null;
  let building = null;
  const emit = (msg) => {
    try {
      port.postMessage(msg);
    } catch {} // tab closed or navigated away
  };

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'stop') {
      controller?.abort();
      return;
    }
    if (msg.type === 'stopTopic') {
      building?.abort();
      return;
    }
    if (msg.type === 'buildTopic') {
      building?.abort();
      building = new AbortController();
      const signal = building.signal;
      await whileBusy(async () => {
        try {
          const settings = await loadSettings();
          const topic = await W.cluster.build({ settings, page: msg.page, emit, signal });
          emit({ type: 'topicBuilt', topic });
        } catch (e) {
          emit({ type: 'topicError', message: signal.aborted ? 'Stopped.' : e.message || String(e) });
        }
      });
      return;
    }
    if (msg.type !== 'ask') return;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    await whileBusy(async () => {
      try {
        const settings = await loadSettings();
        const topic = msg.topicId ? await W.topics.get(msg.topicId) : null;
        await W.agent.run({ settings, page: msg.page, topic, question: msg.question, history: msg.history, sources: msg.sources, emit, signal });
      } catch (e) {
        if (signal.aborted) emit({ type: 'done', stopped: true });
        else emit({ type: 'error', message: e.message || String(e) });
      }
    });
  });

  port.onDisconnect.addListener(() => {
    controller?.abort();
    building?.abort();
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'openOptions') chrome.runtime.openOptionsPage();
  if (/^(topics|cache|conv|data):/.test(msg.type)) {
    W.topics
      .handle(msg)
      .then((result) => sendResponse({ result }))
      .catch((e) => sendResponse({ error: e.message || String(e) }));
    return true;
  }
  if (msg.type === 'getSettings') {
    Promise.all([W.settings.load(), W.storage.get('privacyNoticeSeen')]).then(([s, seen]) =>
      sendResponse({
        model: s.model,
        fallbackModel: s.fallbackModel,
        hasKey: !!s.apiKey,
        answerLanguage: s.answerLanguage,
        recipient: W.settings.recipient(s),
        privacyUrl: W.settings.PRIVACY_URL,
        noticeSeen: !!seen,
      })
    );
    return true;
  }
  if (msg.type === 'privacyNoticeSeen') {
    W.storage.set('privacyNoticeSeen', true).then(() => sendResponse({}));
    return true;
  }
});

function sendToTab(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {}); // not a Wikipedia article tab
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // New installs (e.g. a tester) start on the settings page to choose a model provider and paste a key.
  if (reason === 'install' && !(await W.settings.load()).apiKey) chrome.runtime.openOptionsPage();
  // Chats left behind by topics deleted before deleting a topic took its chats along.
  if (reason === 'update') W.topics.dropOrphanChats().catch(() => {});
  chrome.contextMenus.create({
    id: 'wikiai-ask',
    title: 'Ask Wiki AI about “%s”',
    contexts: ['selection'],
    documentUrlPatterns: ['https://*.wikipedia.org/wiki/*'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'wikiai-ask' && tab?.id != null) sendToTab(tab.id, { type: 'askSelection', text: info.selectionText });
});

chrome.action.onClicked.addListener((tab) => tab.id != null && sendToTab(tab.id, { type: 'toggle' }));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-sidebar' && tab?.id != null) sendToTab(tab.id, { type: 'toggle' });
});
