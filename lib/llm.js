// Streaming client for any OpenAI-compatible /chat/completions endpoint (llama.cpp, Ollama, LM Studio, vLLM).
import { appSettings } from './settings.js';
import { textUtil } from './text.js';

// How long a model may stay quiet, until its reply starts and between streamed chunks once it has. Local models load on
// demand, so the first request can take over a minute. Gemini sends nothing while it thinks, but with its thinking kept
// short the longest healthy wait measured is about 30 s, so it is stopped sooner and the fallback model gets its turn.
const timing = { firstReplyMs: 240_000, idleMs: 90_000, quickFirstReplyMs: 60_000, quickIdleMs: 45_000 };
const answersQuickly = (settings, model) => !!appSettings?.isGemini(settings) && !!settings.disableThinking && !/gemma/i.test(model);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Each server spells "don't think" differently; unknown fields are dropped on a 400 retry.
function thinkingOff(model, settings) {
  if (appSettings?.isGemini(settings)) {
    if (/gemma/i.test(model)) return {}; // Gemma's thinking is handled by splitting <thought> out
    if (/gemini-2\./i.test(model)) return { reasoning_effort: 'none' };
    return { reasoning_effort: 'low' }; // Gemini 3 can't switch thinking off; "low" keeps it short
  }
  return { chat_template_kwargs: { enable_thinking: false } };
}

// Throws before anything (the key included) is sent to an address that isn't allowed.
function headers(settings) {
  const problem = appSettings?.endpointProblem(settings.baseUrl || '');
  if (problem) throw new HttpError(0, problem);
  const h = { 'Content-Type': 'application/json' };
  if (settings.apiKey) h.Authorization = `Bearer ${settings.apiKey}`;
  return h;
}

const RETRY_WAITS = [10, 30, 60]; // seconds, when a server says "too many requests" without saying how long

// Finish reasons of a reply that stopped before its end: out of tokens, or a filter (Gemini can stop on recitation).
const CUT_SHORT = /length|max_tokens|filter|recitation|safety/i;

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason || new Error('Aborted'));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(undefined);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

// Gives up on a request when the server goes quiet: arm(ms) restarts the countdown.
function watchdog() {
  const ctrl = new AbortController();
  let timer = 0;
  return {
    signal: ctrl.signal,
    arm(ms) {
      clearTimeout(timer);
      // 504: a server gone quiet is unavailable, so another model may still answer (switchesModel).
      timer = setTimeout(() => ctrl.abort(new HttpError(504, `The model sent nothing for ${Math.round(ms / 1000)} s, so the request was stopped. Try again, or pick another model in the settings.`)), ms);
    },
    stop: () => clearTimeout(timer),
  };
}

// noWait: fail at once on a rate limit (the caller has another model to switch to).
// The response carries its watchdog (res.watchdog), which sseEvents keeps resetting while chunks arrive.
async function post(settings, body, signal, onWait, noWait) {
  let res;
  let dog;
  const quick = answersQuickly(settings, body.model);
  for (let attempt = 0; ; attempt++) {
    dog = watchdog();
    dog.arm(quick ? timing.quickFirstReplyMs : timing.firstReplyMs);
    try {
      res = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: headers(settings),
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, dog.signal]) : dog.signal,
      });
    } catch (e) {
      dog.stop();
      throw e;
    }
    // Rate limits (and Gemini's "overloaded") are temporary: wait and try again a few times.
    const temporary = res.status === 429 || (res.status === 503 && appSettings?.isGemini(settings));
    if (!temporary || noWait || attempt >= RETRY_WAITS.length) break;
    dog.stop();
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
    dog.stop();
    const text = await res.text().catch(() => '');
    let message = text;
    try {
      message = JSON.parse(text).error?.message || text;
    } catch {
      // not JSON: use the body as it is
    }
    throw new HttpError(res.status, `${res.status}: ${message.slice(0, 300) || res.statusText}`);
  }
  res.watchdog = dog;
  res.idleMs = quick ? timing.quickIdleMs : timing.idleMs;
  return res;
}

// The events of a server-sent event stream. An error the server reports inside the stream (Gemini and vLLM
// do, after a 200) is thrown with its message rather than ending in an empty answer.
async function* sseEvents(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const parse = (line) => {
    line = line.trim();
    if (!line.startsWith('data:')) return undefined;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return null;
    let evt;
    try {
      evt = JSON.parse(data);
    } catch {
      return undefined; // a keep-alive or a line the server split oddly
    }
    if (evt?.error) {
      const err = Array.isArray(evt.error) ? evt.error[0] : evt.error;
      throw new HttpError(Number(err?.code) || 500, `The model's server reported an error: ${String(err?.message || JSON.stringify(err)).slice(0, 300)}`);
    }
    return evt;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.watchdog?.arm(res.idleMs ?? timing.idleMs);
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const evt = parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (evt === null) {
          res.streamEnded = true;
          return;
        }
        if (evt) yield evt;
      }
    }
    // The last line may come without a line break.
    const evt = parse(buf + decoder.decode());
    if (evt === null) res.streamEnded = true;
    if (evt) yield evt;
  } finally {
    res.watchdog?.stop();
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
  return { visible: textUtil.noLongDash(visible).replace(/^\s+/, ''), reasoning: textUtil.noLongDash(reasoning) };
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
    } catch {
      // not a valid tool call: skip it
    }
  }
  return calls;
}

/**
 * One streamed completion. onUpdate({answer, reasoning}) receives full snapshots, not deltas.
 * Returns {content, toolCalls, model}.
 */
async function chat({ settings, model, messages, tools, maxTokens, json = false, onUpdate, onWait, noWait, signal }) {
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

  const startedAt = Date.now();
  let res;
  try {
    res = await post(settings, { ...body, ...extra }, signal, onWait, noWait);
  } catch (e) {
    // Retry without the extras only when the server objects to a field, not for every bad request (a prompt
    // that's too long would just fail twice).
    const aboutFields = /reasoning|chat_template|enable_thinking|response_format|json_object|unknown|unrecogni[sz]ed|unsupported|not supported|extra (fields|inputs)|invalid (field|argument|json payload)/i;
    if (e.status !== 400 || !Object.keys(extra).length || !aboutFields.test(e.message)) throw e;
    res = await post(settings, body, signal, onWait, noWait);
  }

  let raw = '';
  let reasoningField = '';
  let finish = '';
  let usage = null;
  const calls = [];
  for await (const evt of sseEvents(res)) {
    finish = evt.choices?.[0]?.finish_reason || finish;
    usage = evt.usage || usage;
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
      onUpdate?.({ answer: visible, reasoning: textUtil.noLongDash(reasoningField) + reasoning });
    }
  }

  // Sizes and timing only: never the prompt, the reply or the key.
  const dropped = !finish && !res.streamEnded; // the connection ended before the server said it had finished
  const cutOff = dropped || CUT_SHORT.test(finish);
  console[cutOff ? 'warn' : 'info']('Wiki AI: model reply', {
    model,
    finish: finish || (dropped ? 'cut off' : 'unknown'),
    seconds: (Date.now() - startedAt) / 1000,
    chars: raw.length,
    totalTokens: usage?.total_tokens,
    promptTokens: usage?.prompt_tokens,
  });
  // Half a JSON object is no use to anyone, and asking this model to repair it only spends another request. As an
  // error, it goes to the fallback model. So does any reply cut off with another model to switch to (noWait): the
  // reader hasn't seen it yet, and half a reply loses its citations and follow-ups. The token limit is the exception:
  // the other model has the same limit, so the caller asks again with more room. A server that never says it has
  // finished still works, as there's nothing to switch to.
  if ((json && cutOff) || (cutOff && noWait && !/length|max_tokens/i.test(finish))) throw new HttpError(503, `${model}'s reply was cut off. Try again.`);

  let toolCalls = calls.filter((c) => c && c.function.name);
  toolCalls.forEach((c, i) => (c.id ||= `call_${i}_${Date.now()}`));
  if (!toolCalls.length) toolCalls = parseRawToolCalls(raw);
  const parts = splitContent(raw);
  // A citation the cut went through ("[29") would read as a claim about the number 29.
  const content = cutOff ? parts.visible.trim().replace(/\s*[[【][^\]】]*$/, '') : parts.visible.trim();
  return { content, reasoning: textUtil.noLongDash(reasoningField) + parts.reasoning, raw, toolCalls, model, cutOff, finish: finish || (dropped ? 'cut off' : 'unknown') };
}

// A reply that reads as stopped early though the server said it had finished: an answer ends with its <followups>
// block, so one with neither that block nor a closing mark ("…German client states,") didn't get to the end.
function looksUnfinished({ content, raw }) {
  const text = (content || '').trim();
  return !!text && !/<follow/i.test(raw || '') && !/[.!?:;…。！？)）\]】"”'’»|*_`$~]$/u.test(text);
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

// The model to switch to when this one fails, or '' when there is none to switch to.
const fallbackFor = (settings, model) => (settings.fallbackModel && settings.fallbackModel !== model ? settings.fallbackModel : '');
// Unavailable (503), gone quiet (504), rate-limited (429) or withdrawn (404, as Gemini does with old models): another model may still answer.
const switchesModel = (e) => e?.status === 503 || e?.status === 504 || e?.status === 429 || e?.status === 404;

// chat() on settings.model, switching to settings.fallbackModel when the main model is unavailable (503)
// or rate-limited (429). Free tiers count quota per model, so switching beats waiting.
async function chatWithFallback(opts) {
  const { settings, onFallback } = opts;
  const model = opts.model || settings.model;
  const fallback = fallbackFor(settings, model);
  const startedAt = Date.now();
  try {
    return await llm.chat({ ...opts, model, noWait: !!fallback });
  } catch (e) {
    if (!fallback || !switchesModel(e)) throw e;
    console.warn('Wiki AI: model failed, switching', { model, fallback, status: e.status, seconds: (Date.now() - startedAt) / 1000, message: e.message });
    onFallback?.(fallback);
    return llm.chat({ ...opts, model: fallback });
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

function listItems(text) {
  return text
    .split('\n')
    .map((l) => textUtil.noLongDash(textUtil.plain(l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())))
    .filter((l) => l.length > 8 && l.length < 200 && l.endsWith('?'))
    .slice(0, 4);
}

export const llm = { timing, fallbackFor, switchesModel, looksUnfinished, sseEvents, parseFollowups, listItems, chat, chatWithFallback, parseJSON, listModels, HttpError, splitContent, parseRawToolCalls };
