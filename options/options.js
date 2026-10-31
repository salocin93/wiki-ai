const W = globalThis.WikiAI;
const FIELDS = ['provider', 'baseUrl', 'apiKey', 'model', 'fallbackModel', 'contextTokens', 'maxAnswerTokens', 'maxSteps', 'disableThinking'];
const HELP = {
  gateway: 'Your own models through the LiteLLM gateway. This device must be on your tailnet; the key is LITELLM_MASTER_KEY.',
  gemini: 'Get a free key at aistudio.google.com/apikey (sign in with a Google account, then "Create API key"). Free keys have rate limits, and Google may use free-tier requests to improve its products.',
  custom: 'Any endpoint that speaks the OpenAI chat completions API, with streaming and tool calling.',
};
const providerEl = document.getElementById('provider');
let apiKeys = {};
let currentProvider = 'gateway';
const status = document.getElementById('status');

function show(text, isError = false) {
  status.textContent = text;
  status.className = isError ? 'err' : '';
}

function read() {
  const out = {};
  for (const id of FIELDS) {
    const el = document.getElementById(id);
    out[id] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim();
  }
  return out;
}

async function init() {
  providerEl.innerHTML = Object.entries(W.settings.PRESETS)
    .map(([id, p]) => `<option value="${id}">${p.label}</option>`)
    .join('');
  const s = await W.settings.load();
  apiKeys = { ...(s.apiKeys || {}), [s.provider]: s.apiKey };
  currentProvider = s.provider;
  for (const id of FIELDS) {
    const el = document.getElementById(id);
    if (el.type === 'checkbox') el.checked = s[id];
    else el.value = s[id];
  }
  document.getElementById('providerHelp').textContent = HELP[s.provider] || '';
}

// Switching preset fills in its connection fields and swaps in the key saved for it.
providerEl.addEventListener('change', () => {
  apiKeys[currentProvider] = document.getElementById('apiKey').value.trim();
  currentProvider = providerEl.value;
  const preset = W.settings.PRESETS[currentProvider];
  for (const id of ['baseUrl', 'model', 'fallbackModel']) document.getElementById(id).value = preset[id];
  document.getElementById('apiKey').value = apiKeys[currentProvider] || '';
  document.getElementById('providerHelp').textContent = HELP[currentProvider] || '';
  document.getElementById('models').innerHTML = '';
  show('Paste the key for this provider, then Test connection and Save.');
});

document.getElementById('save').addEventListener('click', async () => {
  const s = read();
  apiKeys[s.provider] = s.apiKey;
  await W.settings.save({ ...s, apiKeys });
  show('Saved.');
});

// Sends a one-token request: gateways can route models (e.g. a "pc/*" wildcard) that /models doesn't list.
async function probe(settings, model) {
  const res = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) },
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    signal: AbortSignal.timeout(150_000), // the model may have to load first
  });
  if (res.ok) return 'answers';
  return res.status === 503 ? 'unavailable right now (503, e.g. the machine is off)' : `error ${res.status}`;
}

document.getElementById('test').addEventListener('click', async () => {
  const settings = { ...W.settings.DEFAULTS, ...read() };
  show('Connecting…');
  try {
    const models = await W.llm.listModels(settings);
    // Offer the usable names; a gateway also lists aliases meant for other clients.
    const relevant = settings.provider === 'gateway' ? models.filter((m) => /^(pc|mac)\//.test(m)) : models.filter((m) => !/embedding|aqa|imagen|veo|tts/i.test(m));
    const usable = [...new Set([settings.model, settings.fallbackModel, ...relevant])].filter(Boolean);
    document.getElementById('models').innerHTML = usable.map((m) => `<option value="${m}">`).join('');

    // Gemini's model line-up changes; if the chosen model is gone, pick the best one available.
    if (settings.provider === 'gemini' && !models.includes(settings.model)) {
      const prefer = [/^gemma-4-26b-a4b-it$/, /^gemma-4.*-it$/, /^gemma-\d.*-it$/, /flash-lite$/, /flash$/];
      const pick = prefer.map((re) => models.find((m) => re.test(m))).find(Boolean);
      if (pick) {
        document.getElementById('model').value = pick;
        show(`“${settings.model}” isn't available for this key, so “${pick}” is filled in. Click Save to use it.`, true);
        return;
      }
    }
    const results = [];
    for (const m of [settings.model, settings.fallbackModel].filter(Boolean)) {
      if (models.includes(m)) {
        results.push({ m, state: 'listed' });
        continue;
      }
      show(`Connected. Checking ${m} (can take a minute if it has to load)…`);
      results.push({ m, state: await probe(settings, m).catch((e) => `failed: ${e.message}`) });
    }
    const bad = results.filter((r) => r.state !== 'listed' && r.state !== 'answers');
    show(`Connected. ${results.map((r) => `${r.m}: ${r.state === 'listed' ? 'available' : r.state}`).join(' · ')}`, bad.length > 0);
  } catch (e) {
    const hint = settings.provider === 'gateway' ? 'Is this device on the tailnet, and is the key right?' : 'Is the key right?';
    show(`Failed: ${e.message}. ${hint}`, true);
  }
});

async function showStorage() {
  const s = await W.topics.handle({ type: 'cache:stats' });
  const mb = s.bytes != null ? ` · about ${(s.bytes / 1e6).toFixed(1)} MB used by the extension` : '';
  document.getElementById('storage').textContent = `${s.entries} cached Wikipedia responses · ${s.topics} saved topics${mb}`;
}

document.getElementById('clearCache').addEventListener('click', async () => {
  await W.topics.handle({ type: 'cache:clear' });
  showStorage();
});

init();
showStorage();
