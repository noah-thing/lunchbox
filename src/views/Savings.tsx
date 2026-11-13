import { useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react'
import { useModal } from '../lib/modal'
import type { Day, Usage } from '../../shared/types'
import { Mark } from '../ui/bits'
import { desk, money, tokens, useApp } from '../lib/desk'
import { place } from '../lib/fit'
import { drawSavingsCard } from '../ui/shareCard'
import { IconClose } from '../ui/icons'
import type { View } from '../App'

const zero = (): Usage => ({ input: 0, output: 0, cached: 0, cost: 0, saved: 0, gross: 0, kept: 0, premium: 0, cut: 0, held: 0, spared: 0, trimmed: 0, warmed: 0, pings: 0 })
const add = (a: Usage, u: Usage): Usage => ({
  input: a.input + u.input, output: a.output + u.output, cached: a.cached + u.cached, cost: a.cost + u.cost,
  saved: (a.saved ?? 0) + (u.saved ?? 0), gross: gross(a) + gross(u), kept: (a.kept ?? 0) + (u.kept ?? 0), premium: (a.premium ?? 0) + (u.premium ?? 0),
  cut: (a.cut ?? 0) + (u.cut ?? 0), held: (a.held ?? 0) + (u.held ?? 0), spared: (a.spared ?? 0) + (u.spared ?? 0), trimmed: (a.trimmed ?? 0) + (u.trimmed ?? 0), warmed: (a.warmed ?? 0) + (u.warmed ?? 0), pings: (a.pings ?? 0) + (u.pings ?? 0),
})
const total = (r: Record<string, Usage> | undefined) => Object.values(r ?? {}).reduce(add, zero())
type Counts = { input: number; cached: number; kept?: number; cut?: number }
// What Lunchbox never sent: memory and conversation an agent did not need again, and command
// output it shortened on the way in.
const unsent = (u: { kept?: number; cut?: number }) => (u.kept ?? 0) + (u.cut ?? 0)
// Everything an agent would have read: billed in full, read from the provider's cache, or never sent.
const read = (u: Counts) => u.input + u.cached + unsent(u)
const reused = (u: Counts) => u.cached + unsent(u)
const ratio = (u: Counts) => (read(u) ? reused(u) / read(u) : 0)
// What Lunchbox itself saved at list price, after what keeping rooms warm cost. Can go below
// zero in a week of rooms kept warm that nobody came back to, and is shown as it is.
const own = (u: { spared?: number; trimmed?: number; warmed?: number; pings?: number }) => (u.spared ?? 0) + (u.trimmed ?? 0) + (u.warmed ?? 0) - (u.pings ?? 0)
// What the cached reads saved at list price. Rows from before it was recorded fall back to the net.
const gross = (u: Usage) => u.gross ?? Math.max(0, u.saved ?? 0)
// Agents that report no cost and have no price here are counted in tokens, never guessed.
const priced = (u: Usage) => u.gross !== undefined || u.saved !== undefined
const cash = (n: number) => (n <= -0.005 ? `-$${(-n).toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? '<$0.01' : '$0.00')
const pct = (n: number) => (n > 0 && n < 0.005 ? '<1%' : `${(n * 100).toFixed(n >= 0.995 || n === 0 ? 0 : 1)}%`)

export function Savings({ go }: { go: (v: View) => void }) {
  const ledger = useApp((s) => s.ledger)
  const agents = useApp((s) => s.agents)
  const rooms = useApp((s) => s.rooms)
  const week = total(ledger?.week)
  const days = ledger?.days ?? []
  const last7 = days.slice(-7)
  const [card, setCard] = useState<string | null>(null)
  // What storing the cache cost on top of the input price, where the agent reported it.
  const stored = week.premium ?? 0
  const mine = own(week)
  // The share card adds the two, never below what caching alone saved.
  const both = gross(week) + Math.max(0, mine)

  const crew = Object.entries(ledger?.week ?? {})
    .map(([id, u]) => ({ a: agents.find((x) => x.id === id), id, u }))
    .filter((x) => read(x.u) > 0)
    .sort((x, y) => gross(y.u) + own(y.u) - gross(x.u) - own(x.u) || reused(y.u) - reused(x.u))
  const top = Object.entries(ledger?.rooms ?? {})
    .map(([id, u]) => ({ room: rooms.find((r) => r.id === id), id, u }))
    .filter((x) => x.room && read(x.u) > 0)
    .sort((x, y) => gross(y.u) + own(y.u) - gross(x.u) - own(x.u) || reused(y.u) - reused(x.u))
    .slice(0, 6)

  return (
    <div className="page">
      <div className="pagebody wide savings">
        <header className="pagehead row rise">
          <div className="grow">
            <h1>Savings</h1>
            <p>What Lunchbox saved in your rooms, and what your agents' own prompt caching saved. The two are counted apart.</p>
          </div>
          <div className="sv-actions">
          <span className="sv-range">Last 7 days</span>
          {(both > 0 || reused(week) > 0) && <button className="btn small quiet" onClick={async () => {
            const money = both > 0
            setCard(await drawSavingsCard({
              headline: money ? cash(both) : tokens(reused(week)),
              line: money ? 'saved by Lunchbox and prompt caching, at API list prices' : 'tokens never sent or read from cache',
              stats: [
                { value: tokens(reused(week)), label: 'tokens not paid in full' },
                { value: pct(ratio(week)), label: 'of every read' },
                { value: String(crew.length), label: crew.length === 1 ? 'agent' : 'agents in the crew' },
              ],
              series: last7.map((d) => (money ? Math.max(0, (d.gross ?? Math.max(0, d.saved)) + own(d)) : reused(d))),
              range: 'Last 7 days',
            }))
          }}>Share</button>}
          </div>
        </header>
        {card && <ShareCard image={card} close={() => setCard(null)} />}

        <div className="sv-kpis rise" style={{ '--i': 1 } as CSSProperties}>
          <Kpi label="Saved by Lunchbox" value={mine !== 0 ? cash(mine) : unsent(week) > 0 ? `${tokens(unsent(week))} tokens` : '$0.00'}
            series={last7.map((d) => Math.max(0, own(d)))}
            note={mine === 0 && unsent(week) > 0 ? 'Counted in tokens for agents with no price' : undefined}
            info="What Lunchbox itself saved at API list prices: tokens it never sent, and what it saved by managing how long caches live, with the cost of keeping rooms warm taken off. The same agents outside Lunchbox would not have saved this." />
          <Kpi label="Saved by prompt caching" value={gross(week) > 0 ? cash(gross(week)) : week.cached > 0 ? `${tokens(week.cached)} tokens` : '$0.00'}
            series={last7.map((d) => d.gross ?? Math.max(0, d.saved))}
            note={gross(week) <= 0 && week.cached > 0 ? 'Counted in tokens for agents that report no cost' : undefined}
            info={`What cached reads saved at API list prices. This is your agents' own saving, and they make it outside Lunchbox too. On Claude a cached read costs a tenth of a fresh one, or less on the newest models. Storing the cache costs extra, ${cash(stored)} this week, which leaves ${cash(Math.max(0, gross(week) - stored))} net. A subscription pays nothing per token, so this is what the same work would have cost on an API key.`} />
          <Kpi label="Tokens never sent" value={tokens(unsent(week))} series={last7.map(unsent)}
            info="Tokens Lunchbox kept out of your agents' requests: shared memory and conversation an agent did not need sending again, and long command output shortened to what matters." />
          <Kpi label="Savings rate" value={pct(ratio(week))} series={last7.map(ratio)} unit
            info="The share of everything your agents would have read that was never sent or was read from cache. Long rooms push this up." />
        </div>

        <Card title="What Lunchbox saved" info="Last 7 days. Each line is one thing Lunchbox does that the same agents do not do on their own." className="rise sv-own" style={{ '--i': 2 } as CSSProperties}>
          <div className="sv-table">
            <div className="sv-thead"><span>How</span><span>Tokens</span><span>Saved</span></div>
            <div className="sv-row">
              <span className="sv-how"><b>Not sent twice</b><small>Shared memory an agent already had, and the conversation a crewmate was briefed on instead of reading.</small></span>
              <span className="sv-num">{tokens(week.kept ?? 0)}</span>
              <span className="sv-num">{(week.spared ?? 0) > 0 ? cash(week.spared ?? 0) : <em>{(week.kept ?? 0) > 0 ? 'tokens only' : 'none yet'}</em>}</span>
            </div>
            <div className="sv-row">
              <span className="sv-how"><b>Command output shortened</b><small>Long test, build and install logs cut to their start, their end and the lines that look like problems. The whole output stays in a file.</small></span>
              <span className="sv-num">{tokens(week.cut ?? 0)}</span>
              <span className="sv-num">{(week.trimmed ?? 0) > 0 ? cash(week.trimmed ?? 0) : <em>{(week.cut ?? 0) > 0 ? 'tokens only' : 'none yet'}</em>}</span>
            </div>
            <div className="sv-row">
              <span className="sv-how"><b>Cache lifetime</b><small>Flows and crewmates cache for five minutes at the lower price, and a room you come back to is read from a cache Lunchbox kept alive.{(week.pings ?? 0) > 0 && ` Keeping rooms warm cost ${cash(week.pings ?? 0)}, taken off here.`}</small></span>
              <span className="sv-num">{tokens(week.held ?? 0)}</span>
              <span className="sv-num">{(week.warmed ?? 0) > 0 || (week.pings ?? 0) > 0 ? cash((week.warmed ?? 0) - (week.pings ?? 0)) : <em>none yet</em>}</span>
            </div>
          </div>
        </Card>

        <Card title="Tokens per day" info="Each bar is one day of everything your agents would have read: the part Lunchbox never sent, the part caching saved, and the part paid in full." className="rise" style={{ '--i': 3 } as CSSProperties}
          right={<Legend items={[['lean', 'Never sent'], ['reuse', 'Saved by caching'], ['fresh', 'Paid in full']]} />}>
          <Chart days={days} />
        </Card>

        <Card title="By agent" info="Last 7 days. The savings rate is the share of what each agent would have read that was never sent or was read from cache." className="rise sv-split" style={{ '--i': 4 } as CSSProperties}>
          {crew.length ? (
            <Table head={['Agent', 'Never sent', 'From cache', 'Savings rate', 'Lunchbox', 'Caching']}>
              {crew.map(({ a, id, u }) => (
                <div className="sv-row" key={id}>
                  <span className="sv-who">{a ? <Mark seed={a.mark} size={16} /> : <i className="sv-gap" />}{a?.name ?? id}</span>
                  <span className="sv-num">{tokens(unsent(u))}</span>
                  <span className="sv-num sv-dim">{tokens(u.cached)}</span>
                  <span className="sv-ratio"><i style={{ '--w': ratio(u) } as CSSProperties} /><b>{pct(ratio(u))}</b></span>
                  <span className="sv-num">{own(u) !== 0 ? cash(own(u)) : <em>{a?.via === 'local' ? 'free' : unsent(u) > 0 ? 'tokens only' : 'none yet'}</em>}</span>
                  <span className="sv-num">{gross(u) > 0 ? cash(gross(u)) : <em>{a?.via === 'local' ? 'free' : u.cached > 0 && !priced(u) ? 'tokens only' : 'none yet'}</em>}</span>
                </div>
              ))}
            </Table>
          ) : <Empty go={go} />}
        </Card>

        {top.length > 0 && (
          <Card title="By room" info="Rooms that saved the most. Long rooms save more, because every turn rereads everything before it." className="rise sv-split" style={{ '--i': 5 } as CSSProperties}>
            <Table head={['Room', 'Never sent', 'From cache', 'Savings rate', 'Lunchbox', 'Caching']}>
              {top.map(({ room, id, u }) => (
                <button className="sv-row sv-link" key={id} onClick={() => go({ name: 'room', id })}>
                  <span className="sv-who">{room!.name}</span>
                  <span className="sv-num">{tokens(unsent(u))}</span>
                  <span className="sv-num sv-dim">{tokens(u.cached)}</span>
                  <span className="sv-ratio"><i style={{ '--w': ratio(u) } as CSSProperties} /><b>{pct(ratio(u))}</b></span>
                  <span className="sv-num">{own(u) !== 0 ? cash(own(u)) : <em>{unsent(u) > 0 ? 'tokens only' : 'none yet'}</em>}</span>
                  <span className="sv-num">{gross(u) > 0 ? cash(gross(u)) : <em>{u.cached > 0 && !priced(u) ? 'tokens only' : 'none yet'}</em>}</span>
                </button>
              ))}
            </Table>
          </Card>
        )}

        <Card title="How this is counted" info="The rules behind every number on this page." className="rise sv-notes" style={{ '--i': 6 } as CSSProperties}>
          <dl>
            <dt>Lunchbox and caching</dt>
            <dd>Prompt caching is your agents' own saving, and they make it without Lunchbox. What Lunchbox adds is counted on its own and never inside the caching figure.</dd>
            <dt>Never sent</dt>
            <dd>Counted from the text itself, at about four characters a token, and priced as fresh input at list price. That is the least it would have cost: sent, it would also have been stored and read again on later steps.</dd>
            <dt>Shortened output</dt>
            <dd>Only for commands that log, such as tests, builds and installs, and only in Auto and Full access. Nothing is counted for output over 30,000 characters, which Claude Code moves to a file by itself.</dd>
            <dt>Cache lifetime</dt>
            <dd>A flow or a crewmate called for one job caches for five minutes, which costs 1.25 times the input price to store where an hour costs twice. The gap is counted only once Lunchbox has seen Claude Code ask for the hour by itself. A room read from a cache Lunchbox kept alive past its lifetime counts what it read beyond the part every session shares, at the gap between storing and reading. Every read that kept a room warm is a cost, and is taken off.</dd>
            <dt>Each turn once</dt>
            <dd>Claude Code and Codex report running totals when a session is resumed. Lunchbox takes away what was already counted, so a long room is never counted twice.</dd>
            <dt>Reads and writes</dt>
            <dd>A cached read is billed at a fraction of a fresh one. Storing the cache costs more than a fresh read: 1.25 times the input price for an entry kept five minutes, twice for one kept an hour.{gross(week) > 0 && ` This week cached reads saved ${cash(gross(week))}, storing cost ${cash(stored)}, and ${cash(Math.max(0, gross(week) - stored))} is left.`}</dd>
            <dt>Five minutes or an hour</dt>
            <dd>Each use starts the time again. A message sent while the cache is warm pays only for what is new; after it cools, the next one reads the whole room at full price. The room panel shows the time each agent reported.</dd>
            <dt>Claude</dt>
            <dd>Priced per model at Anthropic's list prices, from the reads and writes Claude Code reports for each turn.</dd>
            <dt>Codex</dt>
            <dd>Counted in Codex credits at $40 for 1,000: the gap between the input rate and the cached input rate. Codex has no charge for storing.</dd>
            <dt>Other agents</dt>
            <dd>Worked back from the cost the agent reports, with a cached read counted at a quarter of a fresh one, so the figure can only be low. Agents that report no cost show tokens only, and local models are free.</dd>
          </dl>
        </Card>
      </div>
    </div>
  )
}

// A tooltip near the top or side of the page turns to where there is room before it shows.
const fitTip = (e: { currentTarget: HTMLElement }) => {
  const tip = e.currentTarget.querySelector<HTMLElement>('.sv-tip')
  if (tip) place(tip, e.currentTarget, { centered: true })
}

function Info({ text }: { text: string }) {
  return <span className="sv-info" tabIndex={0} aria-label={text} onPointerEnter={fitTip} onFocus={fitTip}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 7.25v3.75" strokeLinecap="round" /><circle cx="8" cy="5.1" r=".2" strokeWidth="1.4" /></svg><span className="sv-tip" role="tooltip">{text}</span></span>
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

// Stacked bars on a light grid: what was never sent at the bottom, what caching saved above it,
// what was paid in full on top.
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
              <div className="sv-stack" tabIndex={0} onPointerEnter={fitTip} onFocus={fitTip}>
                <i className="sv-fresh" style={{ height: h(d.input) }} />
                <i className="sv-reuse" style={{ height: h(d.cached) }} />
                {unsent(d) > 0 && <i className="sv-lean" style={{ height: h(unsent(d)) }} />}
                <span className="sv-tip" role="tooltip">
                  <b>{label}</b>
                  <span><i className="sv-lean" />Never sent<em>{tokens(unsent(d))}</em></span>
                  <span><i className="sv-reuse" />Saved by caching<em>{tokens(d.cached)}</em></span>
                  <span><i className="sv-fresh" />Paid in full<em>{tokens(d.input)}</em></span>
                  {own(d) >= 0.01 && <span className="sv-saved">Lunchbox saved<em>{money(own(d))}</em></span>}
                  {(d.gross ?? d.saved) >= 0.01 && <span className={own(d) >= 0.01 ? undefined : 'sv-saved'}>Caching saved<em>{money(d.gross ?? d.saved)}</em></span>}
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
  useModal()
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
