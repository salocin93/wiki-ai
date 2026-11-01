// Shared settings, stored in chrome.storage.local.
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});

  const DEFAULT_PROVIDER = 'gemini';

  // Where answers come from. Each preset fills in the connection fields; the key is kept per preset.
  const PRESETS = {
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

  const DEFAULTS = {
    provider: DEFAULT_PROVIDER,
    baseUrl: PRESETS[DEFAULT_PROVIDER].baseUrl,
    model: PRESETS[DEFAULT_PROVIDER].model,
    fallbackModel: PRESETS[DEFAULT_PROVIDER].fallbackModel,
    apiKey: '',
    apiKeys: {}, // provider → key, so switching presets doesn't lose keys
    connections: {}, // provider → { baseUrl, model, fallbackModel }, kept the same way
    contextTokens: 0, // 0 = pick a budget from the model name, see contextFor()
    maxAnswerTokens: 1200,
    temperature: 0.1, // low: answers should stick to the passages
    maxSteps: 6, // tool-calling rounds before forcing an answer
    disableThinking: true,
    answerLanguage: 'browser', // 'browser', 'article', 'question', or a language code such as 'en'
    answerLanguageChosen: false, // set once the reader picks a language in settings
  };

  async function load() {
    if (!g.chrome?.storage?.local) return { ...DEFAULTS };
    const stored = await chrome.storage.local.get('settings');
    const s = { ...DEFAULTS, ...(stored.settings || {}) };
    // A preset that no longer exists keeps its saved address, models and key as a custom endpoint.
    if (!PRESETS[s.provider]) {
      const old = s.provider;
      s.provider = 'custom';
      s.apiKeys = { ...s.apiKeys, custom: s.apiKeys?.custom || s.apiKeys?.[old] || s.apiKey };
      s.connections = { ...s.connections, custom: s.connections?.custom || { baseUrl: s.baseUrl, model: s.model, fallbackModel: s.fallbackModel } };
    }
    // Autosave may have stored an old default; only a language the reader picked overrides the default.
    if (!s.answerLanguageChosen) s.answerLanguage = DEFAULTS.answerLanguage;
    s.temperature = DEFAULTS.temperature; // not a setting in the UI; saved settings may hold an old default
    return s;
  }

  async function save(settings) {
    await chrome.storage.local.set({ settings: { ...DEFAULTS, ...settings } });
  }

  // Prompt budget per model. Below the hard limits on purpose: reading 100k tokens takes minutes.
  function contextFor(settings, model) {
    if (settings.contextTokens > 0) return settings.contextTokens;
    // Free tiers also limit tokens per minute, so prompts stay moderate.
    if (isGemini(settings)) return /gemma/i.test(model) ? 16000 : 32000;
    return 16000;
  }

  // The reader's language, from the browser ("de-DE" → "de").
  const browserLanguage = () => (g.navigator?.language || 'en').split('-')[0].toLowerCase();

  // The language answers, follow-ups and topic themes should be in: a code, or null for "the question's".
  function answerLanguage(settings, articleLang) {
    const choice = settings.answerLanguage || 'browser';
    if (choice === 'question') return null;
    if (choice === 'browser') return browserLanguage();
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

  W.settings = { DEFAULTS, PRESETS, load, save, contextFor, isGemini, answerLanguage, languageName, browserLanguage };
})(globalThis);
