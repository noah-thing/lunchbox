// Anthropic list prices in dollars per million tokens: input, a cache read, and output.
// Writes cost 1.25 times the input price for a five minute entry and twice for an hour.
// Haiku 5.5 doubles to $0.50 / $2.50 when a prompt runs past 100K tokens.
// Only prices we know go in here; anything else is counted in tokens, never guessed in dollars.
const CLAUDE: [RegExp, number, number, number][] = [
  [/(fable|mythos)-5-1/, 10, 0.25, 50],
  [/(fable|mythos)-5/, 10, 1, 50],
  [/opus-5-5/, 4, 0.2, 20],
  [/opus-(5|4-[5-8])/, 5, 0.5, 25],
  [/sonnet-5/, 2, 0.2, 10],
  [/sonnet-4/, 3, 0.3, 15],
  [/haiku-5-5/, 0.1, 0.01, 0.5],
  [/haiku-4-5/, 1, 0.1, 5],
]

export type Price = { input: number; read: number; output: number }

export function claudePrice(model: string, prompt = 0): Price | null {
  const hit = CLAUDE.find(([re]) => re.test(model))
  if (!hit) return null
  const long = /haiku-5-5/.test(model) && prompt > 100_000 ? 5 : 1
  return { input: hit[1] * long, read: hit[2] * long, output: hit[3] * long }
}

// Cache entries written on one call, by how long they live.
export type Writes = { short: number; hour?: number }

// What caching saved on one call: reads billed at the cached rate instead of the full one,
// minus the premium paid to write the entries. Can be negative on a first, cold call.
export function cacheSaving(model: string, read: number, writes: number | Writes, prompt = 0): number | null {
  const p = claudePrice(model, prompt)
  if (!p) return null
  const w = typeof writes === 'number' ? { short: writes, hour: 0 } : writes
  return (read * (p.input - p.read) - w.short * p.input * 0.25 - (w.hour ?? 0) * p.input) / 1e6
}

// The bill for one call at list price, for API keys that do not report a cost themselves.
export function claudeCost(model: string, u: { input: number; read: number; output: number } & Writes): number | null {
  const p = claudePrice(model, u.input + u.read + u.short + (u.hour ?? 0))
  if (!p) return null
  return (u.input * p.input + u.short * p.input * 1.25 + (u.hour ?? 0) * p.input * 2 + u.read * p.read + u.output * p.output) / 1e6
}

// Codex credits per million tokens, input / cached input / output, from OpenAI's Codex pricing
// page. Plan windows are spent in these credits, which is why one GPT-6 Astra call can use as
// much of a window as ten GPT-6.1 Terra calls. Unlisted models count like GPT-6 Sol.
const CODEX: [RegExp, number, number, number][] = [
  [/gpt-6-astra/, 250, 25, 1250],
  [/gpt-6\.1-sol/, 50, 2.5, 250],
  [/gpt-6\.1-terra/, 25, 1.25, 125],
  [/gpt-6-sol/, 50, 5, 250],
  [/gpt-6(\.1)?-luna/, 2.5, 0.25, 12.5],
  [/gpt-5\.6-sol/, 100, 10, 500],
  [/gpt-5\.6-terra/, 50, 5, 300],
  [/gpt-5\.6-luna/, 5, 0.5, 30],
]

export function codexCredits(model: string, u: { fresh: number; cached: number; output: number }) {
  const [, i, c, o] = CODEX.find(([re]) => re.test(model)) ?? [null, 50, 5, 250]
  return (u.fresh * i + u.cached * c + u.output * o) / 1e6
}

// What a Claude Code message would cost at list price. Unlisted models count like Sonnet 5.
export function claudeValue(model: string, u: { input: number; read: number; output: number; short: number; hour?: number }) {
  return claudeCost(model, u) ?? claudeCost('claude-sonnet-5', u)!
}
