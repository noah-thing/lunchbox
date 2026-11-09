import { useMemo, useState, type CSSProperties } from 'react'
import { CATEGORIES, rating } from '../../shared/route'
import type { AgentInfo, PlanLimits, PlanWindow, Usage } from '../../shared/types'
import { Mark, Meter } from '../ui/bits'
import { IconShare } from '../ui/icons'
import { clock, desk, money, now, reason, tokens, unavailable, useApp } from '../lib/desk'
import type { View } from '../App'

const sum = (r: Record<string, Usage> | undefined) =>
  Object.values(r ?? {}).reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output, cached: a.cached + u.cached, cost: a.cost + u.cost }), { input: 0, output: 0, cached: 0, cost: 0 })

export function Pool({ go, say }: { go: (v: View) => void; say: (t: string) => void }) {
  const agents = useApp((s) => s.agents)
  const ledger = useApp((s) => s.ledger)
  const settings = useApp((s) => s.settings)
  const present = agents.filter((a) => a.found && !settings.disabled.includes(a.id))
  const today = sum(ledger?.today)
  const week = sum(ledger?.week)
  const cacheShare = week.input + week.cached > 0 ? week.cached / (week.input + week.cached) : 0
  const limits = useApp((s) => s.limits)
  const [open, setOpen] = useState(false)
  const pool = weeklyPool(present, limits, settings.budgets)

  return (
    <div className="page">
      <div className="pagebody wide">
        <header className="pagehead rise">
          <h1>Pool</h1>
          <p>Every plan, key and local model you have, as one allowance. Work goes to whoever is best at it and has room left.</p>
        </header>

        <div className="stats rise" style={{ '--i': 1 } as CSSProperties}>
          <Stat label="Today" value={money(today.cost)} line={`${tokens(today.input + today.output)} tokens`} />
          <Stat label="Last 7 days" value={money(week.cost)} line={`${tokens(week.input + week.output)} tokens`} />
          <Stat label="Served from cache" value={`${Math.round(cacheShare * 100)}%`} line={`${tokens(week.cached)} tokens not paid twice`} open={() => go({ name: 'savings' })} />
          <Stat label="Your weekly pool" value={pool.total ? `${tokens(pool.total)} tokens` : 'Not sized yet'} line={pool.total ? `${tokens(pool.left)} left this week` : 'Grows as your plans are used'} open={() => setOpen(!open)} hint={open ? 'Hide what makes up your pool' : 'See what makes up your pool'} on={open} />
        </div>
        {open && <PoolBreakdown rows={pool.rows} />}

        <section className="group rise" style={{ '--i': 2 } as CSSProperties}>
          <h2>Two weeks<span className="quiet">cost per day</span></h2>
          <Days days={ledger?.days ?? []} />
        </section>

        <section className="group rise" style={{ '--i': 3 } as CSSProperties}>
          <h2>Allowance<span className="quiet">what each plan has left, from the providers themselves</span></h2>
          <div className="settings">
            {present.map((a) => <Allowance key={a.id} a={a} />)}
            {!present.length && <div className="setting"><span className="grow">No agents yet.</span><button className="btn small quiet" onClick={() => go({ name: 'agents' })}>Connect agents</button></div>}
          </div>
        </section>

        <section className="group rise" style={{ '--i': 4 } as CSSProperties}>
          <h2>
            Who is best at what<span className="quiet">ratings move every time you keep one answer over others</span>
          </h2>
          <Ratings agents={present} />
          <div className="row">
            <span className="hint grow">Send one message to several agents with the side by side button in the composer, then keep the best answer. Wins so far: {Object.values(ledger?.arena ?? {}).reduce((a, b) => a + b, 0)}.</span>
            <button className="btn small quiet" onClick={() => shareCard(present, say)}><IconShare />Share card</button>
          </div>
        </section>
      </div>
    </div>
  )
}

function Stat({ label, value, line, open, hint = 'Open Savings', on = false }: { label: string; value: string; line: string; open?: () => void; hint?: string; on?: boolean }) {
  const body = <><small>{label}</small><b>{value}</b><span>{line}</span></>
  return open ? <button className={`stat link${on ? ' on' : ''}`} onClick={open} title={hint} aria-expanded={on}>{body}</button> : <div className="stat">{body}</div>
}

type PoolRow = { a: AgentInfo; size: string; left?: string; note: string }

// Everything you can spend in a week, added up across plans. Token windows are summed; Gemini
// counts requests and API keys are pay as you go, so they are listed beside the total, not in it.
function weeklyPool(present: AgentInfo[], limits: Record<string, PlanLimits | undefined>, budgets: Record<string, number>) {
  let total = 0
  let left = 0
  const rows: PoolRow[] = present.map((a) => {
    const windows = limits[a.id]?.windows ?? []
    const week = windows.find((w) => /week/i.test(w.label))
    const day = windows.find((w) => /day/i.test(w.label))
    if (a.via === 'local') return { a, size: 'Unlimited', note: 'Runs on this computer, free' }
    if (a.via !== 'cli') return { a, size: 'Pay as you go', note: budgets[a.id] ? `Capped at ${money(budgets[a.id])} a day` : 'No daily cap set' }
    if (week?.total && week.unit !== 'requests') {
      total += week.total
      left += week.total * Math.max(0, 1 - week.used)
      return { a, size: `${tokens(week.total)} tokens`, left: `${tokens(week.total * Math.max(0, 1 - week.used))} left`, note: week.resets ? `Resets ${when(week.resets)}` : 'Weekly window' }
    }
    if (day?.total && day.unit === 'requests') {
      return { a, size: `${Math.round(day.total * 7).toLocaleString()} requests`, left: `${Math.round(day.total * Math.max(0, 1 - day.used)).toLocaleString()} left today`, note: `${Math.round(day.total).toLocaleString()} a day, counted in requests` }
    }
    if (week) return { a, size: 'Sized after its first turn', note: 'The provider shares a percentage, the size comes from use' }
    return { a, size: 'No published limit', note: 'This tool does not report a plan limit' }
  })
  return { total, left, rows }
}

function PoolBreakdown({ rows }: { rows: PoolRow[] }) {
  return (
    <div className="poolrows rise">
      {rows.map(({ a, size, left, note }) => (
        <div key={a.id} className="poolrow">
          <Mark seed={a.mark} size={16} />
          <b>{a.name}</b>
          <span className="psize">{size}</span>
          <span className="pleft">{left ?? ''}</span>
          <span className="pnote">{note}</span>
        </div>
      ))}
    </div>
  )
}

// Each day is a column of cells; a lit cell is a share of the busiest day.
function Days({ days }: { days: { day: string; cost: number; tokens: number }[] }) {
  const max = Math.max(...days.map((d) => d.cost), 0.01)
  const H = 12
  return (
    <div className="days">
      {days.map((d, i) => {
        const lit = d.cost > 0 ? Math.max(1, Math.round((d.cost / max) * H)) : 0
        const date = new Date(d.day + 'T12:00:00')
        return (
          <div key={d.day} className="day" style={{ '--i': i } as CSSProperties} title={`${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${money(d.cost)}, ${tokens(d.tokens)} tokens`}>
            <div className="cells">{Array.from({ length: H }, (_, k) => <i key={k} className={H - k <= lit ? 'on' : ''} />)}</div>
            <small>{i === days.length - 1 ? 'today' : date.toLocaleDateString(undefined, { weekday: 'narrow' })}</small>
          </div>
        )
      })}
    </div>
  )
}

function Allowance({ a }: { a: AgentInfo }) {
  const ledger = useApp((s) => s.ledger)
  const limits = useApp((s) => s.limits[a.id])
  const budget = useApp((s) => s.settings.budgets[a.id] ?? 0)
  const used = ledger?.today[a.id]
  const spent = ledger?.spent[a.id]
  const why = unavailable(a)
  const out = spent && spent.until > Date.now()
  const windows = limits?.windows ?? []
  const left = budget > 0 ? Math.max(0, 1 - (used?.cost ?? 0) / budget) : out ? 0 : 1
  const via = a.via === 'cli' ? (limits?.plan ? `${limits.plan} plan` : 'Your plan') : a.via === 'local' ? 'This computer, free' : 'Your API key'
  const line = why && !out ? why : `${via}${used ? ` · ${tokens(used.input + used.output + used.cached)} tokens today in Lunchbox` : ' · nothing used in Lunchbox today'}`
  return (
    <div className="setting allowance">
      <Mark seed={a.mark} size={20} />
      <div className="grow">
        <b>{a.name}</b>
        <span>{line}</span>
        {limits?.error && !windows.length && <span className="limitnote">{limits.error}</span>}
      </div>
      {windows.length ? (
        <div className="windows">
          {windows.map((w) => <WindowRow key={w.id} w={w} stale={limits?.stale} at={limits?.at} />)}
        </div>
      ) : (
        <>
          <span className={`state${why ? out ? ' warn' : ' off' : ''}`}>{out ? `Back at ${clock(spent!.until)}` : why ? 'Unavailable' : 'Ready'}</span>
          <Meter value={left} cells={16} tone={left < 0.2 ? 'warn' : undefined} />
          <span className="mono quiet amount">{budget > 0 ? `${money(budget)}/day` : a.via === 'api' ? 'no cap' : a.via === 'local' ? 'free' : 'no limits'}</span>
        </>
      )}
    </div>
  )
}

// One plan window: what is left, how big the window is, and when it starts over.
function WindowRow({ w, stale, at }: { w: PlanWindow; stale?: boolean; at?: number }) {
  const left = Math.max(0, 1 - w.used)
  const count = (n: number) => (w.unit === 'requests' ? Math.round(n).toLocaleString() : tokens(n))
  const size = w.total
    ? `${count(w.total * left)} of ${count(w.total)}${w.unit === 'requests' ? ' requests' : ''}`
    : 'not used yet'
  const spend = w.allowance ? (w.currency === 'credits' ? `${Math.round(w.allowance).toLocaleString()} credits` : `$${w.allowance.toFixed(w.allowance < 10 ? 2 : 0)} at list prices`) : ''
  const tip = w.unit === 'requests'
    ? `Google publishes this limit. Requests are counted from Gemini CLI's own log of today's replies.`
    : w.total
      ? `This window holds about ${spend}, about ${count(w.total)} tokens at the mix of models you use. Measured from how far the ${w.share !== undefined ? 'Grok Build share of the pool' : 'percentage'} moved against what this computer's logs spent, over the last month. Use on another computer or the web counts toward the plan but not these logs, so the upper measurements are the ones trusted.`
      : `This plan has not been used on this computer yet. Its size is worked out from what the first turns spend.`
  return (
    <div className={`window${stale ? ' stale' : ''}`} title={stale && at ? `Last read at ${clock(at)}` : undefined}>
      <span className="wlabel">{w.label}</span>
      <Meter value={left} cells={14} tone={left < 0.15 ? 'warn' : undefined} />
      <span className="wleft">{Math.round(left * 100)}% left</span>
      <span className="wtotal" title={tip}>{size}</span>
      <span className="wreset">{w.resets ? `resets ${when(w.resets)}` : ''}</span>
    </div>
  )
}

function when(t: number) {
  const d = new Date(t)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return clock(t)
  if (t - Date.now() < 6 * 86400e3) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${clock(t)}`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function Ratings({ agents }: { agents: AgentInfo[] }) {
  const ratings = useApp((s) => s.ledger?.ratings ?? {})
  const cats = CATEGORIES.filter((c) => c.id !== 'general')
  const best = useMemo(() => Object.fromEntries(cats.map((c) => {
    const top = [...agents].sort((x, y) => rating(ratings, c.id, y.id).r - rating(ratings, c.id, x.id).r)[0]
    return [c.id, top?.id]
  })), [agents, ratings])
  if (!agents.length) return null
  return (
    <div className="ratings" style={{ '--cols': agents.length } as CSSProperties}>
      <div className="rhead"><span />{agents.map((a) => <span key={a.id} title={a.name}><Mark seed={a.mark} size={14} />{a.short}</span>)}</div>
      {cats.map((c, i) => (
        <div key={c.id} className="rrow" style={{ '--i': i } as CSSProperties}>
          <span>{c.name}</span>
          {agents.map((a) => {
            const r = rating(ratings, c.id, a.id)
            return <span key={a.id} className={best[c.id] === a.id ? 'lead' : ''} title={r.n ? `${r.n} side by side${r.n > 1 ? 's' : ''}` : 'Starting rating, not played yet'}>{r.r}{best[c.id] === a.id && <i>leads</i>}</span>
          })}
        </div>
      ))}
    </div>
  )
}

// A 1200 by 675 card for X: who leads what in your own side by sides. Drawn as SVG, saved as PNG.
async function shareCard(agents: AgentInfo[], say: (t: string) => void) {
  const { ledger } = now()
  const ratings = ledger?.ratings ?? {}
  const cats = CATEGORIES.filter((c) => c.id !== 'general')
  const ink = '#f2f0ea', faint = 'rgba(242,240,234,.4)', line = 'rgba(242,240,234,.1)'
  const colW = Math.min(170, 860 / Math.max(1, agents.length))
  const rows = cats.map((c, i) => {
    const y = 250 + i * 62
    const top = [...agents].sort((x, y2) => rating(ratings, c.id, y2.id).r - rating(ratings, c.id, x.id).r)[0]
    return `<line x1="80" x2="1120" y1="${y + 22}" y2="${y + 22}" stroke="${line}"/><text x="80" y="${y}" fill="${ink}" font-size="24">${c.name}</text>` +
      agents.map((a, k) => `<text x="${300 + k * colW}" y="${y}" fill="${top?.id === a.id ? ink : faint}" font-size="24" font-family="IBM Plex Mono, Menlo, monospace" ${top?.id === a.id ? 'font-weight="600"' : ''}>${rating(ratings, c.id, a.id).r}</text>`).join('')
  }).join('')
  const heads = agents.map((a, k) => `<text x="${300 + k * colW}" y="200" fill="${faint}" font-size="20">${a.short}</text>`).join('')
  const games = Object.values(ledger?.arena ?? {}).reduce((x, y) => x + y, 0)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" font-family="Helvetica Neue, Helvetica, Arial, sans-serif">
<rect width="1200" height="675" fill="#0d0d0c"/>
<text x="80" y="110" fill="${ink}" font-size="44" font-weight="500" letter-spacing="-1">Who leads what, in my own side by sides</text>
<text x="80" y="150" fill="${faint}" font-size="20" font-family="IBM Plex Mono, Menlo, monospace">${games} kept answers · ratings move with every pick</text>
${heads}${rows}
<text x="1120" y="630" fill="${faint}" font-size="18" text-anchor="end" font-family="IBM Plex Mono, Menlo, monospace">lunchbox</text>
</svg>`
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = 2400
  canvas.height = 1350
  const g = canvas.getContext('2d')!
  g.scale(2, 2)
  g.drawImage(img, 0, 0)
  try {
    const file = await desk.call('save:png', canvas.toDataURL('image/png'), 'lunchbox-ratings.png')
    if (file) say('Card saved')
  } catch (e) {
    say(reason(e))
  }
}
