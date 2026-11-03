// Service worker: runs the agent (Wikipedia + LLM requests) on behalf of the sidebar in each tab.
importScripts(
  '../lib/settings.js',
  '../lib/storage.js',
  '../lib/sections.js',
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

// Only the settings page and this extension's own pages may read or clear everything; content scripts (which
// run inside Wikipedia's pages) get what the sidebar needs. Content scripts can't read extension storage at all
// (it holds the API key), where the browser supports closing it to them.
try {
  chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })?.catch?.(() => {});
} catch {
  // not supported for this storage area in older browsers
}

// A content script's sender.url is its web page, so it can't pass for one of the extension's pages.
const fromExtensionPage = (sender) => !!sender.url?.startsWith(chrome.runtime.getURL(''));
function fromWikipedia(sender) {
  try {
    const url = new URL(sender.url || sender.tab?.url || '');
    return url.protocol === 'https:' && url.hostname.endsWith('.wikipedia.org');
  } catch {
    return false;
  }
}
const SIDEBAR_TYPES = new Set([
  'openOptions', 'getSettings', 'privacyNoticeSeen', 'handoff:get', 'handoff:set',
  'topics:list', 'topics:active', 'topics:forPage', 'topics:setActive', 'topics:delete', 'topics:addPage', 'topics:removePage',
  'conv:list', 'conv:all', 'conv:save', 'conv:delete',
]);

// The fields each message must have; anything malformed is dropped before it reaches storage.
const str = (v, max = 2000) => typeof v === 'string' && v.length <= max;
const LANG = /^[a-z][a-z0-9-]{0,20}$/;
function wellFormed(msg) {
  switch (msg.type) {
    case 'conv:list': return str(msg.scope);
    case 'conv:save': return str(msg.scope) && !!msg.conv && str(msg.conv.id, 100) && Array.isArray(msg.conv.messages) && (msg.conv.sources == null || Array.isArray(msg.conv.sources));
    case 'conv:delete': return str(msg.scope) && str(msg.id, 100);
    case 'topics:forPage': return LANG.test(msg.lang) && str(msg.title, 500);
    case 'topics:setActive': return msg.id == null || str(msg.id, 100);
    case 'topics:delete': return str(msg.id, 100);
    case 'topics:addPage':
    case 'topics:removePage': return str(msg.id, 100) && str(msg.title, 500);
    case 'handoff:set': return Array.isArray(msg.list) && msg.list.length <= 10;
    case 'ask': return str(msg.question, 5000) && Array.isArray(msg.history ?? []) && Array.isArray(msg.sources ?? []) && validPage(msg.page) && (msg.topicId == null || str(msg.topicId, 100));
    case 'buildTopic': return validPage(msg.page);
    default: return true;
  }
}
const validPage = (page) => !!page && LANG.test(page.lang) && str(page.title, 500) && Array.isArray(page.links ?? []);

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
  // Only the sidebar on a Wikipedia article (in the test harness there is no service worker).
  if (port.sender?.id !== chrome.runtime.id || !fromWikipedia(port.sender)) return port.disconnect();
  let controller = null;
  let building = null;
  const emit = (msg) => {
    try {
      port.postMessage(msg);
    } catch {
      // tab closed or navigated away
    }
  };

  port.onMessage.addListener(async (msg) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (!wellFormed(msg)) {
      emit(msg.type === 'buildTopic' ? { type: 'topicError', message: 'Bad request.' } : { type: 'error', message: 'Bad request.' });
      return;
    }
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return;
  const trusted = fromExtensionPage(sender);
  if (!trusted && !(fromWikipedia(sender) && SIDEBAR_TYPES.has(msg.type))) return;
  if (!wellFormed(msg)) {
    sendResponse({ error: 'Bad request.' });
    return;
  }
  if (msg.type === 'openOptions') chrome.runtime.openOptionsPage();
  if (/^(topics|cache|conv|data|handoff):/.test(msg.type)) {
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

// Version of what's kept in chrome.storage.local. Each step brings data saved by an older version up to date;
// add a step (and raise the number) whenever the stored shape changes.
const SCHEMA_VERSION = 1;
async function migrate() {
  const from = (await W.storage.get('schemaVersion')) || 0;
  if (from >= SCHEMA_VERSION) return;
  // 1: a topic's chats are deleted with it; remove those left behind by topics deleted earlier.
  if (from < 1) await W.topics.dropOrphanChats();
  await W.storage.set('schemaVersion', SCHEMA_VERSION);
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // New installs (e.g. a tester) start on the settings page to choose a model provider and paste a key.
  if (reason === 'install' && !(await W.settings.load()).apiKey) chrome.runtime.openOptionsPage();
  await migrate().catch((e) => console.warn('Wiki AI: storage update failed', e));
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
