import type { CSSProperties } from 'react'
import type { AgentInfo, Day, Usage } from '../../shared/types'
import { Mark } from '../ui/bits'
import { money, tokens, useApp } from '../lib/desk'
import type { View } from '../App'

const zero = (): Usage => ({ input: 0, output: 0, cached: 0, cost: 0, saved: 0, kept: 0 })
const add = (a: Usage, u: Usage): Usage => ({
  input: a.input + u.input, output: a.output + u.output, cached: a.cached + u.cached, cost: a.cost + u.cost,
  saved: (a.saved ?? 0) + (u.saved ?? 0), kept: (a.kept ?? 0) + (u.kept ?? 0),
})
const total = (r: Record<string, Usage> | undefined) => Object.values(r ?? {}).reduce(add, zero())
// Everything an agent read in a turn: what it was billed for in full, what came from the
// provider's cache, and what it never had to be sent because it already had it.
const read = (u: Usage) => u.input + u.cached + (u.kept ?? 0)
const reused = (u: Usage) => u.cached + (u.kept ?? 0)
const pct = (n: number) => (n > 0 && n < 0.005 ? '<1%' : `${Math.round(n * 100)}%`)
const share = (u: Usage) => (read(u) ? reused(u) / read(u) : 0)

export function Savings({ go }: { go: (v: View) => void }) {
  const ledger = useApp((s) => s.ledger)
  const agents = useApp((s) => s.agents)
  const rooms = useApp((s) => s.rooms)
  const week = total(ledger?.week)
  const saved = week.saved ?? 0
  const empty = read(week) === 0

  const crew = Object.entries(ledger?.week ?? {})
    .map(([id, u]) => ({ a: agents.find((x) => x.id === id), id, u }))
    .filter((x) => read(x.u) > 0)
    .sort((x, y) => (y.u.saved ?? 0) - (x.u.saved ?? 0) || reused(y.u) - reused(x.u))
  const top = Object.entries(ledger?.rooms ?? {})
    .map(([id, u]) => ({ room: rooms.find((r) => r.id === id), id, u }))
    .filter((x) => x.room && reused(x.u) > 0)
    .sort((x, y) => (y.u.saved ?? 0) - (x.u.saved ?? 0) || reused(y.u) - reused(x.u))
    .slice(0, 5)

  return (
    <div className="page">
      <div className="pagebody wide savings">
        <header className="pagehead rise">
          <h1>Savings</h1>
          <p>Agents reread the whole room on every turn. Lunchbox arranges each request so that text they have already seen costs a fraction, or is not sent at all. They still read everything.</p>
        </header>

        {empty ? (
          <section className="savehero rise" style={{ '--i': 1 } as CSSProperties}>
            <small>Last 7 days</small>
            <b>Nothing to count yet</b>
            <p>Start a room and come back after a few turns. Longer rooms save the most, because every turn rereads everything before it.</p>
            <button className="btn small" onClick={() => go({ name: 'new' })}>Start a room</button>
          </section>
        ) : (
          <>
            <Hero week={week} saved={saved} />

            <section className="group rise" style={{ '--i': 2 } as CSSProperties}>
              <h2>What your agents read<span className="quiet">last 7 days, {tokens(read(week))} tokens</span></h2>
              <Split week={week} />
            </section>

            <section className="group rise" style={{ '--i': 3 } as CSSProperties}>
              <h2>Day by day<span className="quiet">bright is reused, dim is read at full price</span></h2>
              <Days days={ledger?.days ?? []} />
            </section>

            <section className="group rise" style={{ '--i': 4 } as CSSProperties}>
              <h2>By agent<span className="quiet">last 7 days</span></h2>
              <div className="settings">
                {crew.map(({ a, id, u }) => <AgentRow key={id} a={a} id={id} u={u} />)}
              </div>
            </section>

            {top.length > 0 && (
              <section className="group rise" style={{ '--i': 5 } as CSSProperties}>
                <h2>Rooms that saved the most</h2>
                <div className="settings">
                  {top.map(({ room, id, u }) => (
                    <button key={id} className="setting saveroom" onClick={() => go({ name: 'room', id })}>
                      <span className="grow">{room!.name}</span>
                      <span className="quiet">{pct(share(u))} reused</span>
                      <span className="amount">{u.saved ? `${money(u.saved)} saved` : `${tokens(reused(u))} tokens`}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        <section className="group rise" style={{ '--i': 6 } as CSSProperties}>
          <h2>How Lunchbox saves</h2>
          <div className="how">
            {HOW.map(([title, line], i) => (
              <div key={title} style={{ '--i': i } as CSSProperties}>
                <code>{String(i + 1).padStart(2, '0')}</code>
                <span><b>{title}</b>{line}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

const HOW: [string, string][] = [
  ['Same start every time', 'Each request begins with the parts that do not change: the instructions, then the conversation so far. Providers keep that start for a few minutes and charge about a tenth for it on the next turn.'],
  ['Only what is new', 'Agents that keep their own session, like the Claude and Codex apps, already remember the room. They get only the messages since their last turn.'],
  ['Each room its own cache', 'Rooms never push each other out of the provider’s cache, so switching between two rooms keeps both cheap.'],
  ['Nothing is cut', 'No summaries, no trimming. Every agent reads the same room it would read with all of this turned off.'],
]

function Hero({ week, saved }: { week: Usage; saved: number }) {
  const would = week.cost + saved
  return (
    <section className="savehero rise" style={{ '--i': 1 } as CSSProperties}>
      <small>Last 7 days</small>
      {saved > 0 ? (
        <>
          <b>{money(saved)} saved</b>
          <p>Without Lunchbox arranging the requests, these turns would have cost {money(would)}. You paid {money(week.cost)}.</p>
          <div className="costbar" aria-hidden="true">
            <i className="paid" style={{ flex: `${Math.max(2, (week.cost / would) * 100)} 1 0` }} />
            <i className="kept" style={{ flex: `${(saved / would) * 100} 1 0` }} />
          </div>
          <div className="costkey"><span><i className="paid" />You paid {money(week.cost)}</span><span><i className="kept" />Saved {money(saved)}</span></div>
        </>
      ) : (
        <>
          <b>{pct(share(week))} of what they read was reused</b>
          <p>{tokens(reused(week))} of {tokens(read(week))} tokens came from cache or never had to be sent. Your agents run on plans or local models, so this shows up as more room before a limit instead of money.</p>
        </>
      )}
    </section>
  )
}

// One bar for everything read, in three parts that say where each token came from.
function Split({ week }: { week: Usage }) {
  const r = read(week) || 1
  const parts = [
    { key: 'cached', n: week.cached, name: 'Reused from cache', line: 'The provider had seen it a moment ago and charged about a tenth.' },
    { key: 'kept', n: week.kept ?? 0, name: 'Not sent again', line: 'The agent already had it in its own session.' },
    { key: 'fresh', n: week.input, name: 'Read at full price', line: 'New messages, files and tool results.' },
  ].filter((p) => p.n > 0)
  return (
    <div className="split">
      <div className="splitbar" aria-hidden="true">{parts.map((p) => <i key={p.key} className={p.key} style={{ flex: `${Math.max(0.6, (p.n / r) * 100)} 1 0` }} />)}</div>
      <div className="splitkey">
        {parts.map((p) => (
          <div key={p.key}>
            <i className={p.key} />
            <span className="grow"><b>{p.name}</b><span>{p.line}</span></span>
            <span className="num">{tokens(p.n)}</span>
            <span className="pct">{pct(p.n / r)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const H = 10
function Days({ days }: { days: Day[] }) {
  const max = Math.max(...days.map((d) => d.input + d.cached + d.kept), 1)
  return (
    <div className="days savedays">
      {days.map((d, i) => {
        const all = d.input + d.cached + d.kept
        const lit = all ? Math.max(1, Math.round((all / max) * H)) : 0
        const bright = all ? Math.round(((d.cached + d.kept) / all) * lit) : 0
        const date = new Date(d.day + 'T12:00:00')
        const label = date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
        return (
          <div key={d.day} className="day" style={{ '--i': i } as CSSProperties} title={all ? `${label}: ${tokens(d.cached + d.kept)} reused, ${tokens(d.input)} at full price${d.saved ? `, ${money(d.saved)} saved` : ''}` : `${label}: no turns`}>
            <div className="cells">{Array.from({ length: H }, (_, k) => {
              const level = H - k
              return <i key={k} className={level <= bright ? 'on' : level <= lit ? 'dim' : ''} />
            })}</div>
            <small>{i === days.length - 1 ? 'today' : date.toLocaleDateString(undefined, { weekday: 'narrow' })}</small>
          </div>
        )
      })}
    </div>
  )
}

function AgentRow({ a, id, u }: { a?: AgentInfo; id: string; u: Usage }) {
  const s = share(u)
  const note = u.saved ? `${money(u.saved)} saved` : a?.via === 'local' ? 'free, runs here' : a?.via === 'cli' ? 'on your plan' : 'price unknown'
  return (
    <div className="setting saveagent">
      {a ? <Mark seed={a.mark} size={20} /> : <span className="markgap" />}
      <div className="grow">
        <b>{a?.name ?? id}</b>
        <span>{tokens(reused(u))} of {tokens(read(u))} tokens reused</span>
      </div>
      <div className="minibar" aria-hidden="true"><i style={{ width: pct(s) }} /></div>
      <span className="pctlabel">{pct(s)}</span>
      <span className="amount">{note}</span>
    </div>
  )
}
