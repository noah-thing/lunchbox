import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Act, AgentInfo, Event, Live, LiveRun, LiveTurn, RoomMeta, Verdict } from '../../shared/types'
import { plan } from '../../shared/plan'
import { Loader, Mark, Meter, Strip } from '../ui/bits'
import { Field, type Scene } from '../ui/Field'
import { Menu } from '../ui/Access'
import { Rich } from '../ui/Rich'
import { IconCopy, IconFolder, IconFork, IconMore, IconPanel, IconPin, IconSplit } from '../ui/icons'
import { agentOf, clock, desk, KIND_LABEL, money, short, tokens, unavailable, useApp, type Access } from '../lib/desk'
import { Composer } from './Composer'

type Data = { meta: RoomMeta; events: Event[]; live: Live }
type Say = Extract<Event, { kind: 'say' }>
type Actions = {
  decide(ref: string, i: number): void
  pick(arena: string, who: string): void
  answer(run: string, a: 'once' | 'always' | 'deny'): void
  kill(run: string): void
  pin(ev: string): void
  fork(ev: string): void
}

const remembered = (key: string, fallback: boolean) => {
  const v = localStorage.getItem('lb.' + key)
  return v === null ? fallback : v === 'true'
}

export function RoomView({ id, access, setAccess, open, focus, say }: {
  id: string; access: Access; setAccess: (a: Access) => void; open: (room: string) => void; focus?: string; say: (t: string) => void
}) {
  const [data, setData] = useState<Data | null>(null)
  const [panel, setPanel] = useState(() => remembered('panel', innerWidth >= 1280))
  const [replay, setReplay] = useState<number | null>(null)
  const [arena, setArena] = useState(false)
  const early = useRef<Event[]>([])
  const agents = useApp((s) => s.agents)

  useEffect(() => {
    let alive = true
    early.current = []
    setData(null)
    setReplay(null)
    desk.call('room', id).then((d: Data | null) => {
      if (!alive || !d?.meta) return
      const seen = new Set(d.events.map((e) => e.id))
      setData({ ...d, events: [...d.events, ...early.current.filter((e) => !seen.has(e.id))] })
    })
    const offs = [
      desk.on('room:event', ({ room, event }: { room: string; event: Event }) => {
        if (room !== id) return
        setData((d) => {
          if (!d) { early.current.push(event); return d }
          return d.events.some((e) => e.id === event.id) ? d : { ...d, events: [...d.events, event] }
        })
      }),
      desk.on('room:live', ({ room, live }: { room: string; live: Live }) => { if (room === id) setData((d) => d && { ...d, live }) }),
      desk.on('room:meta', (meta: RoomMeta) => { if (meta?.id === id) setData((d) => d && { ...d, meta }) }),
    ]
    return () => { alive = false; offs.forEach((f) => f()) }
  }, [id])

  useEffect(() => {
    if (!data || replay === null) return
    if (replay >= data.events.length) { const t = setTimeout(() => setReplay(null), 1200); return () => clearTimeout(t) }
    const gap = replay ? data.events[replay].at - data.events[replay - 1].at : 0
    const t = setTimeout(() => setReplay(replay + 1), Math.min(1400, Math.max(260, gap / 6)))
    return () => clearTimeout(t)
  }, [replay, data])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') { e.preventDefault(); togglePanel() }
      if (e.key === 'Escape' && data?.live.turns.length && (e.target as HTMLElement)?.tagName !== 'TEXTAREA') desk.call('room:stop', id)
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  })

  if (!data) return <div className="room loading"><Loader size={14} /></div>
  const { meta, events, live } = data
  const busy = live.turns.length > 0 || live.runs.length > 0

  const togglePanel = () => setPanel((p) => { localStorage.setItem('lb.panel', String(!p)); return !p })
  const actions: Actions = {
    decide: (ref, i) => desk.call('room:decide', id, ref, i, access),
    pick: (a, who) => desk.call('room:pick', id, a, who),
    answer: (run, a) => desk.call('run:answer', run, a),
    kill: (run) => desk.call('run:kill', run),
    pin: (ev) => { desk.call('room:pin', id, ev); say('Pinned to shared memory') },
    fork: async (ev) => { const copy = await desk.call('room:fork', id, ev); if (copy) open(copy.id) },
  }
  const send = (text: string) => desk.call('room:send', id, text, access, arena)
  const pick = async () => { const p = await desk.call('pick'); if (p) desk.call('room:workspace', id, p) }
  const shown = replay === null ? events : events.slice(0, replay)

  return (
    <div className={`room${panel ? ' withdetails' : ''}`}>
      <section className="convo">
        <header className="roomhead">
          <Title name={meta.name} rename={(n) => desk.call('room:rename', id, n)} />
          {meta.forkedFrom && <button className="tag" onClick={() => open(meta.forkedFrom!.room)}>fork</button>}
          <span className="spacer" />
          <button className="ghostbtn mono" onClick={pick} title={meta.workspace}><IconFolder />{short(meta.workspace)}</button>
          <RoomMenu id={id} meta={meta} canReplay={events.length > 1} replay={() => setReplay(0)} open={open} say={say} />
          <button className={`iconbtn${panel ? ' on' : ''}`} onClick={togglePanel} aria-label="Room panel" aria-pressed={panel} title="Room panel"><IconPanel /></button>
        </header>
        {replay !== null && (
          <div className="replaybar">
            <span className="dot" />Replaying<code>{Math.min(replay, events.length)} / {events.length}</code>
            <span className="spacer" />
            <button className="btn small quiet" onClick={() => setReplay(null)}>Stop</button>
          </div>
        )}
        <Transcript key={id} events={shown} live={replay === null ? live : null} agents={agents} actions={actions} focus={focus} empty={!events.length} />
        <div className="dock">
          <Composer
            crew={meta.crew} setCrew={(c) => desk.call('room:crew', id, c)} onSend={send} access={access} setAccess={setAccess}
            busy={busy} onStop={() => desk.call('room:stop', id)} arena={arena} setArena={setArena} pack={meta.pack}
            placeholder={meta.crew.length > 1 ? 'Message the room. @ to address one agent, ! to run a command.' : 'Message the room. Start with ! to run a command.'}
          />
        </div>
      </section>
      {panel && <Panel meta={meta} events={events} live={live} agents={agents} />}
    </div>
  )
}

function Title({ name, rename }: { name: string; rename: (n: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  useEffect(() => setValue(name), [name])
  if (!editing) return <h1 onDoubleClick={() => setEditing(true)} title="Double click to rename">{name}</h1>
  const done = (save: boolean) => { if (save && value.trim() && value !== name) rename(value.trim()); setEditing(false) }
  return (
    <input className="titleedit" autoFocus value={value} onChange={(e) => setValue(e.target.value)} onBlur={() => done(true)}
      onKeyDown={(e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') { setValue(name); done(false) } }} />
  )
}

function RoomMenu({ id, meta, canReplay, replay, open, say }: { id: string; meta: RoomMeta; canReplay: boolean; replay: () => void; open: (r: string) => void; say: (t: string) => void }) {
  const [sure, setSure] = useState(false)
  return (
    <Menu bare label="Room actions" button={<IconMore />} className="right">
      {(close) => (
        <>
          <button className="item" disabled={!canReplay} onClick={() => { replay(); close() }}>
            <span className="grow"><b>Replay</b><span>Watch the room happen again, faster</span></span>
          </button>
          <button className="item" onClick={async () => { close(); const s = await desk.call('room:skill', id); say(s ? `Saved “${s.name}” as a skill. Type / in any composer to use it.` : 'Nothing to learn from yet') }}>
            <span className="grow"><b>Save as skill</b><span>Keep the brief and the steps that worked</span></span>
          </button>
          <button className="item" onClick={async () => { close(); const c = await desk.call('room:fork', id, ''); if (c) open(c.id) }}>
            <span className="grow"><b>Fork room</b><span>Try another direction, keep this one as it is</span></span>
          </button>
          <button className="item" onClick={() => { desk.call('reveal', meta.workspace); close() }}>
            <span className="grow"><b>Open folder</b><span>{short(meta.workspace)}</span></span>
          </button>
          <div className="sep" />
          <button className={`item danger${sure ? ' sure' : ''}`} onClick={() => { if (!sure) return setSure(true); desk.call('room:remove', id); close() }} onMouseLeave={() => setSure(false)}>
            <span className="grow"><b>{sure ? 'Click again to delete' : 'Delete room'}</b><span>The folder and its files stay where they are</span></span>
          </button>
        </>
      )}
    </Menu>
  )
}

// The transcript is a timeline. Agent turns hang off a thin thread in the gutter so a chain of
// handoffs reads as one piece of work; your messages sit on the right and break the thread.
function Transcript({ events, live, agents, actions, focus, empty }: { events: Event[]; live: Live | null; agents: AgentInfo[]; actions: Actions; focus?: string; empty: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const size = events.length + (live ? live.turns.reduce((n, t) => n + t.text.length + t.acts.length, 0) + live.runs.reduce((n, r) => n + r.out.length + r.state.length, 0) : 0)
  useLayoutEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [size])
  useEffect(() => {
    if (!focus) return
    const el = box.current?.querySelector(`[data-id="${focus}"]`)
    if (!el) return
    stick.current = false
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.add('flash')
    setTimeout(() => el.classList.remove('flash'), 1600)
  }, [focus, events.length > 0])

  const chosen = useMemo(() => new Map(events.flatMap((e) => (e.kind === 'chose' ? [[e.ref, e.label] as const] : []))), [events])
  const picks = useMemo(() => new Map(events.flatMap((e) => (e.kind === 'pick' ? [[e.arena, e.who] as const] : []))), [events])
  const arenas = new Set<string>()
  const rows: ReactNode[] = []
  let last = ''
  for (const e of events) {
    if (e.kind === 'say' && e.arena) {
      if (arenas.has(e.arena)) continue
      arenas.add(e.arena)
      const done = events.filter((x): x is Say => x.kind === 'say' && x.arena === e.arena)
      const going = live?.turns.filter((t) => t.arena === e.arena) ?? []
      rows.push(<Arena key={e.id} id={e.arena} done={done} going={going} picked={picks.get(e.arena)} agents={agents} pick={actions.pick} />)
      last = ''
      continue
    }
    const speaker = e.kind === 'say' ? e.who : e.kind
    rows.push(<Row key={e.id} e={e} grouped={e.kind === 'say' && last === speaker} agents={agents} actions={actions} chosen={chosen} />)
    last = speaker
  }
  const landed = (t: LiveTurn) => events.some((e) => e.at >= t.started && (e.kind === 'say' ? e.who === t.who : e.kind === 'hands' && e.to === t.who))
  for (const t of live?.turns ?? []) {
    if (landed(t)) continue
    if (t.arena) {
      if (!arenas.has(t.arena)) { arenas.add(t.arena); rows.push(<Arena key={t.id} id={t.arena} done={[]} going={live!.turns.filter((x) => x.arena === t.arena)} agents={agents} pick={actions.pick} />) }
      continue
    }
    rows.push(<LiveRow key={t.id} t={t} agents={agents} doing={live!.active === t.who ? live!.doing : ''} grouped={t.kind === 'say' && last === t.who} />)
    last = t.who
  }
  for (const r of live?.runs ?? []) rows.push(<Ev key={r.id} mark={null} className="evrun"><RunBlock run={r} answer={actions.answer} kill={actions.kill} /></Ev>)

  return (
    <div className="transcript" ref={box} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
      <div className="column">
        {empty && !live?.turns.length && <div className="roomempty">Nothing here yet. Say what you need and the crew takes it from there.</div>}
        {rows}
        <div className="tail" />
      </div>
    </div>
  )
}

function Ev({ mark, grouped = false, className = '', id, children }: { mark: ReactNode; grouped?: boolean; className?: string; id?: string; children: ReactNode }) {
  return (
    <div className={`ev ${className}${grouped ? ' grouped' : ''}`} data-id={id}>
      <div className="gut">{!grouped && mark}</div>
      <div className="evbody">{children}</div>
    </div>
  )
}

function wallText(e: Extract<Event, { kind: 'wall' }>, agents: AgentInfo[]) {
  const from = agentOf(e.from, agents).short
  const why = /^(is |hit )/.test(e.reason) ? `${from} ${e.reason}` : `${from} could not start: ${e.reason}`
  const next = e.to ? `${agentOf(e.to, agents).short} took over with the same memory.` : 'Nobody else in the crew could take over.'
  return `${why}. ${next}${e.until && e.until > Date.now() ? ` Back at ${clock(e.until)}.` : ''}`
}

function Row({ e, grouped, agents, actions, chosen }: { e: Event; grouped: boolean; agents: AgentInfo[]; actions: Actions; chosen: Map<string, string> }) {
  switch (e.kind) {
    case 'you':
      return (
        <div className="mine" data-id={e.id}>
          {e.to && <span className="to">to {e.to.map((w) => agentOf(w, agents).short).join(', ')}</span>}
          {e.arena && <span className="to"><IconSplit />side by side</span>}
          <div className="bubble"><Rich text={e.text} /></div>
        </div>
      )
    case 'say': {
      const a = agentOf(e.who, agents)
      return (
        <Ev id={e.id} mark={<Mark seed={a.mark} size={16} />} grouped={grouped} className="turn">
          {!grouped && <div className="who"><b className="name">{a.short}</b><span className="when">{clock(e.at)}</span></div>}
          {e.text && <Rich text={e.text} />}
          {e.error && <div className={`err${e.error === 'Stopped' ? ' soft' : ''}`}>{e.error === 'Stopped' ? 'Stopped' : e.error}</div>}
          <Acts acts={e.acts} />
          {e.proof?.map((p) => (
            <div key={p.claim} className={`proof${p.ok ? '' : ' bad'}`}><i />{p.ok ? 'Proved' : 'Not proved'}: {p.claim}<span>{p.text.replace(/`/g, '')}</span></div>
          ))}
          <Tools e={e} actions={actions} />
        </Ev>
      )
    }
    case 'hands': {
      const from = agentOf(e.from, agents)
      const to = agentOf(e.to, agents)
      return (
        <Ev id={e.id} mark={<Mark seed={to.mark} size={16} />} className="hands">
          <div className="handhead"><b className="name">{to.short}</b><span>answered</span><Mark seed={from.mark} size={12} /><span>{from.short}</span><span className="when">{clock(e.at)}</span></div>
          <div className="exchange">
            <p className="asked">{e.ask}</p>
            <div className="got">{e.answer ? <Rich text={e.answer} /> : <span className="err">{e.error ?? 'No answer'}</span>}</div>
            <Acts acts={e.acts} />
          </div>
          <Tools e={e} actions={actions} />
        </Ev>
      )
    }
    case 'wall':
      return (
        <Ev id={e.id} mark={<span className="gutdot" />} className="note">
          <span className="switch"><Mark seed={agentOf(e.from, agents).mark} size={12} /><i className="wire" />{e.to && <Mark seed={agentOf(e.to, agents).mark} size={12} />}</span>
          <span>{wallText(e, agents)}</span>
        </Ev>
      )
    case 'decide': {
      const c = chosen.get(e.id)
      return (
        <Ev id={e.id} mark={<span className={`gutdot${c ? '' : ' warn'}`} />} className="decision">
          <div className={`decide${c ? ' settled' : ''}`}>
            <span className="needs">{c ? `You chose: ${c}` : 'Needs you'}</span>
            <p>{e.text}</p>
            {!c && <div className="row">{e.options.map((o, i) => (
              <button key={o.label} className={`btn small${i ? ' quiet' : ''}`} onClick={() => actions.decide(e.id, i)}>{o.label}</button>
            ))}</div>}
          </div>
        </Ev>
      )
    }
    case 'run':
      return (
        <Ev id={e.id} mark={null} className="evrun">
          <RunBlock run={{ ...e, state: e.code === null ? 'denied' : 'done' }} />
        </Ev>
      )
    case 'pick':
      return <Ev id={e.id} mark={<span className="gutdot" />} className="note"><span>You kept {agentOf(e.who, agents).short}’s answer. It is in the room’s memory as a decision.</span></Ev>
    case 'note':
      return <Ev id={e.id} mark={<span className={`gutdot${e.tone === 'bad' ? ' bad' : e.tone === 'warn' ? ' warn' : ''}`} />} className={`note${e.tone ? ' ' + e.tone : ''}`}><span><Rich text={e.text} /></span></Ev>
    case 'crew':
      return (
        <Ev id={e.id} mark={<span className="gutdot" />} className="note">
          <span className="stack">{e.crew.map((w) => <span key={w}><Mark seed={agentOf(w, agents).mark} size={12} /></span>)}</span>
          <span>Crew is now {e.crew.map((w) => agentOf(w, agents).short).join(', ')}</span>
        </Ev>
      )
    default:
      return null
  }
}

function LiveRow({ t, agents, doing, grouped }: { t: LiveTurn; agents: AgentInfo[]; doing: string; grouped: boolean }) {
  const a = agentOf(t.who, agents)
  const quiet = !t.text.trim()
  const working = <div className="busyline"><span className="shimmer">{doing || `${a.short} is thinking`}</span><Strip alphabet={a.alphabet} length={14} /></div>
  if (t.kind === 'hands') {
    const from = agentOf(t.from ?? '', agents)
    return (
      <Ev mark={<Mark seed={a.mark} size={16} active />} className="hands live">
        <div className="handhead"><Mark seed={from.mark} size={12} /><span>{from.short} asked</span><b className="name">{a.short}</b></div>
        <div className="exchange">
          <p className="asked">{t.ask}</p>
          {quiet ? working : <div className="got"><Rich text={t.text} caret /></div>}
          <Acts acts={t.acts} live />
        </div>
      </Ev>
    )
  }
  return (
    <Ev mark={<Mark seed={a.mark} size={16} active />} grouped={grouped} className="turn live">
      {!grouped && <div className="who"><b className="name">{a.short}</b></div>}
      {!quiet && <Rich text={t.text} caret />}
      <Acts acts={t.acts} live />
      {(quiet || doing.includes(':')) && working}
    </Ev>
  )
}

function actLabel(a: Act) {
  if (a.t === 'cmd') return { code: a.command, tail: a.exit === null ? 'stopped' : `exit ${a.exit}`, bad: a.exit !== 0 }
  if (a.t === 'edit') return { code: a.path, tail: a.change === 'add' || a.change === 'write' ? 'wrote' : a.change === 'delete' ? 'deleted' : 'edited', bad: false }
  return { code: `${a.name}${a.detail ? ' ' + a.detail : ''}`, tail: a.ok === false ? 'failed' : '', bad: a.ok === false }
}

// What an agent did while it worked: one quiet summary line, the full list a click away.
function Acts({ acts, live = false }: { acts: Act[]; live?: boolean }) {
  const [open, setOpen] = useState(false)
  if (!acts.length) return null
  const cmds = acts.filter((a) => a.t === 'cmd').length
  const files = new Set(acts.flatMap((a) => (a.t === 'edit' ? [a.path] : []))).size
  const other = acts.filter((a) => a.t === 'tool').length
  const failed = acts.filter((a) => actLabel(a).bad).length
  const parts = [cmds && `${cmds} command${cmds > 1 ? 's' : ''}`, files && `${files} file${files > 1 ? 's' : ''} changed`, other && `${other} tool call${other > 1 ? 's' : ''}`].filter(Boolean)
  const list = live && !open ? acts.slice(-4) : acts
  return (
    <div className={`acts${open || live ? ' open' : ''}`}>
      <button className="actsum" onClick={() => setOpen(!open)} aria-expanded={open}>
        <i className="tick" />{parts.join(' · ')}{failed > 0 && <span className="bad">{failed} failed</span>}
      </button>
      {(open || live) && (
        <div className="actlist">
          {list.map((a, i) => {
            const l = actLabel(a)
            return <div key={i} className={`act${l.bad ? ' bad' : ''}`}><code>{a.t === 'cmd' && <span>$</span>}{l.code}</code><small>{l.tail}</small></div>
          })}
        </div>
      )}
    </div>
  )
}

function Tools({ e, actions }: { e: Extract<Event, { kind: 'say' | 'hands' }>; actions: Actions }) {
  const text = e.kind === 'say' ? e.text : e.answer
  const u = e.usage
  return (
    <div className="tools">
      {e.ms ? <span>{(e.ms / 1000).toFixed(1)} s</span> : null}
      {u && u.input + u.output > 0 ? <span>{tokens(u.input + u.output + u.cached)} tokens{u.cached ? `, ${Math.round((u.cached / (u.input + u.cached)) * 100)}% cached` : ''}</span> : null}
      {u && u.cost > 0 ? <span>{money(u.cost)}</span> : null}
      <span className="spacer" />
      {text && <button onClick={() => navigator.clipboard.writeText(text)} title="Copy"><IconCopy /></button>}
      {text && <button onClick={() => actions.pin(e.id)} title="Pin to shared memory"><IconPin /></button>}
      <button onClick={() => actions.fork(e.id)} title="Fork the room from here"><IconFork /></button>
    </div>
  )
}

function Arena({ id, done, going, picked, agents, pick }: { id: string; done: Say[]; going: LiveTurn[]; picked?: string; agents: AgentInfo[]; pick: Actions['pick'] }) {
  const cols = [
    ...done.map((e) => ({ who: e.who, text: e.text, acts: e.acts, live: false, error: e.error, ms: e.ms, usage: e.usage })),
    ...going.map((t) => ({ who: t.who, text: t.text, acts: t.acts, live: true, error: undefined, ms: undefined, usage: undefined })),
  ]
  const settled = !going.length
  return (
    <div className="arena">
      <div className="arenahead">
        <IconSplit /><b>Side by side</b>
        <span>{picked ? `You kept ${agentOf(picked, agents).short}` : settled ? 'Keep the answer you like best' : `${going.length} still working`}</span>
      </div>
      <div className="arenacols" style={{ '--n': Math.min(cols.length, 3) } as CSSProperties}>
        {cols.map((c) => {
          const a = agentOf(c.who, agents)
          return (
            <div key={c.who + id} className={`arenacol${picked === c.who ? ' picked' : picked ? ' dim' : ''}`}>
              <div className="who"><Mark seed={a.mark} size={14} active={c.live} /><b className="name">{a.short}</b><span className="when">{c.ms ? `${(c.ms / 1000).toFixed(1)} s` : ''}</span></div>
              {c.text ? <Rich text={c.text} caret={c.live} /> : c.error ? <div className="err">{c.error}</div> : <div className="busyline"><span className="shimmer">Thinking</span></div>}
              <Acts acts={c.acts} live={c.live} />
              {settled && !picked && !c.error && <button className="btn small quiet keep" onClick={() => pick(id, c.who)}>Keep this one</button>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

type RunView = { id?: string; command: string; cwd: string; state: LiveRun['state'] | 'done' | 'denied'; verdict?: Verdict; out: string; code?: number | null; ms?: number; how?: string }

// A command in the room: what it is, what the mode made of it, and its output.
function RunBlock({ run, answer, kill }: { run: RunView; answer?: Actions['answer']; kill?: Actions['kill'] }) {
  const asking = run.state === 'asking'
  useEffect(() => {
    if (!asking || !answer || !run.id) return
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'TEXTAREA') return
      if (e.key === 'Enter') answer(run.id!, 'once')
      if (e.key === 'Escape') answer(run.id!, 'deny')
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [asking, run.id, answer])
  const failed = run.state === 'done' && run.code !== 0
  const v = run.verdict
  const status =
    run.state === 'checking' ? 'checking' :
    run.state === 'asking' ? 'waiting for you' :
    run.state === 'running' ? 'running' :
    run.state === 'denied' ? run.how ?? 'not run' :
    `exit ${run.code ?? '?'} · ${((run.ms ?? 0) / 1000).toFixed(1)} s`
  return (
    <div className={`term ${run.state}${failed ? ' failed' : ''}`}>
      <div className="termhead">
        <code className="cmd"><span>$</span>{run.command}</code>
        <span className="spacer" />
        <span className={`status${failed || run.state === 'denied' ? ' bad' : ''}`}>
          {v && v.kind !== 'blocked' && run.state !== 'checking' && <span className="kind">{KIND_LABEL[v.kind]} ·</span>}
          {(run.state === 'running' || run.state === 'checking') && <Loader size={9} />}{status}
        </span>
        {run.state === 'running' && kill && run.id && <button className="btn small quiet" onClick={() => kill(run.id!)}>Stop</button>}
      </div>
      {asking && answer && run.id && (
        <div className="ask">
          <span>This {v?.reason}. Run it in <code>{short(run.cwd)}</code>?</span>
          <div className="row">
            <button className="btn small" onClick={() => answer(run.id!, 'once')}>Run <kbd>↵</kbd></button>
            {v?.kind !== 'danger' && <button className="btn small quiet" onClick={() => answer(run.id!, 'always')}>Always in this folder</button>}
            <button className="btn small quiet" onClick={() => answer(run.id!, 'deny')}>Don’t run</button>
          </div>
        </div>
      )}
      {run.state === 'denied' && v && <div className="ask note">This {v.reason}.</div>}
      {(run.out || run.state === 'running') && <pre className="out">{run.out}{run.state === 'running' && <span className="caret" />}</pre>}
    </div>
  )
}

// The room at a glance. The field is the room itself: each agent is a region of its own alphabet,
// the one working glows, a handoff draws a cable, an agent that is out fades, and the whole field
// nearly stops while it waits for you.
function Panel({ meta, events, live, agents }: { meta: RoomMeta; events: Event[]; live: Live; agents: AgentInfo[] }) {
  const ledger = useApp((s) => s.ledger)
  const budgets = useApp((s) => s.settings.budgets)
  const crew = meta.crew.map((id) => agentOf(id, agents))
  const scene = useRef<Scene>({ sources: [], active: -1, cables: [] })
  const cables = useRef<{ from: string; to: string; at: number }[]>([])
  const lastCable = useRef(0)
  if (live.cable && live.cable.at !== lastCable.current) {
    lastCable.current = live.cable.at
    cables.current = [...cables.current.slice(-4), { from: live.cable.from, to: live.cable.to, at: performance.now() / 1000 }]
  }
  const out = (a: AgentInfo) => !!unavailable(a)
  scene.current.sources = crew.map((a, i) => ({ alphabet: a.alphabet, x: (i + 0.5) / crew.length, y: i % 2 ? 0.66 : 0.34, energy: out(a) ? -0.3 : 0.22 }))
  scene.current.active = live.active ? meta.crew.indexOf(live.active) : -1
  scene.current.hold = live.waiting
  scene.current.cables = cables.current.filter((c) => meta.crew.includes(c.from) && meta.crew.includes(c.to)).map((c) => ({ from: meta.crew.indexOf(c.from), to: meta.crew.indexOf(c.to), at: c.at }))
  const prev = useRef(events.length)
  if (prev.current !== events.length) { prev.current = events.length; scene.current.bump = (scene.current.bump ?? 0) + 1 }

  const state = live.waiting ? 'waiting' : live.active ? 'working' : 'idle'
  const caption = live.waiting ? 'Waiting for you' : live.doing || (events.length ? 'Quiet' : 'Ready when you are')
  const steps = useMemo(() => plan(events), [events])
  const done = steps.filter((s) => s.done).length

  return (
    <aside className="panel">
      <div className={`panelhead ${state}`}><i /><span>{caption}</span></div>
      <div className="now"><Field scene={scene} height={132} quiet={0.3} className="nowfield" /></div>

      <section>
        <h2>Crew<small>{crew.length}</small></h2>
        {crew.map((a) => {
          const why = unavailable(a)
          const today = ledger?.today[a.id]
          const budget = budgets[a.id]
          const status = live.active === a.id ? (live.waiting ? 'Waiting for your OK' : 'Working') : why ?? (today ? `${tokens(today.input + today.output + today.cached)} tokens today${today.cost ? `, ${money(today.cost)}` : ''}` : 'Ready')
          return (
            <div key={a.id} className={`crew${live.active === a.id ? ' on' : ''}${why ? ' spent' : ''}`} title={a.name}>
              <Mark seed={a.mark} size={16} active={live.active === a.id && !live.waiting} />
              <span className="grow">{a.short}<small>{status}</small></span>
              {budget > 0 && <Meter value={Math.max(0, 1 - (today?.cost ?? 0) / budget)} cells={10} tone={(today?.cost ?? 0) > budget * 0.75 ? 'warn' : undefined} />}
            </div>
          )
        })}
      </section>

      {steps.length > 0 && (
        <section>
          <h2>Progress<small>{done} of {steps.length}</small></h2>
          <div className="steps">{steps.map((s, i) => <i key={i} className={s.done ? 'done' : ''} />)}</div>
          {steps.map((s, i) => (
            <div key={i} className={`task${s.done ? ' done' : ''}`}><i /><span className="grow">{s.text}</span><small>{agentOf(s.who, agents).short}</small></div>
          ))}
        </section>
      )}

      <Memory meta={meta} crew={crew} />
    </aside>
  )
}

const ORDER = (id: string) => (id === 'brief' ? 0 : id === 'decisions' ? 1 : id === 'files' ? 2 : 3)

// What the room knows, and whether each agent has the latest of it. An agent that is behind only
// gets the changes on its next turn, never the whole thing again.
function Memory({ meta, crew }: { meta: RoomMeta; crew: AgentInfo[] }) {
  const [open, setOpen] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const blocks = [...meta.blocks].sort((a, b) => ORDER(a.id) - ORDER(b.id) || b.at - a.at)
  const total = blocks.reduce((n, b) => n + b.text.length / 4, 0)
  const behindOf = (id: string, v: number) => crew.filter((a) => (meta.seen[a.id]?.[id] ?? 0) < v)
  const behind = new Set(blocks.flatMap((b) => behindOf(b.id, b.v).map((a) => a.id))).size
  return (
    <section>
      <h2>Shared memory<small>{blocks.length ? `${tokens(total)} tokens` : ''}</small></h2>
      {!blocks.length && <p className="hint">The brief, answers between agents, changed files and your decisions collect here. Pin any message to add it.</p>}
      {blocks.map((b) => {
        const late = behindOf(b.id, b.v)
        const isOpen = open === b.id
        return (
          <div key={b.id} className={`memrow${isOpen ? ' open' : ''}`}>
            <button className="mem" onClick={() => { setOpen(isOpen ? null : b.id); setDraft(null) }}>
              <span className="grow" title={b.title}><b>{b.title}</b><small>{tokens(b.text.length / 4)}</small></span>
              {late.length
                ? <span className="late">{late.map((a) => <Mark key={a.id} seed={a.mark} size={12} />)}behind</span>
                : <span className="fresh">current</span>}
            </button>
            {isOpen && (
              <div className="memtext">
                {draft === null ? <pre>{b.text}</pre> : <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} rows={6} />}
                <div className="row">
                  {draft === null ? (
                    <>
                      {b.id !== 'files' && <button className="btn small quiet" onClick={() => setDraft(b.text)}>Edit</button>}
                      {b.id !== 'brief' && <button className="btn small quiet" onClick={() => { desk.call('room:block', meta.id, b.id, null); setOpen(null) }}>Remove</button>}
                    </>
                  ) : (
                    <>
                      <button className="btn small" onClick={() => { desk.call('room:block', meta.id, b.id, draft); setDraft(null) }}>Save</button>
                      <button className="btn small quiet" onClick={() => setDraft(null)}>Cancel</button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })}
      {blocks.length > 0 && (
        <div className="memfoot">
          {behind > 0 ? `${behind === 1 ? 'One agent is' : `${behind} agents are`} behind. They get only the changes on their next turn.` : 'Everyone has the latest.'}
          {meta.saved.full > meta.saved.sent && ` So far ${tokens(meta.saved.sent / 4)} memory tokens sent instead of ${tokens(meta.saved.full / 4)}.`}
        </div>
      )}
    </section>
  )
}
