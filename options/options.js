// The settings page: model provider, key, answer options and stored data.
import { appSettings } from '../lib/settings.js';
import { llm } from '../lib/llm.js';
import { textUtil } from '../lib/text.js';

/** @type {(id: string) => any} */ // form controls of several kinds
const $ = (id) => document.getElementById(id);
const { esc } = textUtil;

const ABOUT = {
  gemini: { title: 'Google Gemini', blurb: "Google's API with a free key" },
  custom: { title: 'Other provider', blurb: 'Any OpenAI-compatible endpoint' },
};
const HELP = {
  gemini: 'Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>: sign in, then "Create API key". Free keys have per-minute and daily limits, and Google may use free-tier requests to improve its products.',
  custom: 'Any endpoint that speaks the OpenAI chat completions API with streaming and tool calling. Enter its address under Advanced connection, then click Test connection: the browser asks once to let Wiki AI reach it.',
};
const NUMBER_FIELDS = ['maxSteps', 'maxAnswerTokens', 'contextTokens'];
const LANGUAGES = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'pl', 'sv', 'da', 'nb', 'fi', 'cs', 'ru', 'uk', 'tr', 'ja', 'zh', 'ko', 'ar'];

// Each language in its own name ("Deutsch"), with the English name alongside.
function languageOptions() {
  const own = (code) => {
    try {
      return new Intl.DisplayNames([code], { type: 'language' }).of(code);
    } catch {
      return code;
    }
  };
  const mine = appSettings.browserLanguage();
  return [
    `<option value="browser">My language (${esc(own(mine))}, from the browser)</option>`,
    `<option value="article">Same as the Wikipedia article</option>`,
    `<option value="question">Same as my question</option>`,
    ...LANGUAGES.map((c) => {
      const name = own(c);
      const english = appSettings.languageName(c);
      return `<option value="${c}">${esc(name)}${name.toLowerCase() === english.toLowerCase() ? '' : ` · ${esc(english)}`}</option>`;
    }),
  ].join('');
}
const OTHER = '__other__';

let settings = null;
let apiKeys = {};
let models = []; // what the provider's /models returned

// ---------- Saving ----------

function collect() {
  const out = { ...settings, apiKeys: { ...apiKeys, [settings.provider]: $('apiKey').value.trim() } };
  out.apiKey = out.apiKeys[settings.provider];
  out.baseUrl = $('baseUrl').value.trim();
  out.model = $('model').value === OTHER ? settings.model : $('model').value;
  out.fallbackModel = $('fallbackModel').value === OTHER ? settings.fallbackModel : $('fallbackModel').value;
  out.disableThinking = $('disableThinking').checked;
  out.verifyCitations = $('verifyCitations').checked;
  out.answerLanguage = $('answerLanguage').value;
  out.answerLanguageChosen = settings.answerLanguageChosen;
  for (const id of NUMBER_FIELDS) out[id] = Number($(id).value) || 0;
  return out;
}

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    settings = collect();
    apiKeys = settings.apiKeys;
    await appSettings.save(settings);
    const el = $('saved');
    el.textContent = 'Saved';
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 1400);
  }, 350);
}

// ---------- Connection status ----------

function connection(state, text) {
  $('connDot').className = `dot ${state}`;
  $('connText').textContent = text;
  $('connection').classList.toggle('err', state === 'err');
}

// ---------- Provider cards ----------

function renderProviders() {
  $('providers').innerHTML = Object.keys(appSettings.PRESETS)
    .map(
      (id) => `<button type="button" class="provider" role="radio" aria-checked="${id === settings.provider}" data-id="${id}">
        <strong>${esc(ABOUT[id]?.title || appSettings.PRESETS[id].label)}</strong><span>${esc(ABOUT[id]?.blurb || '')}</span>
      </button>`
    )
    .join('');
  $('providerHelp').innerHTML = HELP[settings.provider] || '';
}

$('providers').addEventListener('click', (e) => {
  const card = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('.provider'));
  if (!card || card.dataset.id === settings.provider) return;
  apiKeys[settings.provider] = $('apiKey').value.trim();
  // Each provider keeps its own address and models, so switching back restores them.
  const { baseUrl, model, fallbackModel } = collect();
  const connections = { ...settings.connections, [settings.provider]: { baseUrl, model, fallbackModel } };
  const conn = connections[card.dataset.id] || appSettings.PRESETS[card.dataset.id];
  settings = { ...settings, connections, provider: card.dataset.id, baseUrl: conn.baseUrl, model: conn.model, fallbackModel: conn.fallbackModel };
  $('baseUrl').value = conn.baseUrl;
  $('apiKey').value = apiKeys[settings.provider] || '';
  models = [];
  renderProviders();
  fillModels();
  scheduleSave();
  if (settings.provider === 'custom') $('baseUrl').closest('details').open = true;
  refreshModels();
});

// ---------- Model dropdowns ----------

function fillSelect(select, current, { allowNone }) {
  const options = [];
  if (allowNone) options.push(`<option value="">None</option>`);
  if (current && !models.includes(current)) options.push(`<option value="${esc(current)}">${esc(current)}${models.length ? ' (not listed)' : ''}</option>`);
  for (const m of models) options.push(`<option value="${esc(m)}">${esc(m)}</option>`);
  options.push(`<option value="${OTHER}">Other…</option>`);
  select.innerHTML = options.join('');
  select.value = current || '';
  select.dataset.previous = select.value;
}

function fillModels() {
  fillSelect($('model'), settings.model, { allowNone: false });
  fillSelect($('fallbackModel'), settings.fallbackModel, { allowNone: true });
}

for (const id of ['model', 'fallbackModel']) {
  $(id).addEventListener('change', () => {
    const select = $(id);
    if (select.value === OTHER) {
      const name = (prompt('Model name, exactly as the provider calls it:') || '').trim();
      if (!name) {
        select.value = select.dataset.previous;
        return;
      }
      settings[id] = name;
      fillModels();
    } else settings[id] = select.value;
    select.dataset.previous = select.value;
    scheduleSave();
  });
}

// Gemini's line-up changes; if a chosen model is gone, pick the best available one.
function pickGemini(current, avoid) {
  if (models.includes(current) && current !== avoid) return current;
  const prefer = [/^gemini-3\.5-flash-lite$/, /^gemini-3\.\d+-flash-lite$/, /^gemini-\d.*flash-lite$/, /^gemma-4.*-it$/, /flash$/];
  return prefer.flatMap((re) => models.filter((m) => re.test(m) && m !== avoid))[0] || current;
}

let loadId = 0;
async function refreshModels({ probe = false } = {}) {
  const s = collect();
  if (!s.baseUrl) return connection('', 'Enter the endpoint address under Advanced connection.');
  if (!s.apiKey && s.provider !== 'custom') return connection('', 'Paste your key to load the available models.');
  const id = ++loadId;
  connection('busy', 'Loading models…');
  try {
    const listed = await llm.listModels(s);
    if (id !== loadId) return;
    // Leave out models that can't chat (embeddings, image and video generation, speech).
    models = listed.filter((m) => !/embed|imagen|veo|tts|aqa|image-generation|lyria/i.test(m)).sort();
    let note = '';
    if (s.provider === 'gemini') {
      const model = pickGemini(settings.model);
      const fallback = settings.fallbackModel ? pickGemini(settings.fallbackModel, model) : '';
      if (model !== settings.model || fallback !== settings.fallbackModel) {
        note = ` Picked ${[model !== settings.model && model, fallback !== settings.fallbackModel && fallback].filter(Boolean).join(' and ')} because the previous choice isn't available.`;
        settings.model = model;
        settings.fallbackModel = fallback;
        scheduleSave();
      }
    }
    fillModels();
    let text = `Connected · ${models.length} models available.${note}`;
    let state = note ? 'warn' : 'ok';
    // Some servers route models they don't list; a one-token request checks those.
    const unlisted = [settings.model, settings.fallbackModel].filter((m) => m && !models.includes(m));
    if (probe && unlisted.length) {
      const results = [];
      for (const m of unlisted) {
        connection('busy', `Checking ${m} (can take a minute if it has to load)…`);
        results.push(`${m}: ${await probeModel(s, m)}`);
      }
      if (id !== loadId) return;
      text += ` ${results.join(' · ')}`;
      if (results.some((r) => !r.endsWith('answers'))) state = 'warn';
    } else if (unlisted.length) text += ` Not in the list: ${unlisted.join(', ')} (Test connection checks them).`;
    connection(state, text);
  } catch (e) {
    if (id !== loadId) return;
    models = [];
    fillModels();
    const hint = s.provider === 'custom' ? 'Is the address right, and did you allow Wiki AI to reach it (Test connection)?' : 'Is the key right?';
    connection('err', `Couldn't load models: ${e.message}. ${hint}`);
  }
}

async function probeModel(s, model) {
  const problem = appSettings.endpointProblem(s.baseUrl);
  if (problem) return `not checked: ${problem}`;
  try {
    const res = await fetch(`${s.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}) },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(150_000), // the model may have to load first
    });
    if (res.ok) return 'answers';
    if (res.status === 429) return 'rate-limited right now';
    return res.status === 503 ? 'unavailable right now (e.g. the machine is off)' : `error ${res.status}`;
  } catch (e) {
    return `failed: ${e.message}`;
  }
}

// ---------- Other fields ----------

let keyTimer = 0;
$('apiKey').addEventListener('input', () => {
  scheduleSave();
  clearTimeout(keyTimer);
  keyTimer = setTimeout(() => refreshModels(), 700);
});
$('baseUrl').addEventListener('change', () => {
  scheduleSave();
  refreshModels();
});
$('toggleKey').addEventListener('click', () => {
  const hidden = $('apiKey').type === 'password';
  $('apiKey').type = hidden ? 'text' : 'password';
  $('toggleKey').textContent = hidden ? 'Hide' : 'Show';
});
$('test').addEventListener('click', async () => {
  const s = collect();
  const problem = s.baseUrl && appSettings.endpointProblem(s.baseUrl);
  if (problem) return connection('err', problem);
  if (s.baseUrl && !(await allowEndpoint(s.baseUrl))) return connection('err', `Wiki AI isn't allowed to reach ${s.baseUrl}. Click Test connection again and choose Allow.`);
  refreshModels({ probe: true });
});

// Wikipedia and Gemini are allowed in the manifest; any other server (this computer's too) needs the
// reader's permission, which the browser only asks for during a click.
async function allowEndpoint(baseUrl) {
  if (!globalThis.chrome?.permissions) return true;
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  try {
    return await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
  } catch {
    return false;
  }
}
for (const id of ['disableThinking', 'verifyCitations', ...NUMBER_FIELDS]) $(id).addEventListener('change', scheduleSave);
$('answerLanguage').addEventListener('change', () => {
  settings.answerLanguageChosen = true; // from now on this choice wins over the default
  scheduleSave();
});

// ---------- Storage ----------

// Through the service worker: it keeps parts of the cache in memory too, and queues writes from all tabs.
async function data(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (res?.error) throw new Error(res.error);
  return res?.result;
}

async function showStorage() {
  const s = await data({ type: 'cache:stats' });
  const mb = s.bytes != null ? ` · about ${(s.bytes / 1e6).toFixed(1)} MB in total` : '';
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  $('storage').textContent = `${count(s.entries, 'cached Wikipedia response', 'cached Wikipedia responses')} · ${count(s.topics, 'saved topic', 'saved topics')}${mb}`;
}
$('clearCache').addEventListener('click', async () => {
  await data({ type: 'cache:clear' });
  showStorage();
});
$('clearTopics').addEventListener('click', async () => {
  const n = (await data({ type: 'topics:list' })).length;
  if (!n || !confirm(`Delete all ${n} saved topic${n > 1 ? 's' : ''} and the chats in them? Chats about single articles stay.`)) return;
  await data({ type: 'topics:clear' });
  showStorage();
});
// Starts over with no topics, chats or cached articles; settings and keys stay. Used to sit in the sidebar header.
$('clearAll').addEventListener('click', async () => {
  if (!confirm("Delete all topics, all chats and the article cache? Your settings and API keys stay. This can't be undone.")) return;
  await data({ type: 'data:clear' });
  showStorage();
});

// ---------- Start ----------

(async function init() {
  $('version').innerHTML = `Wiki AI ${esc(chrome.runtime.getManifest().version)} · <a href="${esc(appSettings.PRIVACY_URL)}" target="_blank" rel="noopener noreferrer">Privacy policy</a>`;
  settings = await appSettings.load();
  if (!appSettings.PRESETS[settings.provider]) settings = { ...settings, provider: Object.keys(appSettings.PRESETS)[0] };
  apiKeys = { ...(settings.apiKeys || {}), [settings.provider]: settings.apiKey };
  $('apiKey').value = settings.apiKey || '';
  $('baseUrl').value = settings.baseUrl || '';
  $('disableThinking').checked = settings.disableThinking;
  $('verifyCitations').checked = settings.verifyCitations;
  $('answerLanguage').innerHTML = languageOptions();
  $('answerLanguage').value = settings.answerLanguage || 'browser';
  for (const id of NUMBER_FIELDS) $(id).value = settings[id];
  renderProviders();
  fillModels();
  refreshModels();
  showStorage();
})();
