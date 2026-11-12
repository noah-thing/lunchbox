// Anthropic list prices in dollars per million tokens: input, a cache read, and output.
// Writes cost 1.25 times the input price for a five minute entry and twice for an hour.
// Haiku 5.5 doubles to $0.50 / $2.50 when a prompt runs past 100K tokens.
// Only prices we know go in here; anything else is counted in tokens, never guessed in dollars.
const CLAUDE: [RegExp, number, number, number][] = [
  [/(fable|mythos)-5-2/, 8, 0.2, 40],
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

// What the cached reads of one call saved on their own, before the write premium. Positive from
// the first cache hit, so a room shows its saving before the writes have paid off.
export function readSaving(model: string, read: number, prompt = 0): number | null {
  const p = claudePrice(model, prompt)
  return p ? (read * (p.input - p.read)) / 1e6 : null
}

// Cached reads bill at a tenth of a fresh read for Claude and OpenAI. Other providers discount less
// or do not say, so they count at a quarter, which can only understate the saving.
const READ_SHARE: Record<string, number> = { claude: 0.1, codex: 0.1 }

// What the cached reads of a call saved, worked back from the cost the agent reported, for agents
// without a price here and for rows recorded before Lunchbox priced them. The cost gives the price
// of a fresh token (writes at 1.25 times it, output at five times), and each cached token saved the
// gap between a fresh read and a cached one.
export function costSaving(agent: string, u: { input: number; output: number; cached: number; cost: number; written?: number }): number | null {
  if (!(u.cost > 0) || !(u.cached > 0)) return null
  const share = READ_SHARE[agent] ?? 0.25
  const fresh = u.cost / (u.input + (u.written ?? 0) * 0.25 + u.cached * share + u.output * 5)
  return u.cached * fresh * (1 - share)
}

// The bill for one call at list price, for API keys that do not report a cost themselves.
export function claudeCost(model: string, u: { input: number; read: number; output: number } & Writes, prompt = u.input + u.read + u.short + (u.hour ?? 0)): number | null {
  const p = claudePrice(model, prompt)
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

// Codex credits sell at $40 for 1,000. Codex has no write premium, so what the cached input saved
// is the gap between the input and cached input rates.
const CREDIT = 0.04
export function codexSaving(model: string, cached: number) {
  const [, i, c] = CODEX.find(([re]) => re.test(model)) ?? [null, 50, 5, 250]
  return (cached * (i - c) * CREDIT) / 1e6
}

// What a Claude Code message would cost at list price. Unlisted models count like Sonnet 5.
export function claudeValue(model: string, u: { input: number; read: number; output: number; short: number; hour?: number }) {
  return claudeCost(model, u) ?? claudeCost('claude-sonnet-5', u)!
}
