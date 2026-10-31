// Shared settings, stored in chrome.storage.local.
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});

  const DEFAULTS = {
    baseUrl: 'https://nrosen-mini.komodo-cirius.ts.net/v1', // LiteLLM gateway on the tailnet
    model: 'pc/qwen3.6-35b-a3b',
    fallbackModel: 'mac/qwen3.5-9b-fast', // used when the main model answers 503 (PC off)
    apiKey: '',
    contextTokens: 0, // 0 = pick a budget from the model name, see contextFor()
    maxAnswerTokens: 1200,
    temperature: 0.3,
    maxSteps: 6, // tool-calling rounds before forcing an answer
    disableThinking: true,
  };

  async function load() {
    if (!g.chrome?.storage?.local) return { ...DEFAULTS };
    const stored = await chrome.storage.local.get('settings');
    return { ...DEFAULTS, ...(stored.settings || {}) };
  }

  async function save(settings) {
    await chrome.storage.local.set({ settings: { ...DEFAULTS, ...settings } });
  }

  // Prompt budget per model. Below the hard limits on purpose: reading 100k tokens takes minutes.
  function contextFor(settings, model) {
    if (settings.contextTokens > 0) return settings.contextTokens;
    if (model.startsWith('pc/')) return 48000;
    if (model.includes('saluki')) return 10000; // reads ~63 tok/s
    if (model.startsWith('mac/')) return 12000; // reads ~210 tok/s, so keep prompts small
    return 16000;
  }

  W.settings = { DEFAULTS, load, save, contextFor };
})(globalThis);
