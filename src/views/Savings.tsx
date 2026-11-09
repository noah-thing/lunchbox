import type { CSSProperties } from 'react'
import type { AgentInfo, Day, Usage } from '../../shared/types'
import { Mark, Meter } from '../ui/bits'
import { money, tokens, useApp } from '../lib/desk'
import type { View } from '../App'

const zero = (): Usage => ({ input: 0, output: 0, cached: 0, cost: 0, saved: 0, kept: 0 })
const add = (a: Usage, u: Usage): Usage => ({
  input: a.input + u.input, output: a.output + u.output, cached: a.cached + u.cached, cost: a.cost + u.cost,
  saved: (a.saved ?? 0) + (u.saved ?? 0), kept: (a.kept ?? 0) + (u.kept ?? 0),
})
const total = (r: Record<string, Usage> | undefined) => Object.values(r ?? {}).reduce(add, zero())
const share = (u: Usage) => (u.input + u.cached > 0 ? u.cached / (u.input + u.cached) : 0)
const reused = (u: Usage) => u.cached + (u.kept ?? 0)
const pct = (n: number) => `${Math.round(n * 100)}%`
const rank = (x: { u: Usage }, y: { u: Usage }) => (y.u.saved ?? 0) - (x.u.saved ?? 0) || reused(y.u) - reused(x.u)

export function Savings({ go }: { go: (v: View) => void }) {
  const ledger = useApp((s) => s.ledger)
  const agents = useApp((s) => s.agents)
  const rooms = useApp((s) => s.rooms)
  const week = total(ledger?.week)
  const days = ledger?.days ?? []
  const today = days[days.length - 1]
  const saved = week.saved ?? 0
  const empty = week.input + reused(week) === 0

  const crew = Object.entries(ledger?.week ?? {})
    .map(([id, u]) => ({ a: agents.find((x) => x.id === id), id, u }))
    .filter((x) => x.u.input + reused(x.u) > 0)
    .sort(rank)
  const top = Object.entries(ledger?.rooms ?? {})
    .map(([id, u]) => ({ room: rooms.find((r) => r.id === id), id, u }))
    .filter((x) => x.room && reused(x.u) > 0)
    .sort(rank)
    .slice(0, 5)

  return (
    <div className="page">
      <div className="pagebody wide">
        <header className="pagehead rise">
          <h1>Savings</h1>
          <p>Each room sends the parts that stay the same first, so providers reuse them instead of billing you for them again. Agents still read the whole room.</p>
        </header>

        <div className="stats rise" style={{ '--i': 1 } as CSSProperties}>
          <Stat label="Saved, last 7 days" value={money(saved)} line={saved > 0 ? `of ${money(week.cost + saved)} it would have cost` : 'priced on Claude keys'} />
          <Stat label="Read from cache" value={pct(share(week))} line={`${tokens(week.cached)} input tokens`} />
          <Stat label="Never resent" value={tokens(week.kept ?? 0)} line="tokens of memory agents already had" />
          <Stat label="Today" value={money(today?.saved ?? 0)} line={today?.cached ? `${tokens(today.cached)} from cache` : 'nothing yet'} />
        </div>

        {empty ? (
          <section className="group rise" style={{ '--i': 2 } as CSSProperties}>
            <div className="saveempty">
              <pre aria-hidden="true">{EMPTY}</pre>
              <p>Nothing measured yet. Every turn in a room lands here: what the provider read from cache, what Lunchbox never had to send, and what that saved you.</p>
              <button className="btn small" onClick={() => go({ name: 'new' })}>Start a room</button>
            </div>
          </section>
        ) : (
          <>
            <section className="group rise" style={{ '--i': 2 } as CSSProperties}>
              <h2>Two weeks<span className="quiet">input tokens per day</span></h2>
              <Chart days={days} />
            </section>

            <section className="group rise" style={{ '--i': 3 } as CSSProperties}>
              <h2>By agent<span className="quiet">last 7 days</span></h2>
              <div className="settings">
                {crew.map(({ a, id, u }) => <AgentRow key={id} a={a} id={id} u={u} />)}
              </div>
            </section>

            {top.length > 0 && (
              <section className="group rise" style={{ '--i': 4 } as CSSProperties}>
                <h2>Rooms that reuse the most<span className="quiet">long rooms gain the most</span></h2>
                <div className="settings">
                  {top.map(({ room, id, u }) => (
                    <button key={id} className="setting saveroom" onClick={() => go({ name: 'room', id })}>
                      <span className="grow">{room!.name}</span>
                      <span className="mono quiet">{tokens(reused(u))} reused</span>
                      <span className="mono amount">{u.saved ? money(u.saved) : pct(share(u))}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        <section className="group rise" style={{ '--i': 5 } as CSSProperties}>
          <h2>How it works</h2>
          <div className="how">
            {HOW.map(([k, line], i) => <div key={k} style={{ '--i': i } as CSSProperties}><code>{k}</code><span>{line}</span></div>)}
          </div>
        </section>
      </div>
    </div>
  )
}

const EMPTY = `  .-------.-------.-------.
  | ##### | : : : |       |
  '-------'-------'-------'
    paid    cache    free`

const HOW: [string, string][] = [
  ['order', 'Instructions, then the conversation, then the new turn. The start of each request matches the last one, and a matching start is what providers cache.'],
  ['window', 'In long rooms the history window moves twelve messages at a time instead of one, so the cached start survives many turns in a row.'],
  ['claude', 'With an Anthropic key the conversation ends in a cache mark. Repeat reads bill at a tenth of the input price, less on the newest models.'],
  ['openai', 'OpenAI, Gemini, OpenRouter and DeepSeek cache matching starts on their side. Each room keeps its own cache key so rooms never push each other out.'],
  ['session', 'Agents that keep their own session, like the Claude and Codex apps, get only what changed since their last turn.'],
  ['local', 'Local models stay loaded for thirty minutes between turns, so the next turn starts warm.'],
  ['quality', 'Nothing is trimmed or summarised to save money. Each agent reads the same room it would read with caching off.'],
]

function Stat({ label, value, line }: { label: string; value: string; line: string }) {
  return (
    <div className="stat">
      <small>{label}</small>
      <b>{value}</b>
      <span>{line}</span>
    </div>
  )
}

// Drawn in text on purpose: one column per day, '#' for input paid at full price and ':' for input
// read from cache, stacked from the floor. Rows arrive bottom first.
const ROWS = 8
function Chart({ days }: { days: Day[] }) {
  const max = Math.max(...days.map((d) => d.input + d.cached), 1)
  const cols = days.map((d) => {
    const all = d.input + d.cached
    const h = all > 0 ? Math.max(1, Math.round((all / max) * ROWS)) : 0
    return { d, h, c: all > 0 ? Math.round((d.cached / all) * h) : 0 }
  })
  const label = (d: Day, i: number) => i === days.length - 1 ? 'now' : new Date(d.day + 'T12:00:00').toLocaleDateString('en', { weekday: 'short' }).slice(0, 2).toLowerCase()
  const axis = (level: number) => (level === ROWS ? tokens(max) : level === ROWS / 2 ? tokens(max / 2) : '').padStart(6)
  return (
    <div className="achart" style={{ '--days': days.length } as CSSProperties} role="img" aria-label={`Input tokens per day for two weeks, ${tokens(days.reduce((a, d) => a + d.cached, 0))} read from cache`}>
      {Array.from({ length: ROWS }, (_, k) => {
        const level = ROWS - k
        return (
          <div key={k} className="crow" style={{ '--i': ROWS - k } as CSSProperties}>
            <span className="axis">{axis(level)} |</span>
            {cols.map(({ d, h, c }) => <span key={d.day} className={level <= c ? 'hit' : level <= h ? 'paid' : ''}>{level <= c ? ':::' : level <= h ? '###' : '   '}</span>)}
          </div>
        )
      })}
      <div className="crow floor"><span className="axis">     0 +</span>{cols.map(({ d }) => <span key={d.day}>{'-'.repeat(16)}</span>)}</div>
      <div className="crow names">
        <span className="axis">        </span>
        {cols.map(({ d }, i) => <span key={d.day} className={i === days.length - 1 ? 'cnow' : ''} title={`${d.day}: ${tokens(d.input)} paid, ${tokens(d.cached)} from cache${d.saved ? `, ${money(d.saved)} saved` : ''}`}>{label(d, i)} </span>)}
      </div>
      <div className="alegend"><span><b className="paid">###</b> paid at full price</span><span><b className="hit">:::</b> read from cache</span></div>
    </div>
  )
}

function AgentRow({ a, id, u }: { a?: AgentInfo; id: string; u: Usage }) {
  const s = share(u)
  const note = u.saved ? money(u.saved) : a?.via === 'local' ? 'free' : a?.via === 'cli' ? 'plan' : pct(s)
  const why = u.saved ? 'Saved at list prices' : a?.via === 'cli' ? 'Runs on your plan: cache shows up as more room before the limit, not as money' : a?.via === 'local' ? 'Runs on this computer' : 'No list price known for this model, so only tokens are counted'
  return (
    <div className="setting allowance">
      {a ? <Mark seed={a.mark} size={20} /> : <span className="markgap" />}
      <div className="grow">
        <b>{a?.name ?? id}</b>
        <span>{`${tokens(u.cached)} from cache${u.kept ? ` · ${tokens(u.kept)} never resent` : ''} · ${tokens(u.input)} paid`}</span>
      </div>
      <span className="state">{pct(s)} cached</span>
      <Meter value={s} cells={16} />
      <span className="mono amount" title={why}>{note}</span>
    </div>
  )
}
