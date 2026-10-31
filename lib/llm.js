// Streaming client for any OpenAI-compatible /chat/completions endpoint (LiteLLM, llama.cpp, Ollama, LM Studio).
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
  function thinkingOff(model) {
    if (model.endsWith('-fast')) return {};
    if (model.startsWith('mac/')) return { reasoning_effort: 'none' };
    return { chat_template_kwargs: { enable_thinking: false } };
  }

  function headers(settings) {
    const h = { 'Content-Type': 'application/json' };
    if (settings.apiKey) h.Authorization = `Bearer ${settings.apiKey}`;
    return h;
  }

  async function post(settings, body, signal) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const res = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: headers(settings),
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
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
  function splitContent(raw) {
    let reasoning = '';
    let visible = raw.replace(/<think>([\s\S]*?)(?:<\/think>|$)/g, (_, r) => {
      reasoning += r;
      return '';
    });
    visible = visible
      .replace(/<tool_call>[\s\S]*$/, '')
      .replace(/<follow[\s\S]*$/i, '') // follow-up questions are shown as buttons, not text
      .replace(/<(\/?t?h?i?n?k?|f(o(l(l(o(w(u(p(s)?)?)?)?)?)?)?)?)$/i, '');
    return { visible: visible.replace(/^\s+/, ''), reasoning };
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
  async function chat({ settings, model, messages, tools, maxTokens, onUpdate, signal }) {
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
    const extra = settings.disableThinking ? thinkingOff(model) : {};

    let res;
    try {
      res = await post(settings, { ...body, ...extra }, signal);
    } catch (e) {
      if (e.status !== 400 || !Object.keys(extra).length) throw e;
      res = await post(settings, body, signal);
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
      }
      if (delta.content || delta.reasoning_content || delta.reasoning) {
        const { visible, reasoning } = splitContent(raw);
        onUpdate?.({ answer: visible, reasoning: reasoningField + reasoning });
      }
    }

    let toolCalls = calls.filter((c) => c && c.function.name);
    toolCalls.forEach((c, i) => (c.id ||= `call_${i}_${Date.now()}`));
    if (!toolCalls.length) toolCalls = parseRawToolCalls(raw);
    return { content: splitContent(raw).visible.trim(), raw, toolCalls, model };
  }

  async function listModels(settings) {
    const res = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/models`, {
      headers: headers(settings),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new HttpError(res.status, `${res.status} ${res.statusText}`);
    const data = await res.json();
    return (data.data || []).map((m) => m.id);
  }

  // chat() on settings.model, retried once on settings.fallbackModel when the main model answers 503.
  async function chatWithFallback(opts) {
    const { settings, onFallback } = opts;
    const model = opts.model || settings.model;
    try {
      return await W.llm.chat({ ...opts, model });
    } catch (e) {
      const fallback = settings.fallbackModel;
      if (e.status !== 503 || !fallback || model === fallback) throw e;
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
      return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')); // trailing commas
    }
  }

  // The questions in a <followups> block at the end of an answer.
  function parseFollowups(raw) {
    const block = raw.match(/<followups>([\s\S]*?)(?:<\/followups>|$)/i)?.[1] || '';
    return listItems(block);
  }

  function listItems(text) {
    return text
      .split('\n')
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
      .filter((l) => l.length > 8 && l.length < 200 && l.endsWith('?'))
      .slice(0, 4);
  }

  W.llm = { parseFollowups, listItems, chat, chatWithFallback, parseJSON, listModels, HttpError, splitContent, parseRawToolCalls };
})(globalThis);
