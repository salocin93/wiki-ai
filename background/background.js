// Service worker: runs the agent (Wikipedia + LLM requests) on behalf of the sidebar in each tab.
importScripts(
  '../lib/settings.js',
  '../lib/cache.js',
  '../lib/bm25.js',
  '../lib/wiki.js',
  '../lib/llm.js',
  '../lib/agent.js'
);

const W = globalThis.WikiAI;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'wikiai-chat') return;
  let controller = null;
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
    if (msg.type !== 'ask') return;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    try {
      const settings = await W.settings.load();
      if (!settings.apiKey && settings.baseUrl.includes('ts.net')) {
        throw new Error('No API key set. Open the Wiki AI settings and paste your gateway key.');
      }
      await W.agent.run({ settings, page: msg.page, question: msg.question, history: msg.history, sources: msg.sources, emit, signal });
    } catch (e) {
      if (signal.aborted) emit({ type: 'done', stopped: true });
      else emit({ type: 'error', message: e.message || String(e) });
    }
  });

  port.onDisconnect.addListener(() => controller?.abort());
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'openOptions') chrome.runtime.openOptionsPage();
  if (msg.type === 'getSettings') {
    W.settings.load().then((s) => sendResponse({ model: s.model, fallbackModel: s.fallbackModel, hasKey: !!s.apiKey }));
    return true;
  }
});

function sendToTab(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {}); // not a Wikipedia article tab
}

chrome.runtime.onInstalled.addListener(() => {
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
