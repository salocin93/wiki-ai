const W = globalThis.WikiAI;
const FIELDS = ['baseUrl', 'apiKey', 'model', 'fallbackModel', 'contextTokens', 'maxAnswerTokens', 'maxSteps', 'disableThinking'];
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
  const s = await W.settings.load();
  for (const id of FIELDS) {
    const el = document.getElementById(id);
    if (el.type === 'checkbox') el.checked = s[id];
    else el.value = s[id];
  }
}

document.getElementById('save').addEventListener('click', async () => {
  await W.settings.save(read());
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
    // Offer the usable names; the gateway also lists aliases meant for other clients.
    const usable = [...new Set([settings.model, settings.fallbackModel, ...models.filter((m) => /^(pc|mac)\//.test(m))])].filter(Boolean);
    document.getElementById('models').innerHTML = usable.map((m) => `<option value="${m}">`).join('');
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
    show(`Failed: ${e.message}. Is this device on the tailnet, and is the key right?`, true);
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
