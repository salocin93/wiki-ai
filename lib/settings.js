// Shared settings, stored in chrome.storage.local.
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});

  // scripts/package.sh blanks these two lines in tester builds, so they default to Gemini
  // and don't contain the gateway's address.
  const MY_GATEWAY = 'https://nrosen-mini.komodo-cirius.ts.net/v1';
  const DEFAULT_PROVIDER = 'gateway';

  // Where answers come from. Each preset fills in the connection fields; the key is kept per preset.
  const PRESETS = {
    gateway: {
      label: 'My local models (LiteLLM gateway on the tailnet)',
      baseUrl: MY_GATEWAY,
      model: 'pc/qwen3.6-35b-a3b',
      fallbackModel: 'mac/qwen3.5-9b-fast', // used when the main model answers 503 (PC off)
    },
    gemini: {
      label: 'Google Gemini API (free API key)',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      // Free quotas count per model, so a rate-limited main model hands over to the fallback.
      // Settings › Test connection picks another model if one of these is gone.
      model: 'gemini-3.5-flash-lite',
      fallbackModel: 'gemini-3.1-flash-lite',
    },
    custom: { label: 'Other OpenAI-compatible endpoint', baseUrl: '', model: '', fallbackModel: '' },
  };
  if (!MY_GATEWAY) delete PRESETS.gateway;

  const DEFAULTS = {
    provider: DEFAULT_PROVIDER,
    baseUrl: PRESETS[DEFAULT_PROVIDER].baseUrl,
    model: PRESETS[DEFAULT_PROVIDER].model,
    fallbackModel: PRESETS[DEFAULT_PROVIDER].fallbackModel,
    apiKey: '',
    apiKeys: {}, // provider → key, so switching presets doesn't lose keys
    contextTokens: 0, // 0 = pick a budget from the model name, see contextFor()
    maxAnswerTokens: 1200,
    temperature: 0.3,
    maxSteps: 6, // tool-calling rounds before forcing an answer
    disableThinking: true,
    answerLanguage: 'article', // 'article', 'question', or a language code such as 'en'
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
    // Free tiers also limit tokens per minute, so prompts stay moderate.
    if (isGemini(settings)) return /gemma/i.test(model) ? 16000 : 32000;
    if (model.startsWith('pc/')) return 48000;
    if (model.includes('saluki')) return 10000; // reads ~63 tok/s
    if (model.startsWith('mac/')) return 12000; // reads ~210 tok/s, so keep prompts small
    return 16000;
  }

  // The language answers, follow-ups and topic themes should be in: a code, or null for "the question's".
  function answerLanguage(settings, articleLang) {
    const choice = settings.answerLanguage || 'article';
    if (choice === 'question') return null;
    return choice === 'article' ? articleLang || 'en' : choice;
  }

  // "German" for "de": models follow plain English language names most reliably.
  function languageName(code) {
    try {
      return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
    } catch {
      return code;
    }
  }

  const isGemini = (settings) => /generativelanguage\.googleapis\.com/.test(settings.baseUrl || '');

  W.settings = { DEFAULTS, PRESETS, load, save, contextFor, isGemini, answerLanguage, languageName };
})(globalThis);
