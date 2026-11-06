// Shared settings, stored in chrome.storage.local.
const DEFAULT_PROVIDER = 'gemini';
// Where the privacy policy is published (linked from the panel's first-run notice and the settings page).
const PRIVACY_URL = 'https://github.com/salocin93/wiki-ai/blob/main/PRIVACY.md';

// Where answers come from. Each preset fills in the connection fields; the key is kept per preset.
const PRESETS = {
  gemini: {
    label: 'Google Gemini API (free API key)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // Free quotas count per model, so a rate-limited main model hands over to the fallback.
    // Settings › Test connection picks another model if one of these is gone.
    model: 'gemini-3.1-flash-lite',
    fallbackModel: 'gemini-3.5-flash-lite',
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
  verifyCitations: false, // a second model call per answer checks each cited sentence against its passages
  semanticSearch: false, // experimental: rank passages by meaning (embeddings) as well as by keywords
  embedBaseUrl: '', // empty = the chat endpoint above
  embedModel: '', // empty = gemini-embedding-001 on Gemini; a local server needs one, e.g. nomic-embed-text
  embedApiKey: '', // empty = the chat key, but only for the chat endpoint
  embedDocPrefix: '', // some models want 'search_document: ' before passages…
  embedQueryPrefix: '', // …and 'search_query: ' before questions
  embedDailyLimit: 0, // embedding requests per model per day: 0 = the default (1,000 on Gemini's free tier, none elsewhere), -1 = none
  embedMinScore: 0, // cosine floor for a passage to count as related; 0 = the default for the model (0.55 for Gemini, none otherwise), -1 = none
  answerLanguage: 'browser', // 'browser', 'article', 'question', or a language code such as 'en'
  answerLanguageChosen: false, // set once the reader picks a language in settings
};

/** @returns {Promise<Settings>} */
async function load() {
  if (!globalThis.chrome?.storage?.local) return { ...DEFAULTS };
  const stored = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...(stored.settings || {}) };
  // A preset that no longer exists keeps its saved address, models and key as a custom endpoint.
  if (!PRESETS[s.provider]) {
    const old = s.provider;
    s.provider = 'custom';
    s.apiKeys = { ...s.apiKeys, custom: s.apiKeys?.custom || s.apiKeys?.[old] || s.apiKey };
    s.connections = { ...s.connections, custom: s.connections?.custom || { baseUrl: s.baseUrl, model: s.model, fallbackModel: s.fallbackModel } };
  }
  // Saved values of the wrong type (older versions, damaged storage) fall back to the defaults.
  for (const k of ['provider', 'baseUrl', 'model', 'fallbackModel', 'apiKey', 'answerLanguage']) if (typeof s[k] !== 'string') s[k] = DEFAULTS[k];
  for (const k of ['apiKeys', 'connections']) if (!s[k] || typeof s[k] !== 'object' || Array.isArray(s[k])) s[k] = {};
  s.disableThinking = s.disableThinking !== false;
  s.verifyCitations = s.verifyCitations === true;
  s.semanticSearch = s.semanticSearch === true;
  s.embedDailyLimit = Number.isFinite(Number(s.embedDailyLimit)) ? Math.max(-1, Math.round(Number(s.embedDailyLimit))) : 0;
  s.embedMinScore = Number.isFinite(Number(s.embedMinScore)) ? Math.min(1, Math.max(-1, Number(s.embedMinScore))) : 0;
  for (const k of ['embedBaseUrl', 'embedModel', 'embedApiKey', 'embedDocPrefix', 'embedQueryPrefix']) if (typeof s[k] !== 'string') s[k] = DEFAULTS[k];
  // Numbers within what the settings page allows; an empty field (0) means the default, except for the
  // prompt budget, where 0 means "pick one for the model".
  const num = (v, min, max, fallback) => (Number(v) > 0 ? Math.min(max, Math.max(min, Math.round(Number(v)))) : fallback);
  s.maxSteps = num(s.maxSteps, 1, 12, DEFAULTS.maxSteps);
  s.maxAnswerTokens = num(s.maxAnswerTokens, 200, 32000, DEFAULTS.maxAnswerTokens);
  s.contextTokens = num(s.contextTokens, 2000, 1_000_000, 0);
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

// Rough token count: ~3.5 characters per token in alphabetic scripts, about one per character in Chinese,
// Japanese and Korean, which would otherwise be undercounted three- or fourfold.
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;
function estTokens(s) {
  const text = s || '';
  const wide = text.match(CJK)?.length || 0;
  return Math.ceil(wide + (text.length - wide) / 3.5);
}

// The reader's language, from the browser ("de-DE" → "de").
const browserLanguage = () => (globalThis.navigator?.language || 'en').split('-')[0].toLowerCase();

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

// This computer or the local network: the only places plain http may carry the key and the questions.
const PRIVATE_HOST = /^(localhost|.+\.localhost|.+\.local|.+\.lan|\[::1\]|\[f[cd][0-9a-f]{2}:.*\]|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i;

// Who receives the questions, for the reader: "Google (Gemini API)" or the endpoint's host.
function recipient(settings) {
  if (isGemini(settings)) return 'Google (Gemini API)';
  try {
    return new URL(settings.baseUrl).host;
  } catch {
    return 'the AI service set in the settings';
  }
}

// Why an endpoint address can't be used, or '' when it can.
function endpointProblem(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return 'The endpoint address is not a valid URL.';
  }
  if (url.protocol === 'https:') return '';
  if (url.protocol === 'http:' && PRIVATE_HOST.test(url.hostname)) return '';
  if (url.protocol === 'http:') return 'Plain http is only allowed for a server on this computer or your local network. Use an https address so your key and questions are encrypted.';
  return 'The endpoint address must start with https://.';
}

export const appSettings = { DEFAULTS, PRESETS, PRIVACY_URL, recipient, estTokens, load, save, contextFor, isGemini, endpointProblem, answerLanguage, languageName, browserLanguage };
