import type { Usage } from '../../shared/types'
import { cacheSaving, claudeCost, readSaving } from '../../shared/prices'

// extra: headers a connector's server wants on every request, such as a plan or project id.
type Provider = { base: string; style: 'anthropic' | 'openai' | 'google' | 'ollama'; prefer: RegExp; extra?: Record<string, string> }

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

export async function listModels(name: string, key: string): Promise<string[]> {
  const p = PROVIDERS[name]
  const signal = AbortSignal.timeout(p.base.startsWith('http://127.') ? 1500 : 8000)
  if (p.style === 'ollama') {
    const res = await fetch(`${p.base}/tags`, { signal })
    if (!res.ok) throw await failure(res)
    return ((await res.json()).models ?? []).map((m: { name: string }) => m.name)
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
  return ((await res.json()).data ?? []).map((m: { id: string }) => m.id).filter((id: string) => !/embed|whisper|tts|dall|image|moderation|audio|realtime|transcribe|search-preview/i.test(id)).sort().reverse()
}

// Ollama runs every model with a small context window unless told otherwise, and quietly cuts the
// start of anything longer. A room's instructions and history are longer, so the model lost them
// and answered with nothing or stopped mid answer. Each request asks for room to fit, capped at
// what the model supports and at a size an ordinary laptop can hold in memory.
const ROOM = 16384
const windows = new Map<string, number>()
async function ollamaWindow(base: string, model: string, signal?: AbortSignal) {
  if (windows.has(model)) return windows.get(model)!
  let most = ROOM
  try {
    const res = await fetch(`${base}/show`, { method: 'POST', signal, body: JSON.stringify({ model }) })
    const info = res.ok ? (await res.json()).model_info ?? {} : {}
    const key = Object.keys(info).find((k) => k.endsWith('.context_length'))
    if (key && Number(info[key]) > 0) most = Math.min(ROOM, Number(info[key]))
  } catch {}
  windows.set(model, most)
  return most
}

async function pick(name: string, key: string, model: string) {
  if (model) return model
  const all = await listModels(name, key)
  const m = all.find((id) => PROVIDERS[name].prefer.test(id)) ?? all[0]
  if (!m) throw new Error('No model available. Choose one in Agents.')
  return m
}

// Server-sent events and Ollama's newline-delimited JSON both arrive as lines.
async function* lines(res: Response) {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
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

// history is the conversation, which only grows at the end; prompt is what changes every turn.
// Keeping them apart lets every provider cache the history as a prefix: Anthropic through explicit
// marks, OpenAI, xAI, DeepSeek and Gemini automatically, Ollama by keeping the model and its
// prompt cache loaded between turns. cacheKey names the room and agent, for providers that route
// by it.
export async function chat(name: string, key: string, model: string, system: string, prompt: string, signal: AbortSignal, onDelta: (d: string) => void, history: string[] = [], cacheKey = '') {
  const p = PROVIDERS[name]
  const id = await pick(name, key, model)
  const usage: Usage = { input: 0, output: 0, cached: 0, cost: 0 }
  let text = ''
  let thought = false
  const push = (d?: string) => { if (d) { text += d; onDelta(d) } }
  let res: Response

  if (p.style === 'anthropic') {
    let start: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; cache_creation?: { ephemeral_1h_input_tokens?: number } } = {}
    const blocks = marked(history)
    res = await fetch(`${p.base}/messages`, {
      method: 'POST', signal, headers: headers(p, key),
      body: JSON.stringify({
        // Fable and Mythos think on every request and the thinking counts toward max_tokens, so
        // the 5 family gets room for both; older models keep the smaller cap they accept.
        model: id, max_tokens: /-5(-|$)/.test(id) ? 32000 : 8192, stream: true,
        // The system block is the same for the whole room, so it is kept for an hour, not five
        // minutes: a room left for lunch still starts from the cache.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
        messages: [{ role: 'user', content: [...blocks, { type: 'text', text: prompt }] }],
      }),
    })
    if (!res.ok) throw await failure(res)
    for await (const line of lines(res)) {
      const o = data(line)
      if (!o) continue
      if (o.type === 'content_block_delta') push(o.delta?.text)
      if (o.type === 'message_start') {
        start = o.message?.usage ?? {}
        usage.input = (start.input_tokens ?? 0) + (start.cache_creation_input_tokens ?? 0)
        usage.cached = start.cache_read_input_tokens ?? 0
        usage.written = start.cache_creation_input_tokens ?? 0
      }
      if (o.type === 'message_delta') usage.output = o.usage?.output_tokens ?? usage.output
      if (o.type === 'error') throw new Error(o.error?.message ?? 'Anthropic stream error')
    }
    // The API reports tokens, not dollars, so price the call here once the output is known.
    const long = start.cache_creation?.ephemeral_1h_input_tokens ?? 0
    const writes = { short: Math.max(0, (usage.written ?? 0) - long), hour: long }
    // The conversation lives as long as its shortest entry, so five minutes when any was written.
    if (usage.written) usage.ttl = writes.short ? 300 : 3600
    usage.cost = claudeCost(id, { input: start.input_tokens ?? 0, read: usage.cached, output: usage.output, ...writes }) ?? 0
    usage.saved = cacheSaving(id, usage.cached, writes, usage.input + usage.cached) ?? undefined
    usage.gross = readSaving(id, usage.cached, usage.input + usage.cached) ?? undefined
  } else if (p.style === 'openai') {
    // Claude through OpenRouter caches only what is marked, the way Anthropic's own API does, so
    // it gets the same blocks and marks. Everything else there caches a plain prefix by itself.
    const claude = name === 'openrouter' && /^anthropic\//.test(id)
    const ask = (usageToo: boolean, marks: boolean) => fetch(`${p.base}/chat/completions`, {
      method: 'POST', signal,
      // xAI keeps a conversation on the server that holds its cache when it is told which one it is.
      headers: { ...headers(p, key), ...(name === 'xai' && cacheKey ? { 'x-grok-conv-id': cacheKey } : {}) },
      body: JSON.stringify({
        model: id, stream: true, ...(usageToo ? { stream_options: { include_usage: true } } : {}),
        messages: marks
          ? [{ role: 'system', content: [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }] }, { role: 'user', content: [...marked(history.map((l, n) => (n ? `\n\n${l}` : l))), { type: 'text', text: prompt }] }]
          : [{ role: 'system', content: system }, ...turnsOf(history), { role: 'user', content: prompt }],
        // OpenAI routes requests with the same key to the same cache; other compatible APIs ignore it.
        ...(name === 'openai' && cacheKey ? { prompt_cache_key: cacheKey } : {}),
        // OpenRouter picks the provider by the first messages unless told which session this is,
        // and the conversation grows, so without it each turn can land where nothing is cached.
        ...(name === 'openrouter' && cacheKey ? { session_id: cacheKey } : {}),
      }),
    })
    res = await ask(true, claude)
    // Some compatible servers, free gateways among them, refuse the usage option; ask again without.
    if (res.status === 400 || res.status === 422) {
      const why = await res.clone().text().catch(() => '')
      if (/stream_options|include_usage|unrecognized|unknown (field|param)|extra (inputs|fields)|not permitted/i.test(why)) res = await ask(false, claude)
      // A route that will not take marked blocks still gets the room, as plain text.
      else if (claude) res = await ask(true, false)
    }
    if (!res.ok) throw await failure(res)
    for await (const line of lines(res)) {
      const o = data(line)
      if (!o) continue
      if (o.error) throw new Error(o.error.message ?? (typeof o.error === 'string' ? o.error : 'Stream error'))
      const d = o.choices?.[0]?.delta
      // Reasoning models stream their thinking apart from the answer; it is not shown, but it means
      // an empty answer is a model that thought until it ran out, not a broken connection.
      if (d?.reasoning || d?.reasoning_content) thought = true
      push(typeof d?.content === 'string' ? d.content : undefined)
      if (o.usage) {
        // DeepSeek reports its cache hits under its own name.
        const cached = o.usage.prompt_tokens_details?.cached_tokens ?? o.usage.prompt_cache_hit_tokens ?? 0
        Object.assign(usage, { input: (o.usage.prompt_tokens ?? 0) - cached, output: o.usage.completion_tokens ?? 0, cached, cost: o.usage.cost ?? 0 })
        const written = o.usage.prompt_tokens_details?.cache_write_tokens
        if (written) usage.written = written
      }
    }
  } else if (p.style === 'google') {
    res = await fetch(`${p.base}/models/${id}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`, {
      method: 'POST', signal, headers: headers(p, key),
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [...history.map((text) => ({ text })), { text: prompt }] }] }),
    })
    if (!res.ok) throw await failure(res)
    for await (const line of lines(res)) {
      const o = data(line)
      if (!o) continue
      for (const part of o.candidates?.[0]?.content?.parts ?? []) push(part.text)
      const u = o.usageMetadata
      if (u) Object.assign(usage, { input: (u.promptTokenCount ?? 0) - (u.cachedContentTokenCount ?? 0), output: u.candidatesTokenCount ?? 0, cached: u.cachedContentTokenCount ?? 0 })
    }
  } else {
    res = await fetch(`${p.base}/chat`, {
      method: 'POST', signal, headers: headers(p, key),
      body: JSON.stringify({
        model: id, stream: true, keep_alive: '30m', options: { num_ctx: await ollamaWindow(p.base, id, signal) },
        messages: [{ role: 'system', content: system }, ...turnsOf(history), { role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) throw await failure(res)
    for await (const line of lines(res)) {
      const o = data(line)
      if (!o) continue
      if (o.error) throw new Error(o.error)
      push(o.message?.content)
      if (o.done) Object.assign(usage, { input: o.prompt_eval_count ?? 0, output: o.eval_count ?? 0 })
    }
  }
  // A model that streams nothing back has failed, even when the server said done. Saying so beats
  // an empty bubble the person cannot read anything from.
  if (!text.trim()) {
    if (p.style === 'ollama') throw new Error(`${id} sent back an empty answer. Small local models often do this on long rooms; try a larger model, or start a new room.`)
    if (thought) throw new Error(`${id} spent its whole answer thinking and sent no text. Ask again, or pick another model.`)
    throw new Error(`${id} sent back an empty answer. Free and small models do this now and then; ask again, or pick another model.`)
  }
  return { text: text.trim(), usage }
}
