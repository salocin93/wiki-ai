// Streaming client for any OpenAI-compatible /chat/completions endpoint (llama.cpp, Ollama, LM Studio, vLLM).
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});
  const TIMEOUT_MS = 240_000; // models load on demand; the first request can take over a minute

  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  // Each server spells "don't think" differently; unknown fields are dropped on a 400 retry.
  function thinkingOff(model, settings) {
    if (W.settings?.isGemini(settings)) {
      if (/gemma/i.test(model)) return {}; // Gemma's thinking is handled by splitting <thought> out
      if (/gemini-2\./i.test(model)) return { reasoning_effort: 'none' };
      return { reasoning_effort: 'low' }; // Gemini 3 can't switch thinking off; "low" keeps it short
    }
    return { chat_template_kwargs: { enable_thinking: false } };
  }

  function headers(settings) {
    const h = { 'Content-Type': 'application/json' };
    if (settings.apiKey) h.Authorization = `Bearer ${settings.apiKey}`;
    return h;
  }

  const RETRY_WAITS = [10, 30, 60]; // seconds, when a server says "too many requests" without saying how long

  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(signal.reason || new Error('Aborted'));
      });
    });

  // noWait: fail at once on a rate limit (the caller has another model to switch to).
  async function post(settings, body, signal, onWait, noWait) {
    let res;
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      res = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: headers(settings),
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      // Rate limits (and Gemini's "overloaded") are temporary: wait and try again a few times.
      const temporary = res.status === 429 || (res.status === 503 && W.settings?.isGemini(settings));
      if (!temporary || noWait || attempt >= RETRY_WAITS.length) break;
      const detail = res.status === 429 ? await res.clone().text().catch(() => '') : '';
      // A used-up daily quota won't come back by waiting.
      if (/per ?day|PerDay|daily/i.test(detail)) {
        throw new HttpError(429, `The daily free quota for ${body.model} is used up. Pick another model in the Wiki AI settings, or try again tomorrow.`);
      }
      // Gemini says how long to wait ("retryDelay": "41s"); others may send Retry-After.
      const asked = Number(detail.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/)?.[1] || res.headers.get('retry-after'));
      const wait = Number.isFinite(asked) && asked > 0 ? Math.min(Math.ceil(asked) + 1, 90) : RETRY_WAITS[attempt];
      onWait?.(wait);
      await sleep(wait * 1000, signal);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text;
      try {
        message = JSON.parse(text).error?.message || text;
      } catch {}
      throw new HttpError(res.status, `${res.status}: ${message.slice(0, 300) || res.statusText}`);
    }
    return res;
  }

  async function* sseEvents(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data);
        } catch {}
      }
    }
  }

  // Separates <think>…</think>, raw <tool_call> text and the <followups> block from what the reader should see.
  // Models mark their reasoning differently: Qwen uses <think>, Gemma <thought>.
  function splitContent(raw) {
    let reasoning = '';
    let visible = raw.replace(/<(think|thought|thinking|reasoning)>([\s\S]*?)(?:<\/\1>|$)/gi, (_, _tag, r) => {
      reasoning += r;
      return '';
    });
    visible = visible
      .replace(/<tool_call>[\s\S]*$/, '')
      .replace(/<follow[\s\S]*$/i, '') // follow-up questions are shown as buttons, not text
      .replace(/<\/?[a-z]{0,9}$/i, ''); // a tag still arriving
    return { visible: visible.replace(/^\s+/, ''), reasoning };
  }

  function mergeDeep(a, b) {
    for (const [k, v] of Object.entries(b)) {
      a[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergeDeep(a[k] && typeof a[k] === 'object' ? a[k] : {}, v) : v;
    }
    return a;
  }

  // Qwen's own format, for servers that don't parse tool calls into structured fields.
  function parseRawToolCalls(raw) {
    const calls = [];
    for (const m of raw.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
      try {
        const obj = JSON.parse(m[1]);
        calls.push({
          id: `raw_${calls.length}_${Date.now()}`,
          type: 'function',
          function: { name: obj.name, arguments: JSON.stringify(obj.arguments || {}) },
        });
      } catch {}
    }
    return calls;
  }

  /**
   * One streamed completion. onUpdate({answer, reasoning}) receives full snapshots, not deltas.
   * Returns {content, toolCalls, model}.
   */
  async function chat({ settings, model, messages, tools, maxTokens, json, onUpdate, onWait, noWait, signal }) {
    const body = {
      model,
      messages,
      stream: true,
      temperature: settings.temperature,
      max_tokens: maxTokens || settings.maxAnswerTokens,
    };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const extra = settings.disableThinking ? thinkingOff(model, settings) : {};
    // JSON mode where the endpoint has it; one that rejects it gets the plain request below.
    if (json) extra.response_format = { type: 'json_object' };

    let res;
    try {
      res = await post(settings, { ...body, ...extra }, signal, onWait, noWait);
    } catch (e) {
      if (e.status !== 400 || !Object.keys(extra).length) throw e;
      res = await post(settings, body, signal, onWait, noWait);
    }

    let raw = '';
    let reasoningField = '';
    const calls = [];
    for await (const evt of sseEvents(res)) {
      const delta = evt.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) raw += delta.content;
      if (delta.reasoning_content || delta.reasoning) reasoningField += delta.reasoning_content || delta.reasoning;
      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? calls.length;
        calls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name += tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
        // Provider data that must be sent back with the call, e.g. Gemini 3's thought signature
        // in extra_content.google.thought_signature. Without it Gemini rejects the next request.
        if (tc.extra_content) calls[i].extra_content = mergeDeep(calls[i].extra_content || {}, tc.extra_content);
      }
      if (delta.content || delta.reasoning_content || delta.reasoning) {
        const { visible, reasoning } = splitContent(raw);
        onUpdate?.({ answer: visible, reasoning: reasoningField + reasoning });
      }
    }

    let toolCalls = calls.filter((c) => c && c.function.name);
    toolCalls.forEach((c, i) => (c.id ||= `call_${i}_${Date.now()}`));
    if (!toolCalls.length) toolCalls = parseRawToolCalls(raw);
    const parts = splitContent(raw);
    return { content: parts.visible.trim(), reasoning: reasoningField + parts.reasoning, raw, toolCalls, model };
  }

  async function listModels(settings) {
    const res = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/models`, {
      headers: headers(settings),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new HttpError(res.status, `${res.status} ${res.statusText}`);
    const data = await res.json();
    return (data.data || []).map((m) => m.id.replace(/^models\//, '')); // Gemini lists "models/<id>"
  }

  // chat() on settings.model, switching to settings.fallbackModel when the main model is unavailable (503)
  // or rate-limited (429). Free tiers count quota per model, so switching beats waiting.
  async function chatWithFallback(opts) {
    const { settings, onFallback } = opts;
    const model = opts.model || settings.model;
    const fallback = settings.fallbackModel;
    const canSwitch = !!fallback && model !== fallback;
    try {
      return await W.llm.chat({ ...opts, model, noWait: canSwitch });
    } catch (e) {
      if (!canSwitch || (e.status !== 503 && e.status !== 429)) throw e;
      onFallback?.(fallback);
      return W.llm.chat({ ...opts, model: fallback });
    }
  }

  // Parses a JSON object out of model text that may include code fences or prose around it.
  function parseJSON(text) {
    const body = text.replace(/```(?:json)?/gi, '');
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('No JSON object in the model output');
    const raw = body.slice(start, end + 1);
    try {
      return JSON.parse(raw);
    } catch {
      return JSON.parse(repairJSON(raw));
    }
  }

  // Fixes the usual slips in model-written JSON: quotes inside strings left unescaped (German „…" quotes),
  // raw line breaks inside strings, and trailing commas.
  function repairJSON(raw) {
    let out = '';
    let inString = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        if (ch === '\\') {
          out += ch + (raw[++i] ?? '');
        } else if (ch === '"') {
          // A quote ends the string only where JSON can go on after a string.
          const next = raw.slice(i + 1).match(/^\s*(.)/)?.[1];
          if (!next || ',:}]'.includes(next)) {
            inString = false;
            out += ch;
          } else out += '\\"';
        } else if (ch === '\n' || ch === '\r') out += ' ';
        else out += ch;
      } else {
        if (ch === '"') inString = true;
        out += ch;
      }
    }
    return out.replace(/,\s*([}\]])/g, '$1');
  }

  // The questions in a <followups> block at the end of an answer.
  function parseFollowups(raw) {
    const block = raw.match(/<followups>([\s\S]*?)(?:<\/followups>|$)/i)?.[1] || '';
    return listItems(block);
  }

  // Questions are shown as plain button text, so Markdown emphasis and code marks are removed.
  const stripMarkdown = (t) =>
    t
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1');

  function listItems(text) {
    return text
      .split('\n')
      .map((l) => stripMarkdown(l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()))
      .filter((l) => l.length > 8 && l.length < 200 && l.endsWith('?'))
      .slice(0, 4);
  }

  W.llm = { parseFollowups, listItems, stripMarkdown, chat, chatWithFallback, parseJSON, listModels, HttpError, splitContent, parseRawToolCalls };
})(globalThis);
