import type { Usage } from '../../shared/types'
import { cacheSaving, claudeCost } from '../../shared/prices'

type Provider = { base: string; style: 'anthropic' | 'openai' | 'google' | 'ollama'; prefer: RegExp }

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

function headers(style: Provider['style'], key: string): Record<string, string> {
  if (style === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
  if (style === 'openai' && key) return { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
  return { 'content-type': 'application/json' }
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
  const res = await fetch(`${p.base}/models`, { headers: headers(p.style, key), signal })
  if (!res.ok) throw await failure(res)
  // Only models that chat: embedding, speech, image and moderation models fail on chat requests.
  return ((await res.json()).data ?? []).map((m: { id: string }) => m.id).filter((id: string) => !/embed|whisper|tts|dall|image|moderation|audio|realtime|transcribe|search-preview/i.test(id)).sort().reverse()
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

// history is the conversation, which only grows at the end; prompt is what changes every turn.
// Keeping them apart lets every provider cache the history as a prefix: Anthropic through an
// explicit breakpoint on its last block, OpenAI, xAI and Gemini automatically, Ollama by keeping
// the model and its prompt cache loaded between turns.
export async function chat(name: string, key: string, model: string, system: string, prompt: string, signal: AbortSignal, onDelta: (d: string) => void, history: string[] = [], cacheKey = '') {
  const p = PROVIDERS[name]
  const id = await pick(name, key, model)
  const usage: Usage = { input: 0, output: 0, cached: 0, cost: 0 }
  let text = ''
  const push = (d?: string) => { if (d) { text += d; onDelta(d) } }
  let res: Response

  if (p.style === 'anthropic') {
    let start: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; cache_creation?: { ephemeral_1h_input_tokens?: number } } = {}
    // One block per message of the conversation and a breakpoint on the last one. The next turn
    // finds that breakpoint again within the 20 block lookback and reads everything before it
    // from cache; only the new messages, the memory and the task are billed in full.
    const blocks: { type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: '1h' } }[] = history.map((text) => ({ type: 'text', text }))
    // Two marks in the history: the newest block, and the last block of the previous step of 20,
    // so a busy room still finds its earlier prefix within the provider's lookback.
    const marks = new Set([blocks.length - 1, 20 * Math.floor((blocks.length - 1) / 20) - 1].filter((i) => i >= 0))
    for (const i of marks) blocks[i].cache_control = { type: 'ephemeral' }
    res = await fetch(`${p.base}/messages`, {
      method: 'POST', signal, headers: headers(p.style, key),
      body: JSON.stringify({
        model: id, max_tokens: 8192, stream: true,
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
    const hour = start.cache_creation?.ephemeral_1h_input_tokens ?? 0
    const writes = { short: Math.max(0, (usage.written ?? 0) - hour), hour }
    usage.cost = claudeCost(id, { input: start.input_tokens ?? 0, read: usage.cached, output: usage.output, ...writes }) ?? 0
    usage.saved = cacheSaving(id, usage.cached, writes, usage.input + usage.cached) ?? undefined
  } else if (p.style === 'openai') {
    res = await fetch(`${p.base}/chat/completions`, {
      method: 'POST', signal, headers: headers(p.style, key),
      body: JSON.stringify({
        model: id, stream: true, stream_options: { include_usage: true },
        messages: [{ role: 'system', content: system }, ...turnsOf(history), { role: 'user', content: prompt }],
        // OpenAI routes requests with the same key to the same cache; other compatible APIs ignore it.
        ...(name === 'openai' && cacheKey ? { prompt_cache_key: cacheKey } : {}),
      }),
    })
    if (!res.ok) throw await failure(res)
    for await (const line of lines(res)) {
      const o = data(line)
      if (!o) continue
      if (o.error) throw new Error(o.error.message ?? 'Stream error')
      push(o.choices?.[0]?.delta?.content)
      if (o.usage) {
        const cached = o.usage.prompt_tokens_details?.cached_tokens ?? 0
        Object.assign(usage, { input: (o.usage.prompt_tokens ?? 0) - cached, output: o.usage.completion_tokens ?? 0, cached, cost: o.usage.cost ?? 0 })
      }
    }
  } else if (p.style === 'google') {
    res = await fetch(`${p.base}/models/${id}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`, {
      method: 'POST', signal, headers: headers(p.style, key),
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
      method: 'POST', signal, headers: headers(p.style, key),
      body: JSON.stringify({ model: id, stream: true, keep_alive: '30m', messages: [{ role: 'system', content: system }, ...turnsOf(history), { role: 'user', content: prompt }] }),
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
  return { text: text.trim(), usage }
}
