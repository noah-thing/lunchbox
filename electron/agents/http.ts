import { totalmem } from 'node:os'
import type { Act, Usage } from '../../shared/types'
import type { Tool } from '../hands'
import { specs, use, type Bench } from './bench'
import { Sieve, manual, readCall, schema, unthink } from './textcalls'
import { cacheSaving, claudeCost, readSaving } from '../../shared/prices'

// extra: headers a connector's server wants on every request, such as a plan or project id.
// unload: free the model from memory as soon as it answers, for people who need the RAM back.
type Provider = { base: string; style: 'anthropic' | 'openai' | 'google' | 'ollama'; prefer: RegExp; extra?: Record<string, string>; unload?: boolean }

export const PROVIDERS: Record<string, Provider> = {
  anthropic: { base: 'https://api.anthropic.com/v1', style: 'anthropic', prefer: /sonnet/ },
  openai: { base: 'https://api.openai.com/v1', style: 'openai', prefer: /^gpt-[\d.]+$/ },
  xai: { base: 'https://api.x.ai/v1', style: 'openai', prefer: /^grok-\d/ },
  openrouter: { base: 'https://openrouter.ai/api/v1', style: 'openai', prefer: /^openrouter\/auto$/ },
  google: { base: 'https://generativelanguage.googleapis.com/v1beta', style: 'google', prefer: /flash/ },
  ollama: { base: 'http://127.0.0.1:11434/api', style: 'ollama', prefer: /./ },
  lmstudio: { base: 'http://127.0.0.1:1234/v1', style: 'openai', prefer: /./ },
  llamacpp: { base: 'http://127.0.0.1:8080/v1', style: 'openai', prefer: /./ },
}

function headers(p: Provider, key: string): Record<string, string> {
  const base: Record<string, string> = p.style === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    : p.style === 'openai' && key ? { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
    : { 'content-type': 'application/json' }
  // A header the person set wins over the default of the same name, so a server that wants its
  // key under another name, or no Bearer prefix, can have it that way.
  const out = { ...base }
  for (const [k, v] of Object.entries(p.extra ?? {})) {
    for (const d of Object.keys(out)) if (d.toLowerCase() === k.toLowerCase()) delete out[d]
    out[k] = v
  }
  return out
}

// "Name: value", one a line. Blank lines and lines starting with # are skipped, and a line that
// is not a valid header is ignored rather than breaking every request.
export function parseHeaders(text = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*:\s*(.*?)\s*$/)
    if (!m || line.trim().startsWith('#') || /[\r\n]/.test(m[2])) continue
    out[m[1]] = m[2]
  }
  return out
}

async function failure(res: Response) {
  const body = await res.text().catch(() => '')
  let message = body.slice(0, 300)
  try {
    const j = JSON.parse(body)
    message = j.error?.message ?? j.error ?? j.message ?? message
  } catch {}
  return new Error(`${res.status} ${typeof message === 'string' ? message : JSON.stringify(message)}`.trim())
}

// Something else can be listening where a local server is expected. Only an answer in the
// server's own shape counts as that server being there.
const listed = (list: unknown) => { if (!Array.isArray(list)) throw new Error('The address answered, but not like a model server'); return list }

export async function listModels(name: string, key: string): Promise<string[]> {
  const p = await reach(PROVIDERS[name])
  const signal = AbortSignal.timeout(p.base.startsWith('http://127.') ? 1500 : 8000)
  if (p.style === 'ollama') {
    const res = await fetch(`${p.base}/tags`, { signal })
    if (!res.ok) throw await failure(res)
    return listed((await res.json()).models).map((m: { name: string }) => m.name)
  }
  if (p.style === 'google') {
    const res = await fetch(`${p.base}/models?key=${encodeURIComponent(key)}&pageSize=200`, { signal })
    if (!res.ok) throw await failure(res)
    return ((await res.json()).models ?? [])
      .filter((m: { supportedGenerationMethods?: string[] }) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m: { name: string }) => m.name.replace(/^models\//, ''))
  }
  const res = await fetch(`${p.base}/models`, { headers: headers(p, key), signal })
  if (!res.ok) throw await failure(res)
  // Only models that chat: embedding, speech, image and moderation models fail on chat requests.
  return listed((await res.json()).data).map((m: { id: string }) => m.id).filter((id: string) => !/embed|whisper|tts|dall|image|moderation|audio|realtime|transcribe|search-preview/i.test(id)).sort().reverse()
}

// Ollama runs every model with a small context window unless told otherwise, and quietly cuts the
// start of anything longer. A room's instructions and history are longer, so the model lost them
// and answered with nothing or stopped mid answer. Each request asks for room to fit, capped at
// what the model supports and at a size this computer can hold in memory beside the model.
export function roomFor(limit: number, memoryGb = totalmem() / 2 ** 30) {
  const most = memoryGb <= 12 ? 8192 : memoryGb <= 24 ? 16384 : 32768
  return limit > 0 ? Math.min(most, limit) : most
}

type Local = { window: number; tools: boolean | null }
const locals = new Map<string, Local>()
// What Ollama says about a model: how much it can hold, and whether it has tool calling built in.
// Null for tools means the server did not say, and the first request finds out.
async function ollamaInfo(base: string, model: string, signal?: AbortSignal): Promise<Local> {
  const key = `${base} ${model}`
  if (locals.has(key)) return locals.get(key)!
  let info: Local = { window: roomFor(0), tools: null }
  try {
    const res = await fetch(`${base}/show`, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) })
    if (!res.ok) return info
    const o = await res.json()
    const fields = o.model_info ?? {}
    const length = Object.keys(fields).find((k) => k.endsWith('.context_length'))
    info = { window: roomFor(length ? Number(fields[length]) : 0), tools: Array.isArray(o.capabilities) ? o.capabilities.includes('tools') : null }
    locals.set(key, info)
  } catch {}
  return info
}

// An Ollama server reached through its OpenAI style address answers with whatever context window
// it defaults to, and nothing in that API can raise it, so a room's instructions fall off the
// front after a few messages. Lunchbox talks to such a server in Ollama's own way instead. It is
// known by its port, 11434, and asked once to confirm.
const natives = new Map<string, string | null>()
async function ollamaBehind(base: string) {
  if (!/^https?:\/\/[^/]+:11434(\/|$)/i.test(base)) return null
  if (natives.has(base)) return natives.get(base)!
  let found: string | null = null
  try {
    const origin = new URL(base).origin
    const res = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(1500) })
    if (res.ok && typeof (await res.json()).version === 'string') found = `${origin}/api`
  } catch {}
  // Not remembered when the server was off: it may be Ollama once it is started.
  if (found) natives.set(base, found)
  return found
}

// The provider as it will be spoken to: an Ollama server added as an OpenAI style connector, or
// with a bare address, is spoken to natively.
async function reach(p: Provider): Promise<Provider> {
  if (p.style !== 'openai') return p
  const native = await ollamaBehind(p.base)
  return native ? { ...p, base: native, style: 'ollama' } : p
}

// The address a built in local server is reached at, when it is not the usual one on this
// computer: another port, another machine on the network, a container. A bare host gets http and
// the server's usual port, the way OLLAMA_HOST is written.
const DEFAULTS: Record<string, string> = {}
export function setBase(name: string, address = '') {
  const p = PROVIDERS[name]
  if (!p) return
  DEFAULTS[name] ??= p.base
  const usual = new URL(DEFAULTS[name])
  let base = DEFAULTS[name]
  const typed = address.trim().replace(/\/+$/, '')
  if (typed) {
    try {
      const u = new URL(/^https?:\/\//i.test(typed) ? typed : `http://${typed}`)
      if (u.hostname === '0.0.0.0') u.hostname = '127.0.0.1'
      if (!u.port && u.protocol === 'http:') u.port = usual.port
      base = u.origin + (/^\/(api|v1)$/.test(u.pathname) || u.pathname === '/' ? usual.pathname : u.pathname)
    } catch {}
  }
  p.base = base
  natives.clear()
  locals.clear()
}

async function pick(name: string, key: string, model: string) {
  if (model) return model
  const all = await listModels(name, key)
  const m = all.find((id) => PROVIDERS[name].prefer.test(id)) ?? all[0]
  if (!m) throw new Error('No model available. Choose one in Agents.')
  return m
}

const local = (base: string) => /^http:\/\/(127\.|localhost|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(base) || /^http:\/\/[^/]*\.local(:|\/|$)/i.test(base)

// A request that stops answering is given up on: a model still loading gets ten minutes on this
// computer, a server on the internet three. Without this a stalled stream holds the room's whole
// queue until the person presses stop.
async function post(url: string, init: RequestInit, a: { signal: AbortSignal; stalled?: boolean }, firstMs: number) {
  const ctl = new AbortController()
  const stop = () => ctl.abort()
  if (a.signal.aborted) stop()
  a.signal.addEventListener('abort', stop, { once: true })
  const stall = () => { a.stalled = true; stop() }
  let timer = setTimeout(stall, firstMs)
  const beat = (ms: number) => { clearTimeout(timer); timer = setTimeout(stall, ms) }
  const end = () => { clearTimeout(timer); a.signal.removeEventListener('abort', stop) }
  try {
    return { res: await fetch(url, { ...init, signal: ctl.signal }), beat, end }
  } catch (e) {
    end()
    throw e
  }
}

// Server-sent events and Ollama's newline-delimited JSON both arrive as lines.
async function* lines(res: Response, beat?: () => void) {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    beat?.()
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) yield line
    }
  }
  if (buf.trim()) yield buf.trim()
}

// The conversation as one user message ahead of the task, so its text is an unchanged prefix.
const turnsOf = (history: string[]) => (history.length ? [{ role: 'user', content: history.join('\n\n') }] : [])

const data = (line: string) => {
  const raw = line.startsWith('data:') ? line.slice(5).trim() : line
  if (!raw || raw === '[DONE]' || line.startsWith('event:')) return null
  try { return JSON.parse(raw) } catch { return null }
}

type Block = { type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: '1h' } }

// One block per message of the conversation and a breakpoint on the last one. The next turn
// finds that breakpoint again within the 20 block lookback and reads everything before it from
// cache; only the new messages, the memory and the task are billed in full. A second mark sits on
// the last block of the previous step of 20, so a busy room still finds its earlier prefix.
function marked(history: string[]): Block[] {
  const blocks: Block[] = history.map((text) => ({ type: 'text', text }))
  for (const i of new Set([blocks.length - 1, 20 * Math.floor((blocks.length - 1) / 20) - 1])) if (i >= 0) blocks[i].cache_control = { type: 'ephemeral' }
  return blocks
}

type Spec = Pick<Tool, 'name' | 'description' | 'input' | 'required'>
type Call = { id: string; name: string; args: Record<string, unknown>; bad?: string }
type Round = { text: string; calls: Call[]; thought: boolean }
type Outcome = { call: Call; text: string; ok: boolean }
type Ask = { p: Provider; name: string; id: string; key: string; system: string; prompt: string; history: string[]; cacheKey: string; signal: AbortSignal; usage: Usage; onDelta(d: string): void; waiting(first: boolean): void; stalled?: boolean }

// One conversation with one provider, in that provider's own shape. send asks for the next
// answer; results hands back what the tools returned; say adds a plain message, which is how a
// model without tool calling of its own gets its results.
type Wire = {
  send(tools: Spec[] | null, format?: object): Promise<Round>
  results(list: Outcome[]): void
  say(text: string): void
  // Whether this server can hold a reply to a JSON shape.
  shaped: boolean
}

const jsonArgs = (raw: unknown): { args: Record<string, unknown>; bad?: string } => {
  if (raw && typeof raw === 'object') return { args: raw as Record<string, unknown> }
  if (!raw) return { args: {} }
  try { const v = JSON.parse(String(raw)); return v && typeof v === 'object' ? { args: v } : { args: {}, bad: 'The arguments were not a JSON object.' } } catch { return { args: {}, bad: 'The arguments were not valid JSON.' } }
}

const params = (s: Spec) => ({ type: 'object', properties: s.input, required: s.required ?? Object.keys(s.input) })

// A server that has no tool calling says so in its own words.
const NO_TOOLS = /does not support tools|tool(s| use| call(s|ing)?)? (is|are) not supported|not support (tool|function)|unsupported.*(tool|function)|no endpoints found that support tool|function calling is not/i

function anthropicWire(a: Ask): Wire {
  const head = headers(a.p, a.key)
  const messages: { role: string; content: any[] }[] = [{ role: 'user', content: [...marked(a.history), { type: 'text', text: a.prompt }] }]
  let moving: Record<string, unknown> | null = null
  // A moving mark on the newest message, so each round reads the rounds before it from cache.
  const mark = (block: Record<string, unknown>) => { if (moving) delete moving.cache_control; block.cache_control = { type: 'ephemeral' }; moving = block }
  return {
    shaped: false,
    say(text) { const b: Record<string, unknown> = { type: 'text', text }; messages.push({ role: 'user', content: [b] }); mark(b) },
    results(list) {
      const content: Record<string, unknown>[] = list.map((r) => ({ type: 'tool_result', tool_use_id: r.call.id, content: r.text, ...(r.ok ? {} : { is_error: true }) }))
      messages.push({ role: 'user', content })
      mark(content[content.length - 1])
    },
    async send(tools) {
      let start: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; cache_creation?: { ephemeral_1h_input_tokens?: number } } = {}
      const { res, beat, end } = await post(`${a.p.base}/messages`, {
        method: 'POST', headers: head,
        body: JSON.stringify({
          // Fable and Mythos think on every request and the thinking counts toward max_tokens, so
          // the 5 family gets room for both; older models keep the smaller cap they accept.
          model: a.id, max_tokens: /(fable|mythos|opus|sonnet|haiku)-5(-|$)/.test(a.id) ? 32000 : 8192, stream: true,
          // The system block is the same for the whole room, so it is kept for an hour, not five
          // minutes: a room left for lunch still starts from the cache.
          system: [{ type: 'text', text: a.system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
          messages,
          ...(tools ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: params(t) })) } : {}),
        }),
      }, a, 180000)
      try {
        if (!res.ok) throw await failure(res)
        // Every block is kept as it arrived: thinking has to go back unchanged with its signature
        // when the conversation continues after a tool.
        const blocks: any[] = []
        const partial: Record<number, string> = {}
        let text = '', out = 0, read = 0, written = 0
        for await (const line of lines(res, () => beat(180000))) {
          const o = data(line)
          if (!o) continue
          if (o.type === 'content_block_start') { blocks[o.index] = { ...o.content_block }; a.waiting(false) }
          if (o.type === 'content_block_delta') {
            const b = blocks[o.index], d = o.delta ?? {}
            if (d.type === 'text_delta' || (d.text && !d.type)) { if (b) b.text = (b.text ?? '') + d.text; text += d.text; a.onDelta(d.text) }
            else if (d.type === 'input_json_delta') partial[o.index] = (partial[o.index] ?? '') + (d.partial_json ?? '')
            else if (d.type === 'thinking_delta' && b) b.thinking = (b.thinking ?? '') + (d.thinking ?? '')
            else if (d.type === 'signature_delta' && b) b.signature = (b.signature ?? '') + (d.signature ?? '')
          }
          if (o.type === 'message_start') {
            start = o.message?.usage ?? {}
            read = start.cache_read_input_tokens ?? 0
            written = start.cache_creation_input_tokens ?? 0
          }
          if (o.type === 'message_delta') out = o.usage?.output_tokens ?? out
          if (o.type === 'error') throw new Error(o.error?.message ?? 'Anthropic stream error')
        }
        const calls: Call[] = []
        const kept = blocks.filter(Boolean).filter((b) => b.type !== 'text' || b.text)
        for (const [i, b] of blocks.entries()) {
          if (b?.type !== 'tool_use') continue
          const { args, bad } = jsonArgs(partial[i])
          b.input = args
          calls.push({ id: b.id, name: b.name, args, bad })
        }
        if (kept.length) messages.push({ role: 'assistant', content: kept })
        // The API reports tokens, not dollars, so price the call here once the output is known.
        const long = start.cache_creation?.ephemeral_1h_input_tokens ?? 0
        const writes = { short: Math.max(0, written - long), hour: long }
        const fresh = (start.input_tokens ?? 0) + written
        a.usage.input += fresh
        a.usage.cached += read
        a.usage.output += out
        if (written) {
          a.usage.written = (a.usage.written ?? 0) + written
          // The conversation lives as long as its shortest entry, so five minutes when any was written.
          a.usage.ttl = writes.short ? 300 : Math.min(a.usage.ttl ?? 3600, 3600)
        }
        a.usage.cost += claudeCost(a.id, { input: start.input_tokens ?? 0, read, output: out, ...writes }) ?? 0
        const saved = cacheSaving(a.id, read, writes, fresh + read)
        const gross = readSaving(a.id, read, fresh + read)
        if (saved !== null && saved !== undefined) a.usage.saved = (a.usage.saved ?? 0) + saved
        if (gross !== null && gross !== undefined) a.usage.gross = (a.usage.gross ?? 0) + gross
        return { text, calls, thought: blocks.some((b) => b?.type === 'thinking' || b?.type === 'redacted_thinking') }
      } finally { end() }
    },
  }
}

function openaiWire(a: Ask): Wire {
  // Claude through OpenRouter caches only what is marked, the way Anthropic's own API does, so
  // it gets the same blocks and marks. Everything else there caches a plain prefix by itself.
  const claude = a.name === 'openrouter' && /^anthropic\//.test(a.id)
  const first = (marks: boolean): any[] => marks
    ? [{ role: 'system', content: [{ type: 'text', text: a.system, cache_control: { type: 'ephemeral', ttl: '1h' } }] }, { role: 'user', content: [...marked(a.history.map((l, n) => (n ? `\n\n${l}` : l))), { type: 'text', text: a.prompt }] }]
    : [{ role: 'system', content: a.system }, ...turnsOf(a.history), { role: 'user', content: a.prompt }]
  let marks = claude
  let usageToo = true
  const later: any[] = []
  const near = local(a.p.base)
  return {
    // Structured replies are a local server feature here: llama.cpp and LM Studio both take a schema.
    shaped: near,
    say(text) { later.push({ role: 'user', content: text }) },
    results(list) { for (const r of list) later.push({ role: 'tool', tool_call_id: r.call.id, content: r.text }) },
    async send(tools, format) {
      const ask = () => post(`${a.p.base}/chat/completions`, {
        method: 'POST',
        // xAI keeps a conversation on the server that holds its cache when it is told which one it is.
        headers: { ...headers(a.p, a.key), ...(a.name === 'xai' && a.cacheKey ? { 'x-grok-conv-id': a.cacheKey } : {}) },
        body: JSON.stringify({
          model: a.id, stream: true, ...(usageToo ? { stream_options: { include_usage: true } } : {}),
          messages: [...first(marks), ...later],
          ...(tools ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: params(t) } })) } : {}),
          ...(format ? { response_format: { type: 'json_schema', json_schema: { name: 'step', schema: format } } } : {}),
          // OpenAI routes requests with the same key to the same cache; other compatible APIs ignore it.
          ...(a.name === 'openai' && a.cacheKey ? { prompt_cache_key: a.cacheKey } : {}),
          // OpenRouter picks the provider by the first messages unless told which session this is,
          // and the conversation grows, so without it each turn can land where nothing is cached.
          ...(a.name === 'openrouter' && a.cacheKey ? { session_id: a.cacheKey } : {}),
        }),
      }, a, near ? 600000 : 180000)
      let r = await ask()
      // Some compatible servers, free gateways among them, refuse the usage option; ask again without.
      if (r.res.status === 400 || r.res.status === 422) {
        const why = await r.res.clone().text().catch(() => '')
        if (/stream_options|include_usage|unrecognized|unknown (field|param)|extra (inputs|fields)|not permitted/i.test(why) && !NO_TOOLS.test(why)) { r.end(); usageToo = false; r = await ask() }
        // A route that will not take marked blocks still gets the room, as plain text.
        else if (marks && !NO_TOOLS.test(why)) { r.end(); marks = false; r = await ask() }
      }
      const { res, beat, end } = r
      try {
        if (!res.ok) throw await failure(res)
        let text = '', thought = false
        const raw: { id?: string; name: string; args: string; extra?: unknown }[] = []
        for await (const line of lines(res, () => beat(near ? 300000 : 180000))) {
          const o = data(line)
          if (!o) continue
          if (o.error) throw new Error(o.error.message ?? (typeof o.error === 'string' ? o.error : 'Stream error'))
          const d = o.choices?.[0]?.delta
          // Reasoning models stream their thinking apart from the answer; it is not shown, but it means
          // an empty answer is a model that thought until it ran out, not a broken connection.
          if (d?.reasoning || d?.reasoning_content) thought = true
          if (typeof d?.content === 'string' && d.content) { text += d.content; a.onDelta(d.content) }
          for (const c of d?.tool_calls ?? []) {
            // Calls arrive in pieces, numbered. A server that leaves the number out starts a new
            // call with each id and continues the last one otherwise.
            const i = typeof c.index === 'number' ? c.index : c.id || !raw.length ? raw.length : raw.length - 1
            const at = (raw[i] ??= { name: '', args: '' })
            if (c.id) at.id = c.id
            if (c.function?.name) at.name += c.function.name
            if (c.function?.arguments !== undefined) at.args += typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments)
            // Gemini's compatible API signs each call and wants the signature back with it.
            if (c.extra_content) at.extra = c.extra_content
          }
          if (d) a.waiting(false)
          if (o.usage) {
            // DeepSeek reports its cache hits under its own name.
            const cached = o.usage.prompt_tokens_details?.cached_tokens ?? o.usage.prompt_cache_hit_tokens ?? 0
            a.usage.input += (o.usage.prompt_tokens ?? 0) - cached
            a.usage.output += o.usage.completion_tokens ?? 0
            a.usage.cached += cached
            a.usage.cost += o.usage.cost ?? 0
            const written = o.usage.prompt_tokens_details?.cache_write_tokens
            if (written) a.usage.written = (a.usage.written ?? 0) + written
          }
        }
        const real = raw.filter((c) => c?.name)
        const calls = real.map((c, n): Call => ({ id: c.id || `call_${later.length}_${n}`, name: c.name, ...jsonArgs(c.args) }))
        if (calls.length) later.push({ role: 'assistant', content: text || null, tool_calls: calls.map((c, n) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: real[n].args || '{}' }, ...(real[n].extra ? { extra_content: real[n].extra } : {}) })) })
        else if (text) later.push({ role: 'assistant', content: text })
        return { text, calls, thought }
      } finally { end() }
    },
  }
}

// Gemini's schema is OpenAPI with its own upper case type names.
const googleType = (v: any): any => (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'type' && typeof x === 'string' ? x.toUpperCase() : Array.isArray(x) ? x : googleType(x)])) : v)

function googleWire(a: Ask): Wire {
  const contents: { role: string; parts: any[] }[] = [{ role: 'user', parts: [...a.history.map((text) => ({ text })), { text: a.prompt }] }]
  return {
    shaped: false,
    say(text) { contents.push({ role: 'user', parts: [{ text }] }) },
    results(list) { contents.push({ role: 'user', parts: list.map((r) => ({ functionResponse: { name: r.call.name, response: r.ok ? { result: r.text } : { error: r.text } } })) }) },
    async send(tools) {
      const { res, beat, end } = await post(`${a.p.base}/models/${a.id}:streamGenerateContent?alt=sse&key=${encodeURIComponent(a.key)}`, {
        method: 'POST', headers: headers(a.p, a.key),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: a.system }] }, contents,
          ...(tools ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: googleType(params(t)) })) }] } : {}),
        }),
      }, a, 180000)
      try {
        if (!res.ok) throw await failure(res)
        let text = '', thought = false
        // The model's parts go back exactly as sent: a call carries a signature the next request needs.
        const parts: any[] = []
        const calls: Call[] = []
        let seen = { input: 0, output: 0, cached: 0 }
        for await (const line of lines(res, () => beat(180000))) {
          const o = data(line)
          if (!o) continue
          if (o.error) throw new Error(o.error.message ?? 'Gemini stream error')
          for (const part of o.candidates?.[0]?.content?.parts ?? []) {
            parts.push(part)
            if (part.thought) { thought = true; continue }
            if (part.functionCall) calls.push({ id: `call_${contents.length}_${calls.length}`, name: part.functionCall.name, args: part.functionCall.args ?? {} })
            else if (part.text) { text += part.text; a.onDelta(part.text) }
            a.waiting(false)
          }
          const u = o.usageMetadata
          if (u) seen = { input: (u.promptTokenCount ?? 0) - (u.cachedContentTokenCount ?? 0), output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), cached: u.cachedContentTokenCount ?? 0 }
        }
        a.usage.input += seen.input
        a.usage.output += seen.output
        a.usage.cached += seen.cached
        if (parts.length) contents.push({ role: 'model', parts })
        return { text, calls, thought }
      } finally { end() }
    },
  }
}

function ollamaWire(a: Ask, info: Local): Wire {
  const messages: any[] = [{ role: 'system', content: a.system }, ...turnsOf(a.history), { role: 'user', content: a.prompt }]
  return {
    shaped: true,
    say(text) { messages.push({ role: 'user', content: text }) },
    results(list) { for (const r of list) messages.push({ role: 'tool', tool_name: r.call.name, content: r.text }) },
    async send(tools, format) {
      const { res, beat, end } = await post(`${a.p.base}/chat`, {
        method: 'POST', headers: headers(a.p, a.key),
        body: JSON.stringify({
          model: a.id, stream: true, keep_alive: '30m', messages,
          // A cap on the answer too: a small model that falls into repeating itself would
          // otherwise write until the window is full.
          options: { num_ctx: info.window, num_predict: Math.min(16384, info.window) },
          ...(tools ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: params(t) } })) } : {}),
          ...(format ? { format } : {}),
        }),
      }, a, 600000)
      try {
        if (!res.ok) throw await failure(res)
        let text = '', thought = false
        const calls: Call[] = []
        for await (const line of lines(res, () => beat(300000))) {
          const o = data(line)
          if (!o) continue
          if (o.error) throw new Error(String(o.error))
          const m = o.message ?? {}
          if (m.thinking) thought = true
          if (m.content) { text += m.content; a.onDelta(m.content) }
          for (const c of m.tool_calls ?? []) if (c.function?.name) calls.push({ id: `call_${messages.length}_${calls.length}`, name: c.function.name, ...jsonArgs(c.function.arguments) })
          if (m.content || m.thinking || m.tool_calls) a.waiting(false)
          if (o.done) { a.usage.input += o.prompt_eval_count ?? 0; a.usage.output += o.eval_count ?? 0 }
        }
        if (calls.length || text) messages.push({ role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.args } })) } : {}) })
        return { text, calls, thought }
      } finally { end() }
    },
  }
}

// A model that falls into a loop writes the same lines again and again until its window is full.
// When the end of the answer is one short passage many times over, the round is cut there.
export function looping(text: string) {
  if (text.length < 2400) return false
  const tail = text.slice(-160)
  return tail.trim().length > 40 && text.slice(-4000).split(tail).length - 1 >= 6
}

const ROUNDS = 60
const REPAIRS = 2
const SAME = 3

export type Step = { working?: string; acts?: Act[] }
export type Hands = { bench: Bench; onStep(s: Step): void; inbox?(): string | null }

// history is the conversation, which only grows at the end; prompt is what changes every turn.
// Keeping them apart lets every provider cache the history as a prefix: Anthropic through explicit
// marks, OpenAI, xAI, DeepSeek and Gemini automatically, Ollama by keeping the model and its
// prompt cache loaded between turns. cacheKey names the room and agent, for providers that route
// by it.
//
// With hands the model works in the room's folder: it calls a tool, gets the result and carries
// on until it answers without calling one. A model with tool calling of its own uses that; one
// without writes its calls as text, and a model that turns out not to have it is moved over.
export async function chat(name: string, key: string, model: string, system: string, prompt: string, signal: AbortSignal, onDelta: (d: string) => void, history: string[] = [], cacheKey = '', hands?: Hands) {
  const p = await reach(PROVIDERS[name])
  const id = await pick(name, key, model)
  // Unloading is asked for once the whole turn is over, not on each request: a turn with tools is
  // many requests, and the model would otherwise load again between every step. The next request
  // from anywhere, this room or another app, loads it again on its own.
  const release = () => {
    if (p.style !== 'ollama' || !PROVIDERS[name]?.unload) return
    fetch(`${p.base}/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: id, keep_alive: 0 }), signal: AbortSignal.timeout(5000) }).catch(() => {})
  }
  const usage: Usage = { input: 0, output: 0, cached: 0, cost: 0 }
  const acts: Act[] = []
  const near = local(p.base)
  const tools = hands ? specs(hands.bench.access) : null
  const info = p.style === 'ollama' ? await ollamaInfo(p.base, id, signal) : null
  // Text calls from the start when the server says the model has none of its own.
  let native = !!tools && info?.tools !== false
  let textual = !!tools && !native
  let sieve = new Sieve(tools?.map((t) => t.name))
  let text = ''
  let thought = false
  let slow: ReturnType<typeof setTimeout> | undefined
  let writing = false
  const show = (shown: string) => {
    if (!shown) return
    // The first words of a round after a tool start a new paragraph and end the status line.
    if (!writing) {
      writing = true
      hands?.onStep({ working: '' })
      if (text.trim()) shown = `${text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'}${shown.replace(/^\s+/, '')}`
    }
    text += shown
    onDelta(shown)
  }
  // A reply held to a JSON shape is not for reading; its words are shown once it has been read.
  let shaped = false
  const push = (d: string) => { if (!shaped) show(sieve.feed(d)) }
  const ask: Ask = {
    p, name, id, key, prompt, history, cacheKey, signal, usage, onDelta: push,
    system: textual ? `${system}\n\n${manual(tools!)}` : system,
    waiting(first) {
      clearTimeout(slow)
      // A model that is not in memory yet says nothing for a while; the room says why.
      if (first && near) slow = setTimeout(() => hands?.onStep({ working: `~Loading ${id}` }), 2500)
    },
  }
  const make = () => (p.style === 'anthropic' ? anthropicWire(ask) : p.style === 'openai' ? openaiWire(ask) : p.style === 'google' ? googleWire(ask) : ollamaWire(ask, info!))
  let wire = make()
  let repairs = 0
  let format: object | undefined
  const failed = new Map<string, number>()
  try {
    for (let n = 0; n < ROUNDS; n++) {
      writing = false
      sieve = new Sieve(tools?.map((t) => t.name))
      ask.waiting(n === 0)
      let r: Round
      try {
        r = await wire.send(native ? tools : null, format)
      } catch (e) {
        // The first request is where a model without tool calling shows itself. It gets the
        // same tools as text instead, and the room carries on as if nothing happened.
        if (native && n === 0 && !signal.aborted && NO_TOOLS.test((e as Error).message)) {
          native = false
          textual = true
          ask.system = `${system}\n\n${manual(tools!)}`
          wire = make()
          n--
          continue
        }
        throw e
      }
      if (!shaped) show(sieve.end())
      thought ||= r.thought || sieve.thought
      if (!tools || !hands) break
      let calls = r.calls
      let viaText = false
      // No call of its own: the answer may still hold one as text, from a model that was told
      // the text form or one that falls back to the form it was trained on.
      if (!calls.length) {
        if (looping(r.text)) throw new Error(`${id} started repeating itself, so Lunchbox stopped it. Ask again, or pick a larger model.`)
        const read = readCall(unthink(r.text), tools)
        if (read.error) {
          if (++repairs > REPAIRS) throw new Error(`${id} kept writing tool calls Lunchbox could not read. Try a model with tool calling, or a larger one.`)
          wire.say(`${read.error}`)
          // A server that can hold the reply to a shape does so from the second miss on, for the
          // rest of the turn: a small model gets that right where free text went wrong.
          if (wire.shaped && repairs === REPAIRS) { format = schema(tools); shaped = true; wire.say('From now on answer with JSON only: {"tool": "<tool name, or none when you are done>", "args": {...}, "say": "<what to tell the person>"}') }
          continue
        }
        if (shaped) show(read.before)
        if (!read.call) break
        calls = [{ id: `text_${n}`, ...read.call }]
        viaText = true
      }
      const done: Outcome[] = []
      for (const call of calls) {
        if (signal.aborted) throw new Error('Stopped')
        const shown = call.name === 'run_command' ? `$ ${String(call.args.command ?? '')}` : `${call.name} ${String(call.args.path ?? call.args.query ?? '')}`.trim()
        hands.onStep({ working: shown })
        const out = call.bad ? { ok: false, text: `${call.bad} Send the call again.` } as Awaited<ReturnType<typeof use>> : await use(hands.bench, call.name, call.args)
        if (out.act) { acts.push(out.act); hands.onStep({ acts: [out.act] }) }
        done.push({ call, text: out.text, ok: out.ok })
        const sig = `${call.name} ${JSON.stringify(call.args)}`
        if (out.ok) failed.delete(sig)
        else failed.set(sig, (failed.get(sig) ?? 0) + 1)
        if ((failed.get(sig) ?? 0) >= SAME) throw new Error(`${id} made the same failing ${call.name} call ${SAME} times, so Lunchbox stopped it.`)
      }
      repairs = 0
      if (viaText) wire.say(done.map((d) => `Result of ${d.call.name}${d.ok ? '' : ' (it failed)'}:\n${d.text}`).join('\n\n') + '\n\nCarry on. Use another tool block if you need one, or answer the person.')
      else wire.results(done)
      // A message the person sent while this turn ran joins here, between steps, so the model
      // takes it in without being stopped.
      const sent = hands.inbox?.()
      if (sent) wire.say(sent)
      hands.onStep({ working: '~Thinking' })
      if (n === ROUNDS - 1) throw new Error(`${id} used ${ROUNDS} tool calls without finishing, so Lunchbox stopped it. Ask it to carry on.`)
    }
  } catch (e) {
    clearTimeout(slow)
    let err = e instanceof Error ? e : new Error(String(e))
    if (!signal.aborted) {
      if (ask.stalled) err = new Error(`${id} stopped answering, so Lunchbox gave up waiting. ${near ? 'The model may be too large for this computer.' : 'Ask again in a moment.'}`)
      else if (err.message === 'fetch failed') err = new Error(near ? `Nothing is answering at ${p.base.replace(/\/(api|v1)$/, '')}. Start the server, then ask again.` : `Could not reach ${new URL(p.base).host}. Check the connection, then ask again.`)
      else if (p.style === 'ollama' && /model .*not found|404/.test(err.message)) err = new Error(`${id} is not downloaded on this Ollama server. Pick another model in Agents, or run: ollama pull ${id}`)
    }
    // What was done before it broke stays on the record with the reason.
    release()
    throw Object.assign(err, { text: text.trim().replace(/\n{3,}/g, '\n\n'), acts, usage })
  }
  clearTimeout(slow)
  release()
  // A model that streams nothing back has failed, even when the server said done. Saying so beats
  // an empty bubble the person cannot read anything from.
  if (!text.trim() && !acts.length) {
    if (p.style === 'ollama') throw new Error(`${id} sent back an empty answer. Small local models often do this on long rooms; try a larger model, or start a new room.`)
    if (thought) throw new Error(`${id} spent its whole answer thinking and sent no text. Ask again, or pick another model.`)
    throw new Error(`${id} sent back an empty answer. Free and small models do this now and then; ask again, or pick another model.`)
  }
  return { text: text.trim().replace(/\n{3,}/g, '\n\n'), usage, acts }
}
