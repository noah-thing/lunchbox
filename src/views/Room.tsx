import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Act, AgentInfo, Event, Live, LiveRun, LiveTurn, RoomMeta, Verdict } from '../../shared/types'
import { wallWhy } from '../../shared/wall'
import { plan, plansBefore, type Step } from '../../shared/plan'
import { searchOf, stepOf, type Search } from '../../shared/steps'
import { Loader, Mark, Meter, Sure, Thumb } from '../ui/bits'
import { Field, type Scene } from '../ui/Field'
import { Menu } from '../ui/Access'
import { Inline, Rich } from '../ui/Rich'
import { roomCard } from '../ui/roomcard'
import { openReport } from '../lib/report'
import { IconBranches, IconChevron, IconClock, IconCopy, IconDiff, IconFolder, IconFork, IconMore, IconPanel, IconPhone, IconPin, IconReview, IconRewind, IconSplit, IconGlobe, IconX } from '../ui/icons'
import { agentOf, clock, desk, KIND_LABEL, mod, money, reason, short, tokens, unavailable, useApp, type Access } from '../lib/desk'
import { Changes } from './Changes'
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
  checkpoint(ev: string): boolean
  changed(ev: string): Promise<string[]>
  rewind(target: { event?: string; ref?: string }): void
  review(ev: string): void
  ask(text: string): void
  takeBack(queued: string): void
}

const remembered = (key: string, fallback: boolean) => {
  const v = localStorage.getItem('lb.' + key)
  return v === null ? fallback : v === 'true'
}

export function RoomView({ id, access, setAccess, open, focus, say }: {
  id: string; access: Access; setAccess: (a: Access) => void; open: (room: string) => void; focus?: string; say: (t: string) => void
}) {
  // Shown as stopped the moment the button is pressed; the engine confirms a few ms later.
  const [stopping, setStopping] = useState(false)
  const [data, setData] = useState<Data | null>(null)
  const [failed, setFailed] = useState(false)
  const [panel, setPanel] = useState(() => remembered('panel', innerWidth >= 1280))
  const [replay, setReplay] = useState<number | null>(null)
  const [arena, setArena] = useState(false)
  const [review, setReview] = useState<string | null>(null)
  const early = useRef<Event[]>([])
  const agents = useApp((s) => s.agents)

  useEffect(() => {
    let alive = true
    early.current = []
    setData(null)
    setFailed(false)
    setReplay(null)
    desk.call('room', id).then((d: Data | null) => {
      if (!alive) return
      if (!d?.meta) return setFailed(true)
      const seen = new Set(d.events.map((e) => e.id))
      setData({ ...d, events: [...d.events, ...early.current.filter((e) => !seen.has(e.id))] })
    }, () => { if (alive) setFailed(true) })
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
      // j and k move between messages when nothing is being typed.
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '') || (e.target as HTMLElement)?.isContentEditable
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'j' || e.key === 'k')) {
        const list = [...document.querySelectorAll<HTMLElement>('.transcript .column > .ev, .transcript .column > .mine')]
        if (!list.length) return
        const box = document.querySelector('.transcript')!.getBoundingClientRect()
        const cur = list.findIndex((el) => el.classList.contains('kfocus'))
        const from = cur >= 0 ? cur : list.findIndex((el) => el.getBoundingClientRect().bottom > box.top + 40)
        const next = list[Math.max(0, Math.min(list.length - 1, from + (e.key === 'j' ? 1 : -1)))]
        list.forEach((el) => el.classList.remove('kfocus'))
        next.classList.add('kfocus')
        next.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
      // Esc refuses a pending command first; only with nothing waiting does it stop the turn. An Esc
      // that closed something, or was typed into a field, a menu or a dialog, is not meant for the turn.
      if (e.key === 'Escape' && !e.defaultPrevented && !typing && !(e.target as HTMLElement)?.closest?.('[role=dialog],[role=menu],[role=listbox]') && !document.querySelector('.scrim')
        && data?.live.turns.length && !data.live.runs.some((r) => r.state === 'asking')) stop()
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  })

  const turning = data?.live.turns.length ?? 0
  useEffect(() => { if (!turning) setStopping(false) }, [turning])
  function stop() {
    setStopping(true)
    desk.call('room:stop', id)
  }

  // Defined before the loading return: the shortcut can fire while the room is still loading.
  const togglePanel = () => setPanel((p) => { localStorage.setItem('lb.panel', String(!p)); return !p })
  // Queued text handed back to the message box, once per hand back rather than on every live update.
  const back = data?.live.back
  const returned = useMemo(() => back, [back?.n])
  if (!data) return failed
    ? (
      <div className="room loading">
        <div className="roomfail">
          <p>This room could not be opened. It may have been deleted, or its file could not be read.</p>
          <button className="btn small quiet" onClick={() => dispatchEvent(new CustomEvent('lb:go', { detail: { name: 'new' } }))}>Back to New room</button>
        </div>
      </div>
    )
    : <div className="room loading"><Loader size={14} /></div>
  const { meta, events, live } = data
  const busy = !stopping && (live.turns.length > 0 || live.runs.length > 0)
  const actions: Actions = {
    decide: (ref, i) => desk.call('room:decide', id, ref, i, access),
    pick: (a, who) => desk.call('room:pick', id, a, who),
    answer: (run, a) => desk.call('run:answer', run, a),
    kill: (run) => desk.call('run:kill', run),
    pin: (ev) => { desk.call('room:pin', id, ev); say('Pinned to shared memory') },
    ask: (text) => desk.call('room:send', id, text, access, false),
    fork: async (ev) => { const copy = await desk.call('room:fork', id, ev); if (copy) open(copy.id) },
    checkpoint: (ev) => !!meta.checkpoints?.some((c) => c.event === ev),
    changed: async (ev) => (await desk.call('room:changed', id, ev).catch(() => [])) ?? [],
    rewind: async (target) => {
      try {
        const r = await desk.call('room:rewind', id, target)
        say(target.ref ? 'Rewind undone' : `Folder rewound${r?.removed ? `, ${r.removed} new file${r.removed > 1 ? 's' : ''} removed` : ''}`)
      } catch (e) { say(reason(e)) }
    },
    review: (ev) => setReview(ev),
    takeBack: (queued) => desk.call('room:takeback', id, queued),
  }
  const reviewed = review ? events.find((e) => e.id === review) : undefined
  const send = (text: string, files?: string[]) => desk.call('room:send', id, text, access, arena, files)
  const pick = async () => { const p = await desk.call('pick'); if (p) desk.call('room:workspace', id, p) }
  const shown = replay === null ? events : events.slice(0, replay)

  return (
    <div className={`room${panel ? ' withdetails' : ''}${stopping ? ' stopping' : ''}`}>
      <section className="convo">
        <header className="roomhead">
          <Title name={meta.name} rename={(n) => desk.call('room:rename', id, n)} />
          {meta.forkedFrom && <button className="tag" onClick={() => open(meta.forkedFrom!.room)}>fork</button>}
          <span className="spacer" />
          <button className="ghostbtn mono" onClick={pick} title={meta.workspace}><IconFolder />{short(meta.workspace)}</button>
          <RoomMenu id={id} meta={meta} events={events} canReplay={events.length > 1} replay={() => setReplay(0)} open={open} say={say} />
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
            busy={busy} onStop={stop} arena={arena} setArena={setArena} studio={!!meta.studio} setStudio={(on) => desk.call('room:studio', id, on)} pack={meta.pack} folder={meta.workspace} draft={returned}
            placeholder={meta.crew.length > 1 ? 'Message the room. @ to address one agent, ! to run a command.' : 'Message the room. Start with ! to run a command.'}
          />
        </div>
      </section>
      {panel && <Panel meta={meta} events={events} live={live} agents={agents} />}
      {review && (
        <Changes room={id} event={review} title={reviewed?.kind === 'you' ? reviewed.text.split('\n')[0].slice(0, 80) : 'this message'}
          close={() => setReview(null)} rewind={() => actions.rewind({ event: review })} />
      )}
    </div>
  )
}

function Title({ name, rename }: { name: string; rename: (n: string) => void }) {
  const [editing, setEditing] = useState(false)
  // The room menu's Rename opens the same inline field as a double click.
  useEffect(() => { const on = () => setEditing(true); addEventListener('lb:rename', on); return () => removeEventListener('lb:rename', on) }, [])
  const [value, setValue] = useState(name)
  useEffect(() => setValue(name), [name])
  // Enter or Esc unmounts the field, and the blur that follows must not save a second time.
  const closed = useRef(false)
  useEffect(() => { if (editing) closed.current = false }, [editing])
  if (!editing) return <h1 onDoubleClick={() => setEditing(true)} title="Double click to rename">{name}</h1>
  const done = (save: boolean) => {
    if (closed.current) return
    closed.current = true
    if (save && value.trim() && value.trim() !== name) rename(value.trim())
    setValue(name)
    setEditing(false)
  }
  return (
    <input className="titleedit" autoFocus value={value} onChange={(e) => setValue(e.target.value)} onBlur={() => done(true)}
      onKeyDown={(e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') { e.preventDefault(); done(false) } }} />
  )
}

function RoomMenu({ id, meta, events, canReplay, replay, open, say }: { id: string; meta: RoomMeta; events: Event[]; canReplay: boolean; replay: () => void; open: (r: string) => void; say: (t: string) => void }) {
  const agents = useApp((s) => s.agents)
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
          <button className="item" onClick={() => { close(); dispatchEvent(new Event('lb:rename')) }}>
            <span className="grow"><b>Rename</b><span>{meta.name}</span></span>
          </button>
          <button className="item" onClick={() => { desk.call('room:mark', id, { pinned: !meta.pinned }); close(); say(meta.pinned ? 'Unpinned' : 'Pinned to the top of your rooms') }}>
            <span className="grow"><b>{meta.pinned ? 'Unpin' : 'Pin to top'}</b><span>Keep it above the rest of your rooms</span></span>
            {meta.pinned && <i className="check" />}
          </button>
          <button className="item" onClick={() => { desk.call('room:mark', id, { archived: !meta.archived }); close(); say(meta.archived ? 'Back in your rooms' : 'Archived. Find it under Archived in the sidebar.') }}>
            <span className="grow"><b>{meta.archived ? 'Unarchive' : 'Archive'}</b><span>{meta.archived ? 'Bring it back to your rooms' : 'Out of the list, nothing deleted'}</span></span>
          </button>
          <button className="item" onClick={() => { desk.call('reveal', meta.workspace); close() }}>
            <span className="grow"><b>Open folder</b><span>{short(meta.workspace)}</span></span>
          </button>
          <div className="sep" />
          <button className="item" onClick={async () => { close(); if (await desk.call('room:export', id, 'html')) say('Replay saved. Open it in any browser and press Play.') }}>
            <span className="grow"><b>Export replay</b><span>One HTML file that plays the room back</span></span>
          </button>
          <button className="item" onClick={() => { close(); roomCard(meta, events, agents, say) }}>
            <span className="grow"><b>Share as image</b><span>One card for X: the crew, the handoffs, what was proved</span></span>
          </button>
          <button className="item" onClick={async () => { close(); if (await desk.call('room:export', id, 'md')) say('Saved as Markdown') }}>
            <span className="grow"><b>Export as Markdown</b><span>The conversation as plain text</span></span>
          </button>
          <button className="item" onClick={async () => {
            close()
            try {
              const written: string[] = await desk.call('room:project', id, !meta.project)
              say(meta.project ? 'Stopped writing memory to the project' : `Room memory is now kept in ${written.join(', ')}`)
            } catch (e) { say(reason(e)) }
          }}>
            <span className="grow"><b>{meta.project ? 'Stop writing to AGENTS.md' : 'Keep memory in AGENTS.md'}</b><span>{meta.project ? 'Removes the section Lunchbox added' : 'So the same agents know it outside Lunchbox too'}</span></span>
            {meta.project && <i className="check" />}
          </button>
          <div className="sep" />
          <Sure className="item danger" act={() => { desk.call('room:remove', id); close() }}>
            {(sure) => <span className="grow"><b>{sure ? 'Click again to delete' : 'Delete room'}</b><span>The folder and its files stay where they are</span></span>}
          </Sure>
        </>
      )}
    </Menu>
  )
}

// The saved event a live row turns into when its turn ends.
const replaces = (e: Event, t: LiveTurn) => e.at >= t.started && (e.kind === 'say' ? e.who === t.who : e.kind === 'hands' ? e.to === t.who : e.kind === 'image' && !!t.image && e.by === t.who)

// The transcript is a timeline. Agent turns hang off a thin thread in the gutter so a chain of
// handoffs reads as one piece of work; your messages sit on the right and break the thread.
function Transcript({ events, live, agents, actions, focus, empty }: { events: Event[]; live: Live | null; agents: AgentInfo[]; actions: Actions; focus?: string; empty: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const size = events.length + (live ? live.turns.reduce((n, t) => n + t.text.length + t.acts.length, 0) + live.runs.reduce((n, r) => n + r.out.length + r.state.length, 0) : 0)
  // Opening a room lands at the bottom at once. After that the view eases after new content
  // instead of jumping to it, for as long as you stay at the bottom.
  const opened = useRef(false)
  // Where the follower last put the view, so its own scrolls are not read as the reader's.
  const ours = useRef(-1)
  const lastTop = useRef(0)
  useLayoutEffect(() => {
    const el = box.current
    if (!el || !stick.current) return
    if (!opened.current) { el.scrollTop = el.scrollHeight; ours.current = el.scrollTop; opened.current = events.length > 0; return }
  }, [size])
  const working = !!live?.turns.length || !!live?.runs.length
  useEffect(() => {
    let raf = 0
    const follow = () => {
      const el = box.current
      if (el && stick.current) {
        const gap = el.scrollHeight - el.clientHeight - el.scrollTop
        if (gap > 0.5) { el.scrollTop += Math.max(1, gap * 0.16); ours.current = el.scrollTop }
      }
      raf = requestAnimationFrame(follow)
    }
    raf = requestAnimationFrame(follow)
    const stop = setTimeout(() => cancelAnimationFrame(raf), working ? 1e9 : 1500)
    return () => { cancelAnimationFrame(raf); clearTimeout(stop) }
  }, [working, size])
  // A turn that finishes swaps its live row for the saved event. The swap must not play the
  // arrival again, so events that replace a live row are marked settled and never animate in.
  const settled = useRef(new Set<string>())
  // When a live row becomes its saved event the column can come out a few pixels shorter, which
  // would pull the view up. While a turn is live the column keeps the tallest height it has
  // reached, and holds it through the swap. It lets go when the next turn starts, when the width
  // changes and text reflows, and when a rewind or a fork removes events.
  const column = useRef<HTMLDivElement>(null)
  const tallest = useRef({ h: 0, n: 0, w: 0 })
  const holding = useRef(working)
  holding.current = working
  const release = () => { tallest.current.h = 0; if (column.current) column.current.style.minHeight = '' }
  useEffect(() => {
    const el = column.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth !== tallest.current.w) { tallest.current.w = el.offsetWidth; release() }
      if (!holding.current) return
      const h = el.offsetHeight
      if (h > tallest.current.h) { tallest.current.h = h; el.style.minHeight = `${h}px` }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useLayoutEffect(() => { if (working) release() }, [working])
  useLayoutEffect(() => {
    if (events.length < tallest.current.n) release()
    tallest.current.n = events.length
  }, [events.length])
  const seen = useRef(new Map<string, LiveTurn>())
  for (const t of live?.turns ?? []) seen.current.set(t.id, t)
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
  const priors = useMemo(() => plansBefore(events), [events])
  const current = useMemo(() => plan(events), [events])
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
    if (!settled.current.has(e.id) && [...seen.current.values()].some((t) => replaces(e, t))) settled.current.add(e.id)
    rows.push(<Settled.Provider key={e.id} value={settled.current.has(e.id)}><Row e={e} grouped={e.kind === 'say' && last === speaker} agents={agents} actions={actions} chosen={chosen} prior={priors.get(e.id)} /></Settled.Provider>)
    last = speaker
  }
  const landed = (t: LiveTurn) => events.some((e) => replaces(e, t))
  for (const t of live?.turns ?? []) {
    if (landed(t)) continue
    if (t.arena) {
      if (!arenas.has(t.arena)) { arenas.add(t.arena); rows.push(<Arena key={t.id} id={t.arena} done={[]} going={live!.turns.filter((x) => x.arena === t.arena)} agents={agents} pick={actions.pick} />) }
      continue
    }
    const helper = live!.turns.find((x) => x.from === t.who && x.id !== t.id)
    rows.push(<LiveRow key={t.id} t={t} agents={agents} doing={live!.active === t.who ? live!.doing : ''} grouped={t.kind === 'say' && last === t.who} helper={helper && agentOf(helper.who, agents)} prior={current} />)
    last = t.who
  }
  // Only the first command waiting for an answer takes the keyboard, so one key never answers two.
  const first = live?.runs.find((r) => r.state === 'asking')?.id
  for (const r of live?.runs ?? []) rows.push(<Ev key={r.id} mark={null} className="evrun"><RunBlock run={r} answer={actions.answer} kill={actions.kill} keys={r.id === first} /></Ev>)
  // Sent while an agent was answering: they wait here, below the live turn, until their turn.
  for (const q of live?.queued ?? []) rows.push(
    <div key={q.id} className="mine queued">
      <span className="to"><IconClock />queued</span>
      <div className="bubble"><Rich text={q.text} /></div>
      <button type="button" className="qback" onClick={() => actions.takeBack(q.id)}>Edit</button>
    </div>,
  )

  return (
    <div className="transcript" ref={box}
      onScroll={(e) => {
        // Following stops on any move up the reader makes, by wheel, scrollbar, keys or j and k,
        // and starts again once they come back within reach of the bottom.
        const el = e.currentTarget
        const top = el.scrollTop
        const up = top < lastTop.current - 0.5
        lastTop.current = top
        if (Math.abs(top - ours.current) < 1) return
        const gap = el.scrollHeight - el.clientHeight - top
        stick.current = gap < 2 || (!up && gap < 80)
      }}>
      <div className="column" ref={column}>
        {empty && !live?.turns.length && <div className="roomempty">Nothing here yet. Say what you need and the crew takes it from there.</div>}
        {rows}
        <div className="tail" />
      </div>
    </div>
  )
}

const Settled = createContext(false)

function Ev({ mark, grouped = false, className = '', id, children }: { mark: ReactNode; grouped?: boolean; className?: string; id?: string; children: ReactNode }) {
  const settled = useContext(Settled)
  return (
    <div className={`ev ${className}${grouped ? ' grouped' : ''}${settled ? ' settled' : ''}`} data-id={id}>
      <div className="gut">{!grouped && mark}</div>
      <div className="evbody">{children}</div>
    </div>
  )
}

function wallText(e: Extract<Event, { kind: 'wall' }>, agents: AgentInfo[]) {
  const from = agentOf(e.from, agents).short
  const why = wallWhy(from, e.reason)
  const next = e.to ? `${agentOf(e.to, agents).short} took over with the same memory.` : e.arena ? 'The others answered without it.' : 'Nobody else in the crew could take over.'
  return `${why}. ${next}${e.until && e.until > Date.now() ? ` Back at ${clock(e.until)}.` : ''}`
}

function Row({ e, grouped, agents, actions, chosen, prior }: { e: Event; grouped: boolean; agents: AgentInfo[]; actions: Actions; chosen: Map<string, string>; prior?: Step[] }) {
  switch (e.kind) {
    case 'you':
      return (
        <div className="mine" data-id={e.id}>
          {e.from && <span className="to">{e.from === 'flow' ? <><IconClock />from a flow</> : <><IconPhone />from your phone</>}</span>}
          {e.to && <span className="to">to {e.to.map((w) => agentOf(w, agents).short).join(', ')}</span>}
          {e.arena && <span className="to"><IconSplit />side by side</span>}
          <div className="bubble">
            <Rich text={e.text} />
            {e.files && <div className="attached">{e.files.map((f) => <span key={f} className="file" title={f}><Thumb path={f} /><span>{f.split(/[\\/]/).pop()}</span></span>)}</div>}
          </div>
          {actions.checkpoint(e.id) && <Rewind id={e.id} actions={actions} />}
        </div>
      )
    case 'say': {
      const a = agentOf(e.who, agents)
      return (
        <Ev id={e.id} mark={<Mark seed={a.mark} size={16} />} grouped={grouped} className="turn">
          {!grouped && <div className="who"><b className="name">{a.short}</b><span className="when">{clock(e.at)}</span></div>}
          {e.text && <Rich text={e.text} prior={prior} />}
          {e.error && <div className={`err${e.error === 'Stopped' ? ' soft' : ''}`}>{e.error === 'Stopped' ? 'Stopped' : e.error}{e.error !== 'Stopped' && <button className="reportbtn" onClick={() => openReport({ context: `${a.short}: ${e.error}` })}>Report this</button>}</div>}
          <Acts acts={e.acts} />
          {e.proof?.map((p) => (
            <div key={p.claim} className={`proof${p.ok ? '' : ' bad'}`}><i />{p.ok ? 'Proved' : 'Not proved'}: {p.claim}<span>{p.text.replace(/`/g, '')}</span></div>
          ))}
          <Tools e={e} actions={actions} />
        </Ev>
      )
    }
    case 'image': {
      const by = agentOf(e.by, agents)
      return (
        <Ev id={e.id} mark={<Mark seed={by.mark} size={16} />} className="hands">
          <div className="handhead"><b className="name">{by.short}</b><span>made an image for</span><Mark seed={agentOf(e.for, agents).mark} size={12} /><span>{agentOf(e.for, agents).short}</span><span className="when">{clock(e.at)}</span></div>
          <Picture path={e.path} prompt={e.prompt} size={e.size} />
        </Ev>
      )
    }
    case 'hands': {
      const from = agentOf(e.from, agents)
      const to = agentOf(e.to, agents)
      return (
        <Ev id={e.id} mark={<Mark seed={to.mark} size={16} />} className="hands">
          <div className="handhead">
            <b className="name">{to.short}</b><span>{e.via === 'tool' ? 'lent a hand to' : 'answered'}</span><Mark seed={from.mark} size={12} /><span>{from.short}</span>
            {e.via === 'tool' && <span className="tag" title={`${from.short} called ${to.short} through the room's tools and kept working with the answer`}>mid-turn</span>}
            <span className="when">{clock(e.at)}</span>
          </div>
          <div className="exchange">
            <p className="asked">{e.ask}</p>
            <div className="got">{e.answer ? <Rich text={e.answer} prior={prior} /> : <span className="err">{e.error ?? 'No answer'}</span>}</div>
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
          {!/limit|turned off|budget/.test(e.reason) && <button className="reportbtn" onClick={() => openReport({ context: wallText(e, agents) })}>Report this</button>}
        </Ev>
      )
    case 'joined':
      return (
        <Ev id={e.id} mark={<span className="gutdot" />} className="note joinline">
          <span className="switch"><Mark seed={agentOf(e.by, agents).mark} size={12} /><i className="wire" /><Mark seed={agentOf(e.who, agents).mark} size={12} /></span>
          <span>{agentOf(e.by, agents).short} brought in {agentOf(e.who, agents).short}<span className="quiet">: {e.task}</span></span>
        </Ev>
      )
    case 'left':
      return (
        <Ev id={e.id} mark={<span className="gutdot" />} className="note joinline">
          <span className="switch"><Mark seed={agentOf(e.who, agents).mark} size={12} /></span>
          <span className="quiet">{agentOf(e.who, agents).short} stepped out</span>
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
      return (
        <Ev id={e.id} mark={<span className={`gutdot${e.tone === 'bad' ? ' bad' : e.tone === 'warn' ? ' warn' : ''}`} />} className={`note${e.tone ? ' ' + e.tone : ''}`}>
          <span><Rich text={e.text} /></span>
          {e.undo && <button className="btn small quiet" onClick={() => actions.rewind({ ref: e.undo })}>Undo</button>}
        </Ev>
      )
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

function LiveRow({ t, agents, doing, grouped, helper, prior }: { t: LiveTurn; agents: AgentInfo[]; doing: string; grouped: boolean; helper?: AgentInfo; prior?: Step[] }) {
  const a = agentOf(t.who, agents)
  // A line that hands work to a crewmate ("@grok: ...") becomes its own handoff block when the
  // turn ends, so it is never typed out here first.
  const said = t.kind === 'say' ? t.text.replace(/(^|\n)@[\w.-]+:[^\n]*(?=\n|$)/g, '').replace(/(^|\n)@[\w.-]*:?[^\n]*$/, '').trimEnd() : t.text
  const shown = useSmooth(said)
  const quiet = !said.trim()
  const working = <Working t={t} a={a} fallback={doing} waiting={helper} />
  if (t.image) {
    const from = agentOf(t.from ?? '', agents)
    return (
      <Ev mark={<Mark seed={a.mark} size={16} active />} className="hands live">
        <div className="handhead"><b className="name">{a.short}</b><span>is drawing an image for</span><Mark seed={from.mark} size={12} /><span>{from.short}</span></div>
        <Developing t={t} a={a} />
      </Ev>
    )
  }
  if (t.kind === 'hands') {
    const from = agentOf(t.from ?? '', agents)
    return (
      <Ev mark={<Mark seed={a.mark} size={16} active />} className="hands live">
        <div className="handhead"><b className="name">{from.short}</b><span>asked</span><Mark seed={a.mark} size={12} /><b className="name">{a.short}</b></div>
        <div className="exchange">
          <p className="asked">{t.ask}</p>
          {!quiet && <div className="got"><Rich text={shown} caret prior={prior} /></div>}
          <Acts acts={t.acts} live />
          {quiet && working}
        </div>
      </Ev>
    )
  }
  return (
    <Ev mark={<Mark seed={a.mark} size={16} active />} grouped={grouped} className="turn live">
      {!grouped && <div className="who"><b className="name">{a.short}</b></div>}
      {!quiet && <Rich text={shown} caret prior={prior} />}
      <Acts acts={t.acts} live />
      {(quiet || !!t.now) && working}
    </Ev>
  )
}

// Text as it streams in, let out at an even reading pace. Agents send words in bursts; shown
// as they come, the line stutters. This keeps a steady speed and only hurries when far behind,
// so it never trails the agent by more than a moment.
function useSmooth(text: string) {
  const target = useRef(text)
  target.current = text
  const [n, setN] = useState(0)
  useEffect(() => {
    let raf = 0
    let shown = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(50, now - last)
      last = now
      const left = target.current.length - shown
      if (left > 0) {
        shown = Math.min(target.current.length, shown + Math.max(70, left * 4.5) * dt / 1000)
        setN(Math.floor(shown))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return n >= text.length ? text : text.slice(0, n)
}

// Seconds since a live turn started, ticking while it runs.
function useElapsed(since: number) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [])
  const s = Math.max(0, Math.floor((now - since) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// What an agent is doing right now, in words: the verb, the command or tool, and how long it
// has taken so far.
function Working({ t, a, fallback, waiting }: { t: LiveTurn; a: AgentInfo; fallback: string; waiting?: AgentInfo }) {
  const elapsed = useElapsed(t.started)
  // Mid-turn help: the crewmate's own row below shows the work, this line says who has it.
  if (waiting) return <div className="workline"><Loader size={10} /><span className="shimmer">Waiting for {waiting.short}</span><time>{elapsed}</time></div>
  const search = t.now ? searchOf(t.now) : null
  if (search) return <SearchLive search={search} elapsed={elapsed} />
  const step = t.now ? stepOf(t.now) : null
  return (
    <div className="workline">
      <Loader size={10} />
      {step ? <><span className="shimmer">{step.verb}</span>{step.text && <code>{step.text}</code>}</> : <span className="shimmer">{fallback.startsWith(a.short + ' ') ? fallback : `${a.short} is thinking`}</span>}
      <time>{elapsed}</time>
    </div>
  )
}

// While the search runs: where it looks, for what, and a field of dots with light moving across
// it, the same field an image develops on.
function SearchLive({ search, elapsed }: { search: Search; elapsed: string }) {
  return (
    <div className="xsearch live">
      <header>
        <SourceIcon search={search} />
        <span className="shimmer">Searching {search.source}</span>{search.query && <><span>for</span><span className="query">“{search.query}”</span></>}
        <span className="meta">{[...search.filters, elapsed].join(' · ')}</span>
      </header>
      <div className="dotfield" aria-hidden><i className="dots" /><i className="dots lit" /></div>
    </div>
  )
}

const SourceIcon = ({ search }: { search: Search }) => <span className="src">{search.source === 'X' ? <IconX /> : <IconGlobe />}</span>

// What a search found, read from the command's own output: one line per post as
// "@handle · text · likes", with the total on the first line.
type Post = { handle: string; text: string; likes: string }
function postsOf(out = ''): { total?: string; posts: Post[] } {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  const posts = lines.map((l) => l.match(/^@(\S+)\s+·\s+(.+?)\s+·\s+([\d.,]+k?)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => ({ handle: m[1], text: m[2], likes: m[3] }))
  const total = lines.find((l) => /^\d[\d,]*\s+(posts|results)$/.test(l))
  return { total, posts }
}

// A face for a handle that has none here: a mirrored five by five pattern from the handle itself,
// so the same person always looks the same.
function Ident({ seed }: { seed: string }) {
  let h = 2166136261
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  const cells: ReactNode[] = []
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    if (!((h >>> (y * 3 + x)) & 1)) continue
    cells.push(<rect key={`${x}${y}`} x={x * 4 + 2} y={y * 4 + 2} width="3.4" height="3.4" rx=".6" />)
    if (x < 2) cells.push(<rect key={`m${x}${y}`} x={(4 - x) * 4 + 2} y={y * 4 + 2} width="3.4" height="3.4" rx=".6" />)
  }
  return <svg className="ident" viewBox="0 0 24 24" aria-hidden>{cells}</svg>
}

function Sources({ search, out }: { search: Search; out?: string }) {
  const { total, posts } = postsOf(out)
  const shown = posts.slice(0, 4)
  return (
    <div className="xsearch done">
      <header>
        <SourceIcon search={search} />
        <b>Searched {search.source}</b>{search.query && <><span>for</span><span className="query">“{search.query}”</span></>}
        {search.filters.length > 0 && <span className="meta">{search.filters.join(' · ')}</span>}
      </header>
      {shown.length > 0 && <div className="posts">
        {shown.map((p, i) => (
          <article key={p.handle + i} className="post" style={{ '--i': i } as CSSProperties}>
            <div className="by"><Ident seed={p.handle} /><b>@{p.handle}</b><small><IconHeart />{p.likes}</small></div>
            <p>{p.text}</p>
          </article>
        ))}
      </div>}
      {total && shown.length > 0 && <footer>Top {shown.length} of {total}</footer>}
    </div>
  )
}


const IconHeart = () => <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden><path fill="currentColor" d="M12 21s-7.5-4.6-9.6-9.3C.9 8.2 3 4.5 6.7 4.5c2.1 0 3.6 1.1 4.4 2.5h1.8c.8-1.4 2.3-2.5 4.4-2.5 3.7 0 5.8 3.7 4.3 7.2C19.5 16.4 12 21 12 21z" /></svg>

// An image on its way, at the size it will arrive. Light passes over a field of dots until the
// picture lands in the same place.
function Developing({ t, a }: { t: LiveTurn; a: AgentInfo }) {
  const elapsed = useElapsed(t.started)
  const [w, h] = (t.size?.match(/^(\d+)x(\d+)$/)?.slice(1).map(Number)) ?? [1024, 1024]
  return (
    <figure className="developing" style={{ '--ar': `${w} / ${h}` } as CSSProperties}>
      <div className="canvas" role="img" aria-label={`${a.short} is drawing an image`}>
        <i className="dots" /><i className="dots lit" />
      </div>
      <figcaption><span>{t.label}</span><small>{w} × {h} · {elapsed}</small></figcaption>
    </figure>
  )
}

function Picture({ path, prompt, size }: { path: string; prompt: string; size?: string }) {
  // Known size: the frame takes its final shape before the file has loaded, so nothing moves.
  const asked = size?.match(/^(\d+)x(\d+)$/)?.slice(1).join(' / ')
  // The file has the last word: a provider can return a slightly different shape than asked.
  const [real, setReal] = useState<string | null>(null)
  const ratio = real ?? asked
  const [src, setSrc] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let alive = true
    desk.call('file:image', path).then((url: string | null) => { if (!alive) return; if (url) setSrc(url); else setMissing(true) })
    return () => { alive = false }
  }, [path])
  return (
    <figure className="picture">
      <button className={`frame${src ? ' loaded' : ''}${ratio ? ' sized' : ''}`} style={ratio ? { aspectRatio: ratio } : undefined} onClick={() => desk.call('reveal', path)} title="Open">
        {src ? <img src={src} alt={prompt} onLoad={(e) => setReal(`${e.currentTarget.naturalWidth} / ${e.currentTarget.naturalHeight}`)} /> : missing ? <span className="err soft">The file is no longer there</span> : <Loader size={12} />}
      </button>
      <figcaption><span>{prompt}</span><code>{short(path)}</code></figcaption>
    </figure>
  )
}

const toolName = (name: string) => name.replace(/^mcp__lunchbox__|^lunchbox\./, '').replace(/_/g, ' ')

function actLabel(a: Act) {
  if (a.t === 'cmd') return { code: a.command, tail: a.exit === null ? 'stopped' : `exit ${a.exit}`, bad: a.exit !== 0 }
  if (a.t === 'edit') return { code: a.path, tail: a.change === 'add' || a.change === 'write' ? 'wrote' : a.change === 'delete' ? 'deleted' : 'edited', bad: false }
  if (a.t === 'agent') return { code: a.task, tail: a.state, bad: a.state === 'failed' }
  return { code: `${toolName(a.name)}${a.detail ? ' ' + a.detail : ''}`, tail: a.ok === false ? 'failed' : '', bad: a.ok === false }
}

// What an agent did while it worked: one quiet summary line, the full list a click away.
function Acts({ acts, live = false }: { acts: Act[]; live?: boolean }) {
  const [open, setOpen] = useState(false)
  if (!acts.length) return null
  // Searches show as their own card: commands with posts in their output, and the search tools
  // every CLI has, which report only what was searched.
  const searched = (a: Act) => (a.t === 'cmd' ? (postsOf(a.out).posts.length ? searchOf(a.command) : null) : a.t === 'tool' && /^(x|web)_search$/.test(a.name) ? searchOf(`${a.name} ${a.detail ?? ''}`) : null)
  const shown = (a: Act) => !!searched(a) || (a.t === 'tool' && /make_image$/.test(a.name))
  const found = acts.flatMap((a, i) => { const q = searched(a); return q ? [<Sources key={`s${i}`} search={q} out={a.t === 'cmd' ? a.out : undefined} />] : [] })
  const subs = acts.filter((a): a is Extract<Act, { t: 'agent' }> => a.t === 'agent')
  if (subs.length) found.unshift(<Subagents key="subs" list={subs} />)
  acts = acts.filter((a) => !shown(a) && a.t !== 'agent')
  if (!acts.length) return <>{found}</>
  const cmds = acts.filter((a) => a.t === 'cmd').length
  const files = new Set(acts.flatMap((a) => (a.t === 'edit' ? [a.path] : []))).size
  const other = acts.filter((a) => a.t === 'tool').length
  const failed = acts.filter((a) => actLabel(a).bad).length
  const parts = [cmds && `${cmds} command${cmds > 1 ? 's' : ''}`, files && `${files} file${files > 1 ? 's' : ''} changed`, other && `${other} tool call${other > 1 ? 's' : ''}`].filter(Boolean)
  return (
    <>
    {found}
    <div className={`acts${open ? ' open' : ''}`}>
      <button className="actsum" onClick={() => setOpen(!open)} aria-expanded={open}>
        {parts.join(', ')}{failed > 0 && <span className="bad">{failed} failed</span>}<IconChevron />
      </button>
      {open && (
        <div className="actlist">
          {acts.map((a, i) => {
            const l = actLabel(a)
            return <div key={i} className={`act${l.bad ? ' bad' : ''}`}><code>{live && !l.bad && <span className="ok">✓</span>}{a.t === 'cmd' && <span>$</span>}{l.code}</code><small>{l.tail}</small></div>
          })}
        </div>
      )}
    </div>
    </>
  )
}

// Subagents an agent started for parts of its work, one row each: what it was asked, which kind
// and model, what it is doing now, and how long it took. Rows keep their place as they finish.
type Sub = Extract<Act, { t: 'agent' }>
const took = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`)

function Subagents({ list }: { list: Sub[] }) {
  const running = list.filter((s) => s.state === 'running').length
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])
  const failed = list.filter((s) => s.state === 'failed').length
  const longest = Math.max(...list.map((s) => s.ms ?? now - s.started))
  return (
    <div className={`subs${running ? ' live' : ''}`}>
      <header>
        <IconBranches />
        {running ? <span className="shimmer">{running === list.length ? `Running ${list.length} subagent${list.length > 1 ? 's' : ''}` : `${running} of ${list.length} subagents running`}</span>
          : <span><b>{list.length} subagent{list.length > 1 ? 's' : ''}</b> finished</span>}
        <span className="meta">{failed > 0 && <span className="bad">{failed} failed · </span>}{took(longest)}</span>
      </header>
      {list.map((s) => (
        <div key={s.id} className={`subrow ${s.state}`}>
          <span className="subicon">{s.state === 'running' ? <Loader size={10} /> : s.state === 'failed' ? <IconX /> : <span className="subtick">✓</span>}</span>
          <div className="subwhat">
            <div className="subline"><span className="subtask">{s.task}</span>{(s.kind || s.model) && <small>{[s.kind, s.model].filter(Boolean).join(' · ')}</small>}</div>
            <div className="subdoing">
              {s.state === 'running' ? (s.last ? <code>{s.last}</code> : <span>Starting</span>) : s.note ? <span className="subnote">{s.note}</span> : null}
              <small>{s.tools ? `${s.tools} tool${s.tools > 1 ? 's' : ''} · ` : ''}{took(s.ms ?? now - s.started)}</small>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// Under your message: which files changed since it was sent, and a way back to before it.
function Rewind({ id, actions }: { id: string; actions: Actions }) {
  const [files, setFiles] = useState<string[] | null>(null)
  const [sure, setSure] = useState(false)
  const look = () => { if (files === null) actions.changed(id).then(setFiles) }
  return (
    <div className="rewind" onMouseEnter={look} onFocus={look} onMouseLeave={() => setSure(false)}>
      <button className={sure ? 'sure' : ''} onClick={() => { if (!sure) return setSure(true); setSure(false); setFiles(null); actions.rewind({ event: id }) }}
        title="Put the folder back the way it was before this message">
        <IconRewind />{sure ? `Rewind ${files?.length ? `${files.length} file${files.length > 1 ? 's' : ''}` : 'the folder'}?` : 'Rewind'}
      </button>
      {!sure && (
        <button onClick={() => actions.review(id)} title="Files changed in answer to this message, with diffs">
          <IconDiff />{files && files.length > 0 ? `${files.length} changed since` : 'Changes'}
        </button>
      )}
    </div>
  )
}

function Tools({ e, actions }: { e: Extract<Event, { kind: 'say' | 'hands' }>; actions: Actions }) {
  const text = e.kind === 'say' ? e.text : e.answer
  const u = e.usage
  return (
    <div className="msgtools">
      {e.ms ? <span>{(e.ms / 1000).toFixed(1)} s</span> : null}
      {u && u.input + u.output > 0 ? <span>{tokens(u.input + u.output + u.cached)} tokens{u.cached ? `, ${Math.round((u.cached / (u.input + u.cached)) * 100)}% cached` : ''}</span> : null}
      {u && u.cost > 0 ? <span>{money(u.cost)}</span> : null}
      <span className="spacer" />
      {text && <button onClick={() => navigator.clipboard.writeText(text)} title="Copy"><IconCopy /></button>}
      {text && <button onClick={() => actions.pin(e.id)} title="Pin to shared memory"><IconPin /></button>}
      {text && <Review e={e} actions={actions} />}
      <button onClick={() => actions.fork(e.id)} title="Fork the room from here"><IconFork /></button>
    </div>
  )
}

// A second opinion on one answer: another agent checks it before you build on it.
function Review({ e, actions }: { e: Extract<Event, { kind: 'say' | 'hands' }>; actions: Actions }) {
  const agents = useApp((s) => s.agents)
  const author = e.kind === 'say' ? e.who : e.to
  const others = agents.filter((a) => a.ready && a.id !== author)
  if (!others.length) return null
  const name = agentOf(author, agents).short
  return (
    <Menu bare label="Have another agent review this" button={<IconReview />} className="up">
      {(close) => (
        <>
          <div className="menuhead">Review {name}'s answer with</div>
          {others.map((a) => (
            <button key={a.id} className="item" onClick={() => {
              close()
              actions.ask(`@${a.id} Review ${name}'s answer above before I use it. Check the facts, the code and any claim that something works. List only real problems, most serious first, or say plainly that it holds up.`)
            }}>
              <Mark seed={a.mark} size={14} /><span className="grow"><b>{a.short}</b><span>{a.good}</span></span>
            </button>
          ))}
        </>
      )}
    </Menu>
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
function RunBlock({ run, answer, kill, keys = true }: { run: RunView; answer?: Actions['answer']; kill?: Actions['kill']; keys?: boolean }) {
  const asking = run.state === 'asking'
  useEffect(() => {
    if (!asking || !answer || !run.id || !keys) return
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'TEXTAREA') return
      // ⌘Enter runs it, so pressing Enter on some other button never approves a command.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); answer(run.id!, 'once') }
      if (e.key === 'Escape') { e.preventDefault(); answer(run.id!, 'deny') }
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [asking, run.id, answer, keys])
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
            <button className="btn small" onClick={() => answer(run.id!, 'once')}>Run <kbd>{mod}↵</kbd></button>
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
  const steps = useMemo(() => plan(events, crew), [events, meta.crew.join(), agents])
  const done = steps.filter((s) => s.done).length

  return (
    <aside className="panel">
      <div className={`panelhead ${state}`}><i /><span>{caption}</span></div>
      <div className="now"><Field scene={scene} height={132} quiet={0.3} className="nowfield" /></div>

      <section>
        <h2>Crew<small>{crew.length}</small></h2>
        {crew.map((a, i) => {
          const why = unavailable(a)
          const today = ledger?.today[a.id]
          const budget = budgets[a.id]
          // The main agent follows the room; everyone else is on call until brought in.
          const working = live.turns.some((t) => t.who === a.id)
          const used = today ? `${tokens(today.input + today.output + today.cached)} tokens today${today.cost ? `, ${money(today.cost)}` : ''}` : ''
          const role = i === 0 ? 'Main' : 'On call'
          const status = working ? (live.waiting && live.active === a.id ? 'Waiting for your OK' : i === 0 ? 'Main, working' : 'Working') : why ?? [role, used].filter(Boolean).join(', ')
          return (
            <div key={a.id} className={`crew${working ? ' on' : ''}${why ? ' spent' : ''}`} title={a.name}>
              <Mark seed={a.mark} size={16} active={working && !live.waiting} />
              <span className="grow">{a.short}<small>{status}</small></span>
              {budget > 0 && <Meter value={Math.max(0, 1 - (today?.cost ?? 0) / budget)} cells={10} tone={(today?.cost ?? 0) > budget * 0.75 ? 'warn' : undefined} />}
            </div>
          )
        })}
      </section>

      {steps.length > 0 && (
        <section>
          <h2>Progress<small>{done} of {steps.length}</small></h2>
          <div className="stepbar">{steps.map((s, i) => <i key={i} className={s.done ? 'done' : ''} />)}</div>
          {steps.map((s, i) => (
            <div key={i} className={`task${s.done ? ' done' : ''}`}><i /><span className="grow"><Inline text={s.text} /></span><small>{agentOf(s.who, agents).short}</small></div>
          ))}
        </section>
      )}

      <Memory meta={meta} crew={crew} />
      <Receipt meta={meta} events={events} agents={agents} />
    </aside>
  )
}

// What this room cost, who spent it, and what the shared memory saved.
// How long each agent's prompt cache stays warm. Providers keep a cached prompt for about five
// minutes after it was last used; a message after that pays for the whole room again.
const CACHE_MS = 5 * 60e3
function CacheClock({ events, agents }: { events: Event[]; agents: AgentInfo[] }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  const last = new Map<string, number>()
  for (const e of events) {
    if (e.kind !== 'say' && e.kind !== 'hands') continue
    const u = e.usage
    if (!u || !(u.cached > 0 || (u.written ?? 0) > 0)) continue
    last.set(e.kind === 'say' ? e.who : e.to, e.at)
  }
  const warm = [...last.entries()].map(([who, at]) => ({ who, left: at + CACHE_MS - now })).filter((x) => x.left > -60e3)
  if (!warm.length) return null
  const fmt = (ms: number) => `${Math.floor(ms / 60e3)}:${String(Math.floor((ms % 60e3) / 1000)).padStart(2, '0')}`
  return (
    <div className="cacheclock" title="A message while the cache is warm only pays for what is new. After it cools, the next message reads the whole room again.">
      {warm.map(({ who, left }) => {
        const a = agentOf(who, agents)
        return (
          <div key={who} className={`cclock${left <= 0 ? ' cold' : left < 60e3 ? ' soon' : ''}`}>
            <Mark seed={a.mark} size={12} />
            <span className="grow">{a.short} cache</span>
            <i style={{ '--k': Math.max(0, Math.min(1, left / CACHE_MS)) } as CSSProperties} />
            <span className="mono">{left > 0 ? `warm ${fmt(left)}` : 'cooled'}</span>
          </div>
        )
      })}
    </div>
  )
}

function Receipt({ meta, events, agents }: { meta: RoomMeta; events: Event[]; agents: AgentInfo[] }) {
  const rows = useMemo(() => {
    const by = new Map<string, { cost: number; tokens: number; turns: number; ms: number }>()
    for (const e of events) {
      if (e.kind !== 'say' && e.kind !== 'hands') continue
      const who = e.kind === 'say' ? e.who : e.to
      const r = by.get(who) ?? { cost: 0, tokens: 0, turns: 0, ms: 0 }
      r.cost += e.usage?.cost ?? 0
      r.tokens += (e.usage?.input ?? 0) + (e.usage?.output ?? 0) + (e.usage?.cached ?? 0)
      r.turns += 1
      r.ms += e.ms ?? 0
      by.set(who, r)
    }
    return [...by.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens)
  }, [events])
  if (!rows.length) return null
  const total = rows.reduce((n, [, r]) => n + r.cost, 0)
  const saved = Math.max(0, meta.saved.full - meta.saved.sent) / 4
  const checks = meta.checkpoints?.length ?? 0
  return (
    <section>
      <h2>Receipt<small>{money(total) || 'free'}</small></h2>
      {rows.map(([who, r]) => {
        const a = agentOf(who, agents)
        return (
          <div key={who} className="receipt">
            <Mark seed={a.mark} size={12} />
            <span className="grow">{a.short}<small>{r.turns} turn{r.turns > 1 ? 's' : ''} · {(r.ms / 1000).toFixed(0)} s</small></span>
            <span className="mono">{tokens(r.tokens)}</span>
            <span className="mono amount">{r.cost ? money(r.cost) : a.via === 'cli' ? 'plan' : 'free'}</span>
          </div>
        )
      })}
      <CacheClock events={events} agents={agents} />
      <div className="memfoot">
        {saved > 0 && `Shared memory kept ${tokens(saved)} tokens from being sent again. `}
        {checks > 0 ? `${checks} checkpoint${checks > 1 ? 's' : ''} of the folder; hover your message to rewind.` : ''}
      </div>
    </section>
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
