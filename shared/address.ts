// Who a message is for. "@claude" always works; most people just write the name the way they
// would to a person: "Claude, could you look into this?", "Ollama: rename it", "Claude and Codex,
// compare these". A leading name counts only when it is clearly addressed, so "Claude is slow
// today" stays a message to the room.

type Who = { id: string; short: string }

const handle = (a: Who) => [a.id, a.short.toLowerCase().replace(/[^a-z0-9]+/g, '-')]
const asks = /^(?:can|could|would|will|please|pls|look|check|help|do|make|build|fix|write|tell|what|how|why|where|when|try|go|take|review|test|run|find|add|explain|show|give|create|update|change|read|search)\b/i

export function addressed(text: string, agents: Who[]): string[] {
  const head = text.match(/^\s*((?:@[\w-]+[\s,]*)+)/)?.[1] ?? ''
  const tagged = agents.filter((a) => handle(a).some((h) => new RegExp(`@${h}(?![\\w-])`, 'i').test(head)))
  if (tagged.length) return tagged.map((a) => a.id)

  const lead = text.replace(/^\s*(?:hey|hi|hello|ok|okay|so|and)\b[\s,]*/i, '')
  const find = (word: string) => agents.find((a) => a.id.toLowerCase() === word.toLowerCase() || a.short.toLowerCase() === word.toLowerCase())
  // Names before a comma, colon or dash: "Claude and Codex, ..." or "Ollama: ...".
  const before = lead.match(/^([^,:\n]{1,60}?)\s*[,:–-]\s*\S/)?.[1]
  if (before) {
    const names = before.split(/\s*(?:,|\band\b|&|\+)\s*/i).filter(Boolean)
    const found = names.map(find)
    if (found.length && found.every(Boolean)) return [...new Set(found.map((a) => a!.id))]
  }
  // One name followed by a request: "Claude could you check this".
  const first = lead.match(/^([\w.-]+)\s+(.*)$/s)
  const one = first && find(first[1])
  if (one && asks.test(first![2])) return [one.id]
  return []
}
