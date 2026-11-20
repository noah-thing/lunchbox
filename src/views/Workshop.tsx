import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { WorkshopState } from '../../shared/types'
import { Loader, Mark, Sure } from '../ui/bits'
import { Field, type Scene } from '../ui/Field'
import { IconFolder, IconPlay, IconShare } from '../ui/icons'
import { agentOf, ago, desk, isDesktop, mod, reason, unavailable, useApp } from '../lib/desk'
import { Menu } from '../ui/Access'
import { CrewMenu } from '../ui/ModelPicker'
import type { View } from '../App'

// A release reads as its version; anything else, such as a commit in tests, by its short id.
const label = (ref?: string) => (!ref ? '' : /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref.replace(/^v/, ''))

const IDEAS = [
  'A button that copies the whole room as Markdown',
  'A shortcut that opens the room\'s folder in my editor',
  'A page that lists my open GitHub pull requests',
  'A sound when an agent finishes',
]

// The crew the main process starts a Workshop room with: the default crew, or the first three ready.
function useBuilders() {
  const agents = useApp((s) => s.agents)
  const defaults = useApp((s) => s.settings.defaultCrew)
  const ready = agents.filter((a) => !unavailable(a)).map((a) => a.id)
  const preferred = defaults.filter((id) => ready.includes(id))
  return (preferred.length ? preferred : ready.slice(0, 3)).map((id) => agentOf(id, agents))
}

// The Workshop at a glance, drawn the way a room's panel draws its crew: each builder is a region
// of its own alphabet, the field quickens while a version is being built and nearly stops when one
// waits to be tried.
function Now({ state, busy, waiting }: { state: WorkshopState | null; busy: boolean; waiting: boolean }) {
  const crew = useBuilders()
  const scene = useRef<Scene>({ sources: [], active: -1, cables: [] })
  scene.current.sources = crew.map((a, i) => ({ alphabet: a.alphabet, x: (i + 0.5) / crew.length, y: i % 2 ? 0.66 : 0.34, energy: 0.1 }))
  scene.current.active = busy && crew.length ? 0 : -1
  scene.current.hold = waiting
  const phase = busy ? 'working' : waiting ? 'waiting' : 'idle'
  const seen = useRef(phase)
  if (seen.current !== phase) { seen.current = phase; scene.current.bump = (scene.current.bump ?? 0) + 1 }
  const caption = busy ? state!.busy!.step : state?.mine ? 'This is your Lunchbox' : waiting ? 'Ready to try' : crew.length ? 'Ready when you are' : 'No agent is ready yet'
  return (
    <div className="ws-now rise" aria-hidden="true">
      <Field scene={scene} height={98} quiet={0.3} fill={0.2} spread={0.21} className="nowfield" />
      <div className={`ws-nowline ${phase}`}><i /><span>{caption}</span>{state?.ready && <code>Lunchbox {label(state.base)}</code>}</div>
    </div>
  )
}

// The three steps, each drawn in box lines: the box you type in, the builders' alphabets running
// together into one part, and the two buttons at the end.
type Run = [string, string?]
// Symbols past ASCII can come from a fallback font of another width, so each sits in a cell of its own.
const cells = (text: string) => [...text].map((c, i) => (c.charCodeAt(0) > 127 ? <i key={i} className="cell">{c}</i> : c))
const line = (runs: Run[], key: number) => <div key={key}>{runs.map(([text, cls], j) => <span key={j} className={cls}>{cells(text)}</span>)}</div>
const repeat = (alphabet: string, n: number) => alphabet.repeat(Math.ceil(n / Math.max(1, alphabet.length))).slice(0, n)

function streams(alphabets: string[]): Run[][] {
  const list = (alphabets.length ? alphabets : ['.:-=+*#']).slice(0, 3)
  const n = list.length
  const join = n === 1 ? ['───▸ '] : n === 2 ? ['─╮   ', '─┴─▸ '] : ['─╮   ', '─┼─▸ ', '─╯   ']
  const at = n === 1 ? 0 : 1
  return list.map((a, i) => [[repeat(a, 9), 'bn-dim'], [' ' + join[i], 'bn-frame'], [i === at ? '▓▓▓▓▓▓' : '', 'bn-ink']])
}

const STEPS: { name: string; line: string; art: (alphabets: string[]) => Run[][] }[] = [
  { name: 'Say what you want', line: 'A button, a page, a provider, an integration. Anything Lunchbox could do.',
    art: () => [
      [['╭' + '─'.repeat(26) + '╮', 'bn-frame']],
      [['│ ', 'bn-frame'], ['a sound when an agent', 'bn-dim'], ['▍', 'bn-ink caretblink'], ['   │', 'bn-frame']],
      [['╰' + '─'.repeat(26) + '╯', 'bn-frame']],
    ] },
  { name: 'An agent builds it', line: 'In your own copy of Lunchbox, the way the rest of the app is made. The first time takes a minute to set up.',
    art: streams },
  { name: 'Try it, or send it', line: 'Open your Lunchbox with one click and switch back any time. Send it to us if everyone should have it.',
    art: () => [
      [['╭' + '─'.repeat(10) + '╮ ╭' + '─'.repeat(10) + '╮', 'bn-frame']],
      [['│ ', 'bn-frame'], ['▸ Try it', 'bn-ink'], [' │ │ ', 'bn-frame'], ['↑ Send  ', 'bn-dim'], [' │', 'bn-frame']],
      [['╰' + '─'.repeat(10) + '╯ ╰' + '─'.repeat(10) + '╯', 'bn-frame']],
    ] },
]

// Where the person asks for what Lunchbox is missing. An agent builds it into their own copy of
// the source, they open that version in place of the standard one, and they can send it to us.
export function Workshop({ go, say }: { go: (v: View) => void; say: (t: string) => void }) {
  const [state, setState] = useState<WorkshopState | null>(null)
  const [details, setDetails] = useState(false)
  const rooms = useApp((s) => s.rooms)
  const opened = useRef(Date.now())

  useEffect(() => {
    let on = true
    desk.call('workshop').then((s: WorkshopState) => on && setState(s), () => {})
    const off = desk.on('workshop', (s) => on && setState(s as WorkshopState))
    return () => { on = false; off() }
  }, [])
  // The first idea waits for the copy to be set up; its room opens as soon as it starts.
  useEffect(() => {
    if (state?.launched && state.launched.at > opened.current) go({ name: 'room', id: state.launched.room })
  }, [state?.launched?.at])

  // The job that ran last, so Try again repeats that one and not whatever the state suggests.
  const last = useRef<string | null>(null)
  const act = async (channel: string, done?: string) => {
    if (['workshop:setup', 'workshop:open', 'workshop:update', 'workshop:reset'].includes(channel)) last.current = channel
    try {
      const s = (await desk.call(channel)) as WorkshopState | undefined
      if (s && typeof s === 'object' && 'ready' in s) setState(s)
      if (done && !s?.busy?.error) say(done)
      return s
    } catch (e) {
      say(reason(e))
    }
  }

  const build = async (text: string, crew?: string[]) => {
    try {
      const r = await desk.call('workshop:idea', text, crew)
      if (r?.room) go({ name: 'room', id: r.room })
      else setState(await desk.call('workshop'))
    } catch (e) {
      say(reason(e))
    }
  }

  const ideas = rooms.filter((r) => r.pack === 'workshop' && !r.archived)
  const builders = useBuilders().map((a) => a.alphabet)
  const busy = !!state?.busy && !state.busy.error
  const behind = !!state?.ready && !!state.base && state.base !== state.current
  const changed = state?.changes.length ?? 0

  return (
    <div className="page">
      <div className="pagebody wide">
        <header className="pagehead rise">
          <h1>Workshop</h1>
          <p>Describe what you want Lunchbox to do. An agent builds it into your own Lunchbox, and you try it with one click.</p>
        </header>

        {!isDesktop && <div className="hint rise">The Workshop works in the desktop app.</div>}

        <Now state={state} busy={busy} waiting={!!state?.ready && changed > 0 && !behind && !busy && !state.mine} />

        {state?.mine && (
          <section className="ws-mine rise" style={{ '--i': 1 } as CSSProperties}>
            <span className="ws-dot" aria-hidden />
            <div className="grow"><b>You are using your Lunchbox</b><span>Everything you built is in this one. Updates arrive in the standard Lunchbox.</span></div>
            <button className="btn small quiet" onClick={() => act('workshop:back')}>Switch back</button>
          </section>
        )}

        {state?.failed && (
          <section className="ws-note rise">
            <div className="grow">{state.failed}</div>
            <button className="btn small quiet" onClick={() => act('workshop:dismiss')}>Dismiss</button>
          </section>
        )}

        <Ask disabled={busy || !!state?.waiting} onStart={build} />

        {state && (busy || state.busy?.error) && (
          <Progress state={state} first={!state.ready} retry={() => (state.waiting ? build(state.waiting) : act(last.current ?? (state.ready ? 'workshop:open' : 'workshop:setup')))} clear={() => act('workshop:dismiss')}
            agent={state.conflict ? () => build(`Bring my Workshop changes from Lunchbox ${state.base} onto ${state.current}. Git could not move them on its own, because the same code changed in the release. Rebase the commits on the branch mine onto the tag ${state.current} by hand, keep what each change was for, and make the typecheck, the tests and the build pass.`) : undefined} />
        )}

        {behind && !busy && (
          <section className="ws-card rise" style={{ '--i': 2 } as CSSProperties}>
            <div className="grow"><b>Lunchbox was updated</b><span>Bring what you built along to the new version.</span></div>
            <button className="btn small" onClick={() => act('workshop:update', 'What you built is on the new version')}>Bring it along</button>
          </section>
        )}

        {state?.ready && changed > 0 && !behind && (
          <section className="ws-card ws-built rise" style={{ '--i': 2 } as CSSProperties}>
            <div className="grow">
              <b><i className="ws-lit" aria-hidden />{state.mine ? 'Your Lunchbox' : 'Ready to try'}</b>
              <span>{changed} file{changed === 1 ? '' : 's'} changed{ideas.length ? `, from ${ideas.length} idea${ideas.length === 1 ? '' : 's'}` : ''}. <button className="linkish" onClick={() => setDetails(!details)} aria-expanded={details}>{details ? 'Hide details' : 'Details'}</button></span>
            </div>
            <span className="ws-tally" title="One mark per file. Lit marks are new files.">
              <span className="ws-ticks" aria-hidden>{state.changes.slice(0, 40).map((c) => <i key={c.file} className={c.fresh ? 'new' : ''} />)}</span>
              <span className="ws-count"><i>+{state.changes.reduce((n, c) => n + c.added, 0)}</i><em>−{state.changes.reduce((n, c) => n + c.removed, 0)}</em></span>
            </span>
            <button className="btn" disabled={busy} onClick={() => act('workshop:open')}><IconPlay />{state.mine ? 'Restart with changes' : 'Try it'}</button>
            <div className="ws-also"><span>Want everyone to have it too?</span><Suggest disabled={busy} say={say} /></div>
            {details && (
              <div className="ws-details">
                <Changes state={state} />
                <div className="ws-actions">
                  <span className="hint grow">Built on Lunchbox {label(state.base)}.</span>
                  <button className="btn small quiet" onClick={() => desk.call('workshop:folder')}><IconFolder />Show folder</button>
                  <Sure act={() => act('workshop:reset', 'Back to Lunchbox as it shipped')} className="btn small quiet ws-undo" label="Undo every change in your copy">
                    {(sure) => (sure ? 'Undo everything?' : 'Undo all changes')}
                  </Sure>
                </div>
                {state.use && !state.mine && <div className="hint">Your Lunchbox opens when Lunchbox starts. <button className="linkish" onClick={() => act('workshop:stop-using')}>Open the standard one instead</button></div>}
              </div>
            )}
          </section>
        )}

        {ideas.length > 0 && (
          <section className="group rise" style={{ '--i': 3 } as CSSProperties}>
            <h2>Your ideas</h2>
            <div className="settings">
              {ideas.map((r) => (
                <button key={r.id} className="setting ws-idea" onClick={() => go({ name: 'room', id: r.id })}>
                  <span className="grow"><b>{r.name}</b></span>
                  {r.waiting ? <i className="waitdot" title="Needs you" /> : r.busy ? <><Loader size={10} /><small>building</small></> : <small>{ago(r.updated)}</small>}
                </button>
              ))}
            </div>
          </section>
        )}

        {state && !state.ready && !busy && !state.busy?.error && !ideas.length && (
          <ol className="ws-steps rise" style={{ '--i': 2 } as CSSProperties}>
            {STEPS.map((st, i) => (
              <li key={st.name}>
                <div className="ws-stephead"><code>0{i + 1}</code><i /></div>
                <pre aria-hidden="true">{st.art(builders).map(line)}</pre>
                <b>{st.name}</b>
                <span>{st.line}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

// In a Workshop room's header: the two things to do once the agents are done.
export function WorkshopBar({ busy, say }: { busy: boolean; say: (t: string) => void }) {
  const [sending, setSending] = useState(false)
  const [opening, setOpening] = useState(false)
  const mine = useApp((s) => !!s.env.workshop)
  const openIt = async () => {
    setOpening(true)
    try {
      const s = (await desk.call('workshop:open')) as WorkshopState
      if (s?.busy?.error) say(s.busy.error)
    } catch (e) { say(reason(e)) } finally { setOpening(false) }
  }
  const send = async () => {
    setSending(true)
    try {
      const r = await desk.call('workshop:suggest', '', '')
      say(r?.ok ? 'Sent to the Lunchbox maintainers. Thank you' : r?.queued ? 'Saved, it goes out when you are back online' : 'It could not be sent')
    } catch (e) { say(reason(e)) } finally { setSending(false) }
  }
  const wait = busy ? 'Waits until the agents are done' : undefined
  return (
    <span className="ws-bar">
      <span className="tag ws-tag">Workshop</span>
      <button className="ghostbtn" disabled={busy || opening} onClick={openIt} title={wait ?? 'Build your Lunchbox and open it in place of the standard one'}>{opening ? <Loader size={10} /> : <IconPlay />}<span>{mine ? 'Restart with changes' : 'Try it'}</span></button>
      <button className="ghostbtn" disabled={busy || sending} onClick={send} title={wait ?? 'Also send it to the Lunchbox maintainers, so everyone can have it. Your own Lunchbox keeps it either way.'}>{sending ? <Loader size={10} /> : <IconShare />}<span>Send to Lunchbox too</span></button>
    </span>
  )
}

function Progress({ state, first, retry, clear, agent }: { state: WorkshopState; first: boolean; retry: () => void; clear: () => void; agent?: () => void }) {
  const b = state.busy!
  const [, tick] = useState(0)
  useEffect(() => { if (b.error) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t) }, [b.error])
  const secs = Math.max(0, Math.round((Date.now() - b.at) / 1000))
  return (
    <section className={`ws-progress rise${b.error ? ' failed' : ''}`} aria-live="polite">
      <div className="ws-progresshead">
        {b.error ? <span className="ws-bad" aria-hidden /> : <Loader size={12} />}
        <b className="grow">{b.error ? 'That did not finish' : b.step}{!b.error && first && <span className="ws-sub">Setting up your Lunchbox, once. Your idea starts right after.</span>}</b>
        {!b.error && <code>{secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`}</code>}
      </div>
      {b.error && <p>{b.error}</p>}
      {b.log.length > 0 && (b.error ? <pre className="ws-log">{b.log.slice(-6).join('\n')}</pre> : <code className="ws-tail">{b.log.at(-1)}</code>)}
      {b.error && (
        <div className="ws-actions">
          {agent ? <button className="btn small" onClick={agent}>Let an agent bring them over</button> : <button className="btn small" onClick={retry}>Try again</button>}
          <button className="btn small quiet" onClick={clear}>Close</button>
        </div>
      )}
    </section>
  )
}

// Who builds starts as the default crew and can be changed here, the same menu as a room's.
function Ask({ disabled, onStart }: { disabled: boolean; onStart: (text: string, crew: string[]) => void }) {
  const [text, setText] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  const agents = useApp((s) => s.agents)
  const builders = useBuilders()
  const [picked, setPicked] = useState<string[] | null>(null)
  const crew = (picked ?? builders.map((a) => a.id)).filter((id) => agents.some((a) => a.id === id))
  const names = crew.map((id) => agentOf(id, agents).short)
  const toggle = (id: string) => setPicked(crew.includes(id) ? (crew.length > 1 ? crew.filter((w) => w !== id) : crew) : [...crew, id])
  const listed = [...agents].filter((a) => a.found || crew.includes(a.id)).sort((a, b) => Number(!!unavailable(a)) - Number(!!unavailable(b)))
  const go = () => { if (text.trim() && !disabled && crew.length) { onStart(text.trim(), crew); setText('') } }
  return (
    <section className="ws-ask rise" style={{ '--i': 1 } as CSSProperties}>
      <div className="ws-field">
        <textarea ref={field} rows={2} value={text} disabled={disabled} placeholder="What should Lunchbox do that it does not do yet?"
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go() } }} />
        <div className="ws-fieldfoot">
          {crew.length > 0 ? (
            <>
              <Menu label="Who builds it" button={<><span className="stack">{crew.map((id) => <span key={id}><Mark seed={agentOf(id, agents).mark} size={12} /></span>)}</span><span className="crewpill">{crew.length === 1 ? names[0] : `${crew.length} agents`}</span></>}>
                {(close) => <CrewMenu listed={listed} crew={crew} toggle={toggle} close={close} promote={(id) => setPicked([id, ...crew.filter((w) => w !== id)])} footer={null} />}
              </Menu>
              <span className="ws-by">{names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} build it` : `${names[0]} builds it`}, in a room of its own</span>
            </>
          ) : <span className="ws-by">Connect an agent on the Agents page to build it</span>}
          <button className="btn small" disabled={!text.trim() || disabled || !crew.length} onClick={go}>Build it<kbd>↵</kbd></button>
        </div>
      </div>
      <div className="ws-chips">
        <small>For example</small>
        {IDEAS.map((i) => <button key={i} className="ws-chip" onClick={() => { setText(i); field.current?.focus() }}>{i}</button>)}
      </div>
    </section>
  )
}

function Changes({ state }: { state: WorkshopState }) {
  const [all, setAll] = useState(false)
  const list = all ? state.changes : state.changes.slice(0, 8)
  return (
    <div className="ws-files">
      {list.map((c) => (
        <div key={c.file} className="ws-file">
          <code className="grow">{c.file}</code>
          {c.fresh ? <span className="ws-new">new</span> : <span className="ws-count"><i>+{c.added}</i><em>−{c.removed}</em></span>}
        </div>
      ))}
      {state.changes.length > 8 && <button className="linkish" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${state.changes.length}`}</button>}
    </div>
  )
}

// One click sends it, with what was asked of the agents as the note. A note of their own is optional.
function Suggest({ disabled, say }: { disabled: boolean; say: (t: string) => void }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [contact, setContact] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const send = async () => {
    setSending(true)
    try {
      const r = await desk.call('workshop:suggest', note, contact)
      say(r?.ok ? 'Sent to the Lunchbox maintainers. Thank you' : r?.queued ? 'Saved, it goes out when you are back online' : 'It could not be sent')
      if (r?.ok || r?.queued) { setOpen(false); setNote(''); setSent(true) }
    } catch (e) {
      say(reason(e))
    } finally {
      setSending(false)
    }
  }
  if (!open) {
    return (
      <span className="ws-send">
        <button className="btn small quiet" disabled={disabled || sending} onClick={send} title="Sends your change and what you asked for to the Lunchbox maintainers. Your own Lunchbox keeps it either way.">
          {sending ? <Loader size={10} /> : <IconShare />}{sent ? 'Sent, send again' : 'Send it to Lunchbox'}
        </button>
        <button className="linkish ws-note-link" disabled={disabled} onClick={() => setOpen(true)}>Add a note</button>
      </span>
    )
  }
  return (
    <div className="ws-suggest">
      <textarea autoFocus rows={3} value={note} placeholder="What it does and why you wanted it" onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); if (e.key === 'Escape') setOpen(false) }} />
      <input value={contact} placeholder="Email or X handle, if you want a reply" onChange={(e) => setContact(e.target.value)} />
      <div className="ws-actions">
        <span className="hint grow">Your note and the change go to the Lunchbox maintainers. Paths are written as ~ and keys are removed.</span>
        <button className="btn small quiet" onClick={() => setOpen(false)}>Cancel</button>
        <button className="btn small" disabled={sending} onClick={send}>{sending ? <Loader size={10} /> : null}Send<kbd>{mod}↵</kbd></button>
      </div>
    </div>
  )
}
