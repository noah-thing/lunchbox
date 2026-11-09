// Anthropic list prices in dollars per million input tokens, and what a cache read costs.
// Writes cost 1.25 times the input price for a five minute entry and twice for an hour.
// Only prices we know go in here; anything else is counted in tokens, never guessed in dollars.
const CLAUDE: [RegExp, number, number][] = [
  [/(fable|mythos)-5-1/, 10, 0.25],
  [/(fable|mythos)-5/, 10, 1],
  [/opus-5-5/, 4, 0.2],
  [/opus-(5|4-[5-8])/, 5, 0.5],
  [/sonnet-5/, 2, 0.2],
  [/sonnet-4/, 3, 0.3],
  [/haiku-5-5/, 0.1, 0.01],
  [/haiku-4-5/, 1, 0.1],
]

export type Price = { input: number; read: number }

export function claudePrice(model: string): Price | null {
  const hit = CLAUDE.find(([re]) => re.test(model))
  return hit ? { input: hit[1], read: hit[2] } : null
}

// What caching saved on one call: reads billed at the cached rate instead of the full one,
// minus the premium paid to write the entries. Can be negative on a first, cold call.
export function cacheSaving(model: string, read: number, written: number, hour = false): number | null {
  const p = claudePrice(model)
  if (!p) return null
  return (read * (p.input - p.read) - written * p.input * (hour ? 1 : 0.25)) / 1e6
}
