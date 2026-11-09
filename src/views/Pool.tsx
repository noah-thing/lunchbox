import { useMemo, type CSSProperties } from 'react'
import { CATEGORIES, rating } from '../../shared/route'
import type { AgentInfo, PlanWindow, Usage } from '../../shared/types'
import { Mark, Meter } from '../ui/bits'
import { IconShare } from '../ui/icons'
import { clock, desk, money, now, reason, reload, tokens, unavailable, useApp } from '../lib/desk'
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
  const ready = present.filter((a) => !unavailable(a)).length
  const route = settings.route ?? 'best'

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
          <Stat label="Ready now" value={`${ready}/${present.length}`} line={ready === present.length ? 'Everyone can take work' : 'Some are resting'} />
        </div>

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
            Who leads what<span className="quiet">ratings move every time you keep one answer over others</span>
            <span className="seg">
              <button className={route === 'best' ? 'on' : ''} onClick={() => reload.settings({ route: 'best' })}>Best for the job</button>
              <button className={route === 'order' ? 'on' : ''} onClick={() => reload.settings({ route: 'order' })}>Crew order</button>
            </span>
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

function Stat({ label, value, line, open }: { label: string; value: string; line: string; open?: () => void }) {
  const body = <><small>{label}</small><b>{value}</b><span>{line}</span></>
  return open ? <button className="stat link" onClick={open} title="Open Savings">{body}</button> : <div className="stat">{body}</div>
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
  const line = why && !out ? why : `${via}${used ? ` · ${tokens(used.input + used.output + used.cached)} tokens today` : ' · nothing used today'}`
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

// One plan window: what is left, when it resets, and what the whole window holds once measured.
function WindowRow({ w, stale, at }: { w: PlanWindow; stale?: boolean; at?: number }) {
  const left = Math.max(0, 1 - w.used)
  const tip = w.tokens
    ? `About ${tokens(w.tokens)} tokens fit in this window, measured from ${w.samples} steps of your own turns. Use of the same plan elsewhere at the same time makes this read low.`
    : `Lunchbox measures how many tokens this window holds as the percentage moves during your turns. ${w.samples ? `${w.samples} of 3 steps so far.` : 'No steps yet.'}`
  return (
    <div className="window" title={stale && at ? `As of the last Codex run, ${clock(at)}` : undefined}>
      <span className="wlabel">{w.label}</span>
      <Meter value={left} cells={14} tone={left < 0.15 ? 'warn' : undefined} />
      <span className="wleft">{Math.round(left * 100)}% left</span>
      <span className="wreset">{w.resets ? `resets ${when(w.resets)}` : ''}</span>
      <span className="wtotal" title={tip}>{w.tokens ? `≈ ${tokens(w.tokens)}` : 'measuring'}</span>
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
