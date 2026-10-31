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

document.getElementById('test').addEventListener('click', async () => {
  show('Connecting…');
  try {
    const models = await W.llm.listModels({ ...W.settings.DEFAULTS, ...read() });
    document.getElementById('models').innerHTML = models.map((m) => `<option value="${m}">`).join('');
    const { model, fallbackModel } = read();
    const missing = [model, fallbackModel].filter((m) => m && !models.includes(m));
    show(`Connected: ${models.length} models.${missing.length ? ` Not listed: ${missing.join(', ')}` : ''}`, missing.length > 0);
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
