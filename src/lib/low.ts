import type { PlanLimits } from '../../shared/types'

// The agent about to answer, when one of its plan windows is nearly used up, said before the
// message goes rather than after it stops. Who would take over is in the hint.
const WINDOW: Record<string, string> = { '5h': 'five hour window', week: 'week', day: 'day' }

export function lowOn(ready: string[], limits: Record<string, PlanLimits>, name: (id: string) => string) {
  const main = ready[0]
  const l = main ? limits[main] : undefined
  if (!l || l.reached || l.stale || l.error) return null
  const w = l.windows.filter((x) => x.used >= 0.9 && x.used < 1).sort((a, b) => b.used - a.used)[0]
  if (!w) return null
  const left = Math.max(1, Math.round((1 - w.used) * 100))
  return { text: `${name(main)}: ${left}% of its ${WINDOW[w.id] ?? w.label.toLowerCase()} left`, next: ready[1] ? name(ready[1]) : null }
}
