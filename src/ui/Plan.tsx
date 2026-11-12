import { memo, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

// The agent's plan, drawn as it arrives: each box is traced in one line from its corner, then its
// step fades in, then the next row starts. However fast the list streams, rows keep this order and
// pace. Once drawn, the room panel opens on it and the rows here close up, so the plan lives in
// one place, where the steps tick off as the work goes.
// Everything that moves is transform, opacity or a stroke, so a long room stays smooth.

type Item = { text: string; check?: boolean }
const PACE = 340
const HOLD = 1200

// The panel draws a new plan as the chat hands it over, not before.
let handing = false
const handed = new Set<() => void>()
export const handingOver = () => handing
// While a plan is being drawn in the chat, the live line under it waits to name the step.
let drawn = 0
export const planDrawing = () => drawn > 0
export function onHanded(f: () => void) {
  handed.add(f)
  return () => { handed.delete(f) }
}

export function PlanCard({ items, live, plan, render }: { items: Item[]; live: boolean; plan: boolean; render: (text: string) => ReactNode }) {
  const start = useRef(performance.now())
  const [stage, setStage] = useState<'here' | 'leaving' | 'gone'>('here')
  const count = items.length
  const latest = useRef({ count, plan })
  latest.current = { count, plan }

  // Only the room's plan holds back the step line; a side-by-side answer's own list does not.
  useEffect(() => {
    if (!live || !plan || stage !== 'here') return
    drawn++
    return () => { drawn-- }
  }, [live, plan, stage])

  // When the last row has drawn and the list has stopped growing, the plan goes to the panel: the
  // panel opens and draws it while the rows here close up.
  useEffect(() => {
    if (!live || stage !== 'here') return
    const due = start.current + (count - 1) * PACE + 900 + HOLD - performance.now()
    const t = setTimeout(() => {
      if (latest.current.count !== count || !latest.current.plan) return
      handing = true
      dispatchEvent(new Event('lunchbox:plan'))
      setStage('leaving')
      requestAnimationFrame(() => { handing = false; for (const f of [...handed]) f() })
    }, Math.max(HOLD, due))
    return () => clearTimeout(t)
  }, [count, live, stage])

  if (stage === 'gone') return null
  const active = live ? items.findIndex((i) => !i.check) : -1
  return (
    <div className={`plan${live && stage === 'here' ? ' drawing' : ''}${stage === 'leaving' ? ' leaving' : ''}`} onTransitionEnd={(e) => { if (stage === 'leaving' && e.target === e.currentTarget) setStage('gone') }}>
      <ol>
        {items.map((it, i) => <PlanRow key={i} i={i} start={start.current} done={!!it.check} on={i === active} live={live && stage === 'here'} text={it.text} render={render} />)}
      </ol>
    </div>
  )
}

export function Bar({ items, active }: { items: { done?: boolean }[]; active: number }) {
  return (
    <div className="planbar" aria-hidden>
      {items.map((it, i) => <i key={i} className={it.done ? 'done' : i === active ? 'on' : ''} />)}
    </div>
  )
}

type RowProps = { i: number; start: number; done: boolean; on: boolean; live: boolean; text: string; render: (text: string) => ReactNode; after?: ReactNode }

// Rows only change when their own step does, not on every letter the agent streams.
export const PlanRow = memo(function PlanRow({ i, start, done, on, live, text, render, after }: RowProps) {
  // Rows that stream in late start at once; rows that arrive together wait their turn.
  const [delay] = useState(() => (live ? Math.max(0, start + i * PACE - performance.now()) : 0))
  // A step that arrives already done is drawn first and ticked after, so the tick still reads.
  const [ticked, setTicked] = useState(done && !live)
  const first = useRef(true)
  useEffect(() => {
    const wait = first.current && live ? delay + 520 : 0
    first.current = false
    if (!done) { setTicked(false); return }
    const t = setTimeout(() => setTicked(true), wait)
    return () => clearTimeout(t)
  }, [done])
  return (
    <li className={`planrow${ticked ? ' done' : ''}${on && !done ? ' on' : ''}`} style={{ '--d': `${Math.round(delay)}ms` } as CSSProperties}>
      <svg className="planbox" viewBox="0 0 16 16" aria-hidden>
        <rect className="frame" x="1.5" y="1.5" width="13" height="13" rx="3.5" pathLength={1} />
        <rect className="fill" x="1.5" y="1.5" width="13" height="13" rx="3.5" />
        <path className="tick" d="M4.6 8.3 7 10.6 11.5 5.6" pathLength={1} />
        <circle className="pulse" cx="8" cy="8" r="2.2" />
      </svg>
      <span className="plantext"><span className="planstep">{render(text)}</span>{after}</span>
    </li>
  )
}, (a, b) => a.text === b.text && a.done === b.done && a.on === b.on && a.live === b.live && a.after === b.after)
