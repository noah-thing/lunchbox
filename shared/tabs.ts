// The person's own page in the Lunchbox browser. Every other page belongs to one agent in one room.
export const YOU = 'you'
// Each page is a renderer process. Past this many agent pages the one unused longest is closed.
export const MAX_AGENT_TABS = 6

// Which agent page to close to make room for one more: the one unused longest that is not in the
// middle of something. Undefined when there is room, null when every page is busy.
export function evict(tabs: { id: string; who: string; working: boolean; used: number }[], max = MAX_AGENT_TABS) {
  const agents = tabs.filter((t) => t.who !== YOU)
  if (agents.length < max) return undefined
  return agents.filter((t) => !t.working).sort((x, y) => x.used - y.used)[0]?.id ?? null
}
