import { useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react'
import type { Day, Usage } from '../../shared/types'
import { Mark } from '../ui/bits'
import { desk, money, tokens, useApp } from '../lib/desk'
import { drawSavingsCard } from '../ui/shareCard'
import { IconClose } from '../ui/icons'
import type { View } from '../App'

const zero = (): Usage => ({ input: 0, output: 0, cached: 0, cost: 0, saved: 0, gross: 0, kept: 0 })
const add = (a: Usage, u: Usage): Usage => ({
  input: a.input + u.input, output: a.output + u.output, cached: a.cached + u.cached, cost: a.cost + u.cost,
  saved: (a.saved ?? 0) + (u.saved ?? 0), gross: gross(a) + gross(u), kept: (a.kept ?? 0) + (u.kept ?? 0),
})
const total = (r: Record<string, Usage> | undefined) => Object.values(r ?? {}).reduce(add, zero())
// Everything an agent read: billed in full, read from the provider's cache, or never sent
// because the agent's own session already had it.
const read = (u: { input: number; cached: number; kept?: number }) => u.input + u.cached + (u.kept ?? 0)
const reused = (u: { cached: number; kept?: number }) => u.cached + (u.kept ?? 0)
const ratio = (u: { input: number; cached: number; kept?: number }) => (read(u) ? reused(u) / read(u) : 0)
// What the cached reads saved at list price. Rows from before it was recorded fall back to the net.
const gross = (u: Usage) => u.gross ?? Math.max(0, u.saved ?? 0)
// Agents that report no cost and have no price here are counted in tokens, never guessed.
const priced = (u: Usage) => u.gross !== undefined || u.saved !== undefined
const cash = (n: number) => (n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? '<$0.01' : '$0.00')
const pct = (n: number) => (n > 0 && n < 0.005 ? '<1%' : `${(n * 100).toFixed(n >= 0.995 || n === 0 ? 0 : 1)}%`)

export function Savings({ go }: { go: (v: View) => void }) {
  const ledger = useApp((s) => s.ledger)
  const agents = useApp((s) => s.agents)
  const rooms = useApp((s) => s.rooms)
  const week = total(ledger?.week)
  const days = ledger?.days ?? []
  const last7 = days.slice(-7)
  const [card, setCard] = useState<string | null>(null)

  const crew = Object.entries(ledger?.week ?? {})
    .map(([id, u]) => ({ a: agents.find((x) => x.id === id), id, u }))
    .filter((x) => read(x.u) > 0)
    .sort((x, y) => gross(y.u) - gross(x.u) || reused(y.u) - reused(x.u))
  const top = Object.entries(ledger?.rooms ?? {})
    .map(([id, u]) => ({ room: rooms.find((r) => r.id === id), id, u }))
    .filter((x) => x.room && read(x.u) > 0)
    .sort((x, y) => gross(y.u) - gross(x.u) || reused(y.u) - reused(x.u))
    .slice(0, 6)

  return (
    <div className="page">
      <div className="pagebody wide savings">
        <header className="pagehead row rise">
          <div className="grow">
            <h1>Savings</h1>
            <p>What prompt caching saved across your rooms. Your agents still read the whole room, nothing is cut.</p>
          </div>
          <div className="sv-actions">
          <span className="sv-range">Last 7 days</span>
          {(gross(week) > 0 || reused(week) > 0) && <button className="btn small quiet" onClick={async () => {
            const money = gross(week) > 0
            setCard(await drawSavingsCard({
              headline: money ? cash(gross(week)) : tokens(reused(week)),
              line: money ? 'saved with prompt caching' : 'tokens read from cache instead of paid in full',
              stats: [
                { value: tokens(reused(week)), label: 'tokens from cache' },
                { value: pct(ratio(week)), label: 'of every read' },
                { value: String(crew.length), label: crew.length === 1 ? 'agent' : 'agents in the crew' },
              ],
              series: last7.map((d) => (money ? d.gross ?? Math.max(0, d.saved) : reused(d))),
              range: 'Last 7 days',
            }))
          }}>Share</button>}
          </div>
        </header>
        {card && <ShareCard image={card} close={() => setCard(null)} />}

        <div className="sv-kpis rise" style={{ '--i': 1 } as CSSProperties}>
          <Kpi label="Saved with prompt caching" value={gross(week) > 0 ? cash(gross(week)) : reused(week) > 0 ? `${tokens(reused(week))} tokens` : '$0.00'}
            series={last7.map((d) => d.gross ?? Math.max(0, d.saved))}
            note={gross(week) <= 0 && reused(week) > 0 ? 'Counted in tokens for agents that report no cost' : undefined}
            info={`At API list prices: a cached read on Claude costs a tenth of a fresh one, or less on the newest models. Writing the cache costs a little extra on the first turn of a room${gross(week) > 0 ? `, ${cash(Math.max(0, gross(week) - (week.saved ?? 0)))} this week, so the net saving is ${cash(Math.max(0, week.saved ?? 0))}` : ''}. Claude is priced per model; other agents are worked out from the cost they report, with a cached read counted at a quarter of a fresh one, so their saving is if anything higher. Agents that report no cost are counted in tokens. On a plan this means more room before your limit.`} />
          <Kpi label="Tokens saved" value={tokens(reused(week))} series={last7.map(reused)}
            info="Tokens your agents read without paying full price: either the provider had them cached and charged a fraction of the price, or the agent already had them and Lunchbox skipped sending them." />
          <Kpi label="Savings rate" value={pct(ratio(week))} series={last7.map(ratio)} unit
            info="The share of everything your agents read that was saved by caching. Long rooms push this up." />
          <Kpi label="Tokens read" value={tokens(read(week))} series={last7.map(read)}
            info="Everything your agents read in the last 7 days, saved or not. Each turn rereads the room, so this grows fast in long rooms." />
        </div>

        <Card title="Tokens per day" info="Each bar is one day of everything your agents read: the part caching saved, and the part paid in full." className="rise" style={{ '--i': 2 } as CSSProperties}
          right={<Legend items={[['reuse', 'Saved by caching'], ['fresh', 'Paid in full']]} />}>
          <Chart days={days} />
        </Card>

        <Card title="By agent" info="Last 7 days. The savings rate is the share of what each agent read that caching saved." className="rise" style={{ '--i': 3 } as CSSProperties}>
          {crew.length ? (
            <Table head={['Agent', 'Tokens saved', 'Paid in full', 'Savings rate', 'Saved']}>
              {crew.map(({ a, id, u }) => (
                <div className="sv-row" key={id}>
                  <span className="sv-who">{a ? <Mark seed={a.mark} size={16} /> : <i className="sv-gap" />}{a?.name ?? id}</span>
                  <span className="sv-num">{tokens(reused(u))}</span>
                  <span className="sv-num sv-dim">{tokens(u.input)}</span>
                  <span className="sv-ratio"><i style={{ '--w': ratio(u) } as CSSProperties} /><b>{pct(ratio(u))}</b></span>
                  <span className="sv-num">{gross(u) > 0 ? cash(gross(u)) : <em>{a?.via === 'local' ? 'free' : reused(u) > 0 && !priced(u) ? 'tokens only' : 'none yet'}</em>}</span>
                </div>
              ))}
            </Table>
          ) : <Empty go={go} />}
        </Card>

        {top.length > 0 && (
          <Card title="By room" info="Rooms that saved the most. Long rooms save more, because every turn rereads everything before it." className="rise" style={{ '--i': 4 } as CSSProperties}>
            <Table head={['Room', 'Tokens saved', 'Paid in full', 'Savings rate', 'Saved']}>
              {top.map(({ room, id, u }) => (
                <button className="sv-row sv-link" key={id} onClick={() => go({ name: 'room', id })}>
                  <span className="sv-who">{room!.name}</span>
                  <span className="sv-num">{tokens(reused(u))}</span>
                  <span className="sv-num sv-dim">{tokens(u.input)}</span>
                  <span className="sv-ratio"><i style={{ '--w': ratio(u) } as CSSProperties} /><b>{pct(ratio(u))}</b></span>
                  <span className="sv-num">{gross(u) > 0 ? cash(gross(u)) : <em>{reused(u) > 0 && !priced(u) ? 'tokens only' : 'none yet'}</em>}</span>
                </button>
              ))}
            </Table>
          </Card>
        )}
      </div>
    </div>
  )
}

function Info({ text }: { text: string }) {
  return <span className="sv-info" tabIndex={0} aria-label={text}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 7.25v3.75" strokeLinecap="round" /><circle cx="8" cy="5.1" r=".2" strokeWidth="1.4" /></svg><span className="sv-tip" role="tooltip">{text}</span></span>
}

function Card({ title, info, right, children, className = '', style }: { title: string; info: string; right?: ReactNode; children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <section className={`sv-card ${className}`} style={style}>
      <header><h2>{title}</h2><Info text={info} /><span className="grow" />{right}</header>
      {children}
    </section>
  )
}

function Kpi({ label, value, series, info, note, unit = false }: { label: string; value: string; series: number[]; info: string; note?: string; unit?: boolean }) {
  return (
    <div className="sv-kpi">
      <header><small>{label}</small><Info text={info} /></header>
      <div className="sv-kpibody">
        <span className="sv-value"><b>{value}</b>{note && <small>{note}</small>}</span>
        <Spark values={series} max={unit ? 1 : undefined} />
      </div>
    </div>
  )
}

// A week as a line with a faint fill under it. Flat zero stays a hairline on the floor.
function Spark({ values, max }: { values: number[]; max?: number }) {
  const id = useId()
  const W = 96, H = 34
  const top = max ?? Math.max(...values, 0)
  if (values.length < 2) return <svg className="sv-spark" width={W} height={H} />
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, H - 2 - (top ? (v / top) * (H - 6) : 0)] as const)
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  return (
    <svg className="sv-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".18" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
      <path d={`${line} L${W} ${H} L0 ${H} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

function Legend({ items }: { items: [string, string][] }) {
  return <span className="sv-legend">{items.map(([k, label]) => <span key={k}><i className={`sv-${k}`} />{label}</span>)}</span>
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="sv-table">
      <div className="sv-thead">{head.map((h) => <span key={h}>{h}</span>)}</div>
      {children}
    </div>
  )
}

function Empty({ go }: { go: (v: View) => void }) {
  return (
    <div className="sv-empty">
      <span>No turns in the last 7 days.</span>
      <button className="btn small quiet" onClick={() => go({ name: 'new' })}>Start a room</button>
    </div>
  )
}

// Stacked bars on a light grid: what caching saved at the bottom, what was paid in full on top.
function Chart({ days }: { days: Day[] }) {
  const max = Math.max(...days.map((d) => read(d)), 0)
  const step = nice(max / 2)
  const top = Math.max(step * 2, 1)
  return (
    <div className="sv-chart">
      <div className="sv-grid" aria-hidden="true">
        {[2, 1, 0].map((k) => <div key={k}><span>{k ? tokens(step * k) : '0'}</span><i /></div>)}
      </div>
      <div className="sv-bars">
        {days.map((d, i) => {
          const date = new Date(d.day + 'T12:00:00')
          const label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
          const h = (n: number) => `${(n / top) * 100}%`
          return (
            <div key={d.day} className="sv-bar" style={{ '--i': i } as CSSProperties}>
              <div className="sv-stack" tabIndex={0}>
                <i className="sv-fresh" style={{ height: h(d.input) }} />
                <i className="sv-reuse" style={{ height: h(reused(d)) }} />
                <span className="sv-tip" role="tooltip">
                  <b>{label}</b>
                  <span><i className="sv-reuse" />Saved by caching<em>{tokens(reused(d))}</em></span>
                  <span><i className="sv-fresh" />Paid in full<em>{tokens(d.input)}</em></span>
                  {(d.gross ?? d.saved) >= 0.01 && <span className="sv-saved">Saved<em>{money(d.gross ?? d.saved)}</em></span>}
                </span>
              </div>
              <small>{i === days.length - 1 ? 'Today' : i % 2 ? '' : label}</small>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function nice(n: number) {
  if (n <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(n))
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((v) => v >= n)!
}

// The card, shown before it goes anywhere. Copy and save keep the image; Post on X copies it first,
// so it is one paste away in the composer X opens.
function ShareCard({ image, close }: { image: string; close: () => void }) {
  const [said, setSaid] = useState('')
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    addEventListener('keydown', esc)
    return () => removeEventListener('keydown', esc)
  }, [close])
  const copy = async () => { try { await desk.call('image:copy', image); setSaid('Copied') } catch { setSaid('Could not copy. Save it instead') } }
  const post = async () => {
    try { await desk.call('image:copy', image); setSaid('Copied. Paste it into your post') } catch { setSaid('Save the image, then attach it to your post') }
    window.open(`https://x.com/intent/post?text=${encodeURIComponent('My AI agents saved this much this week, working together in one app.\n\nhttps://mylunchbox.dev')}`, '_blank')
  }
  return (
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="ncard sharecard" role="dialog" aria-label="Share your savings">
        <img src={image} alt="Your Lunchbox savings for the last 7 days" width={1200} height={675} />
        <div className="nbody">
          <div className="row">
            <button className="iconbtn" onClick={close} aria-label="Close"><IconClose /></button>
            <span className="grow sharesaid">{said}</span>
            <button className="btn small quiet" onClick={async () => { try { if (await desk.call('image:save', image, 'lunchbox-savings')) setSaid('Saved') } catch { setSaid('Could not save') } }}>Save</button>
            <button className="btn small quiet" onClick={copy}>Copy image</button>
            <button className="btn small" onClick={post}>Post on X</button>
          </div>
        </div>
      </div>
    </div>
  )
}
