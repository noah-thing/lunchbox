import type { Usage } from '../../shared/types'

type Parts = Pick<Usage, 'gross' | 'saved' | 'spared' | 'trimmed' | 'warmed' | 'pings'>

export const cash = (n: number) => (n <= -0.005 ? `-$${(-n).toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? '<$0.01' : '$0.00')

// What the cached reads saved at list price. Rows from before it was recorded fall back to the net.
export const cached = (u: Parts) => u.gross ?? Math.max(0, u.saved ?? 0)
// What Lunchbox itself saved, after what keeping rooms warm cost. Can go below zero in a week of
// rooms kept warm that nobody came back to, and is shown as it is.
export const own = (u: Parts) => (u.spared ?? 0) + (u.trimmed ?? 0) + (u.warmed ?? 0) - (u.pings ?? 0)
// One figure for a turn, a room, an agent or a week: both of the above.
export const savedIn = (u: Parts) => cached(u) + own(u)

// The same figure split by what did the saving, for showing beside the thing it was saved on.
export function savedBy(u: Parts): { how: string; amount: number }[] {
  return [
    { how: 'cached reads', amount: cached(u) },
    { how: 'not sent twice', amount: u.spared ?? 0 },
    { how: 'shorter command output', amount: u.trimmed ?? 0 },
    { how: 'cache lifetime', amount: (u.warmed ?? 0) - (u.pings ?? 0) },
  ].filter((p) => Math.abs(p.amount) >= 0.005)
}

export const savedLine = (u: Parts) => savedBy(u).map((p) => `${cash(p.amount)} ${p.how}`).join(', ')
