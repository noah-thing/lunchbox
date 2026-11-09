import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { flushSync } from 'react-dom'
import type { Hit, Skill } from '../shared/types'
import { Loader } from './ui/bits'
import { IconAgents, IconBrowser, IconClock, IconFlows, IconLibrary, IconPlus, IconPool, IconSave, IconSearch, IconSettings } from './ui/icons'
import { Onboarding } from './views/Onboarding'
import { RoomView } from './views/Room'
import { NewRoom } from './views/NewRoom'
import { Agents } from './views/Agents'
import { Settings } from './views/Settings'
import { Flows } from './views/Flows'
import { Pool } from './views/Pool'
import { Savings } from './views/Savings'
import { Library } from './views/Library'
import { Browser, useBrowser } from './views/Browser'
import { Palette, type Command } from './views/Palette'
import { ago, boot, desk, mod, reload, unavailable, useApp, type Access } from './lib/desk'

export type View =
  | { name: 'room'; id: string; focus?: string }
  | { name: 'new'; skill?: Skill; pack?: string; text?: string }
  | { name: 'agents' } | { name: 'settings' } | { name: 'pool' } | { name: 'savings' } | { name: 'library' } | { name: 'browser' }
  | { name: 'flows'; edit?: string; template?: string }
export type Look = 'lunchbox' | 'neyra'

const saved = <T,>(key: string, fallback: T): T => {
  try { const v = localStorage.getItem('lb.' + key); return v ? JSON.parse(v) : fallback } catch { return fallback }
}
const keep = (key: string, v: unknown) => localStorage.setItem('lb.' + key, JSON.stringify(v))
const calm = () => !document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches

// Native view transitions for every change a person makes. Elements that share a
// view-transition-name morph into each other; everything else crossfades.
export function flow(change: () => void, animate = true) {
  if (!animate || calm()) return change()
  document.startViewTransition(() => flushSync(change))
}

// The new theme grows out of the point that was clicked, as one circle over the old one.
function reveal(change: () => void, at?: { x: number; y: number }) {
  if (calm()) return change()
  const x = at?.x ?? innerWidth - 120
  const y = at?.y ?? innerHeight - 60
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
  const root = document.documentElement
  root.classList.add('revealing')
  const t = document.startViewTransition(() => flushSync(change))
  t.ready.then(() => root.animate(
    { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
    { duration: 620, easing: 'cubic-bezier(.65,0,.25,1)', pseudoElement: '::view-transition-new(root)' },
  ))
  t.finished.finally(() => root.classList.remove('revealing'))
}

export function App() {
  const [theme, setThemeState] = useState<'dark' | 'light'>(saved('theme', 'dark'))
  const [look, setLookState] = useState<Look>(() => (new URLSearchParams(location.search).get('look') as Look | null) ?? saved('look', 'lunchbox'))
  const [ready, setReady] = useState<boolean>(saved('ready', false))
  const [arriving, setArriving] = useState(false)
  const [view, setView] = useState<View>(() => saved<View>('view', { name: 'new' }))
  const [palette, setPalette] = useState(false)
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null)
  const [access, setAccessState] = useState<Access>(saved('access', 'workspace'))
  const [workspace, setWorkspaceState] = useState<string>(saved('workspace', ''))
  const loaded = useApp((s) => s.loaded)
  const rooms = useApp((s) => s.rooms)
  const agents = useApp((s) => s.agents)
  const skills = useApp((s) => s.skills)
  const flows = useApp((s) => s.flows)
  const running = useApp((s) => s.running)
  const web = useBrowser()
  const env = useApp((s) => s.env)

  useEffect(() => { boot() }, [])
  useEffect(() => { if (!workspace && env.cwd) setWorkspaceState(env.cwd) }, [env.cwd, workspace])
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    keep('theme', theme)
    desk.call('theme', theme === 'dark')
  }, [theme])
  useLayoutEffect(() => { document.documentElement.dataset.look = look; keep('look', look) }, [look])
  useEffect(() => { if (view.name !== 'new') keep('view', view.name === 'room' ? { name: 'room', id: view.id } : { name: view.name }) }, [view])
  const searchButton = useRef<HTMLButtonElement>(null)
  const listed = useRef(new Set<string>())
  const first = useRef(true)
  useEffect(() => {
    if (!loaded) return
    const ids = new Set(rooms.map((r) => r.id))
    const gone = view.name === 'room' && !ids.has(view.id) && (first.current || listed.current.has(view.id))
    listed.current = ids
    first.current = false
    if (gone) setView({ name: 'new' })
  }, [loaded, rooms, view])

  const setTheme = (t: 'dark' | 'light', e?: MouseEvent) => { if (t !== theme) reveal(() => setThemeState(t), e && { x: e.clientX, y: e.clientY }) }
  const setLook = (l: Look) => flow(() => setLookState(l))
  const setAccess = (a: Access) => { setAccessState(a); keep('access', a) }
  const setWorkspace = (w: string) => { setWorkspaceState(w); keep('workspace', w) }
  const say = useCallback((text: string) => setToast({ text, id: Date.now() }), [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2800)
    return () => clearTimeout(t)
  }, [toast])

  // Page changes are plain state changes: the new page rises in with CSS and the sidebar highlight
  // glides over. A view transition here snapshotted the whole window and cost a frame each time.
  const go = (v: View) => { setPalette(false); setView(v) }
  const lastSel = useRef<DOMRect | null>(null)
  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>('.sidebar .sbsel')
    const now = el?.getBoundingClientRect() ?? null
    const was = lastSel.current
    lastSel.current = now
    if (!el || !now || !was || calm() || Math.abs(was.top - now.top) < 1) return
    el.animate([{ transform: `translateY(${was.top - now.top}px)` }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.3,.9,.2,1)' })
  })
  const openPalette = (open: boolean) => setPalette(open)
  useEffect(() => desk.on('open-room', (id: string) => go({ name: 'room', id })), [])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!ready || !(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      if (k === 'k') { e.preventDefault(); if (!palette) openPalette(true) }
      if (k === 'n') { e.preventDefault(); go({ name: 'new' }) }
      if (k === ',') { e.preventDefault(); go({ name: 'settings' }) }
      if (e.shiftKey && k === 'f') { e.preventDefault(); go({ name: 'flows' }) }
      if (e.shiftKey && k === 'p') { e.preventDefault(); go({ name: 'pool' }) }
      if (e.shiftKey && k === 'l') { e.preventDefault(); go({ name: 'library' }) }
      if (e.shiftKey && k === 'b') { e.preventDefault(); go({ name: 'browser' }) }
      if (/^[1-9]$/.test(k) && rooms[Number(k) - 1]) { e.preventDefault(); go({ name: 'room', id: rooms[Number(k) - 1].id }) }
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  })

  const finish = (folder: string | null) => {
    if (folder) setWorkspace(folder)
    keep('ready', true)
    setReady(true)
    setArriving(true)
    setTimeout(() => setArriving(false), 1100)
  }

  if (!loaded) return <div className="booting"><Loader size={14} /></div>
  if (!ready) return <Onboarding onDone={finish} workspace={workspace} setTheme={(t, e) => setTheme(t, e)} theme={theme} />

  const commands: Command[] = [
    { group: 'Actions', label: 'New room', hint: `${mod}N`, run: () => go({ name: 'new' }) },
    ...rooms.map((r) => ({ group: 'Rooms' as const, label: r.name, hint: r.waiting ? 'needs you' : r.busy ? 'working' : ago(r.updated), run: () => go({ name: 'room', id: r.id }) })),
    ...skills.map((s) => ({ group: 'Skills' as const, label: s.name, hint: `${s.steps.length} steps`, run: () => go({ name: 'new', skill: s }) })),
    ...flows.map((f) => ({ group: 'Flows' as const, label: `Run ${f.name}`, hint: `${f.steps.length} steps`, run: async () => { const room = await desk.call('flows:run', f.id); if (room) go({ name: 'room', id: room }) } })),
    { group: 'Go to', label: 'Flows', hint: `${mod}⇧F`, run: () => go({ name: 'flows' }) },
    { group: 'Go to', label: 'Pool', hint: `${mod}⇧P`, run: () => go({ name: 'pool' }) },
    { group: 'Go to', label: 'Savings', hint: 'Prompt cache', run: () => go({ name: 'savings' }) },
    { group: 'Go to', label: 'Library', hint: `${mod}⇧L`, run: () => go({ name: 'library' }) },
    { group: 'Go to', label: 'Browser', hint: `${mod}⇧B`, run: () => go({ name: 'browser' }) },
    { group: 'Actions', label: 'New flow', hint: 'Flows', run: () => go({ name: 'flows', edit: 'new' }) },
    { group: 'Go to', label: 'Agents', hint: 'Connected agents, models and budgets', run: () => go({ name: 'agents' }) },
    { group: 'Go to', label: 'Settings', hint: `${mod},`, run: () => go({ name: 'settings' }) },
    { group: 'Actions', label: theme === 'dark' ? 'Switch to light' : 'Switch to dark', hint: 'Appearance', run: () => setTheme(theme === 'dark' ? 'light' : 'dark') },
    { group: 'Actions', label: look === 'neyra' ? 'Look: Lunchbox' : 'Look: Neyra', hint: 'Appearance', run: () => setLook(look === 'neyra' ? 'lunchbox' : 'neyra') },
    { group: 'Actions', label: 'Check for agents again', hint: 'Agents', run: async () => { await reload.agents(); say('Checked again') } },
    { group: 'Actions', label: 'Mode: Plan', hint: 'Read and plan only', run: () => setAccess('plan') },
    { group: 'Actions', label: 'Mode: Ask', hint: 'Changes wait for your OK', run: () => setAccess('ask') },
    { group: 'Actions', label: 'Mode: Auto', hint: 'Free inside the folder', run: () => setAccess('workspace') },
    { group: 'Actions', label: 'Mode: Full access', hint: 'Anything on this computer', run: () => setAccess('full') },
  ]
  const openHit = (h: Hit) => go({ name: 'room', id: h.room, focus: h.event })

  const on = (name: View['name'], id?: string) => view.name === name && (!id || (view.name === 'room' && view.id === id))
  const ready_ = agents.filter((a) => !unavailable(a)).length
  const sel = <i className="sbsel" />

  return (
    <div className={`app${arriving ? ' arriving' : ''}`}>
      <aside className="sidebar">
        <div className="sbtop" />
        <button className={`sbitem${on('new') ? ' on' : ''}`} onClick={() => go({ name: 'new' })}>{on('new') && sel}<IconPlus />New room<kbd>{mod}N</kbd></button>
        <button ref={searchButton} className={`sbitem${palette ? ' on' : ''}`} onClick={() => openPalette(true)}><IconSearch />Search<kbd>{mod}K</kbd></button>
        <div className="sbgap" />
        <button className={`sbitem${on('flows') ? ' on' : ''}`} onClick={() => go({ name: 'flows' })}>{on('flows') && sel}<IconFlows />Flows{running.length ? <Loader size={10} /> : flows.length ? <small>{flows.filter((f) => f.on && f.every).length || ''}</small> : null}</button>
        <button className={`sbitem${on('pool') ? ' on' : ''}`} onClick={() => go({ name: 'pool' })}>{on('pool') && sel}<IconPool />Pool</button>
        <button className={`sbitem${on('savings') ? ' on' : ''}`} onClick={() => go({ name: 'savings' })}>{on('savings') && sel}<IconSave />Savings</button>
        <button className={`sbitem${on('library') ? ' on' : ''}`} onClick={() => go({ name: 'library' })}>{on('library') && sel}<IconLibrary />Library</button>
        <button className={`sbitem${on('browser') ? ' on' : ''}`} onClick={() => go({ name: 'browser' })}>{on('browser') && sel}<IconBrowser />Browser{web.driver && <i className="livedot" title="An agent is using the browser" />}</button>
        <div className="sblabel">Rooms</div>
        <div className="sbrooms">
          {rooms.map((r) => (
            <button key={r.id} className={`sbroom${on('room', r.id) ? ' on' : ''}`} onClick={() => go({ name: 'room', id: r.id })} title={r.name}>
              {on('room', r.id) && sel}
              {r.flow && <span className="sbflow" title="Started by a flow"><IconClock /></span>}
              <span className="grow">{r.name}</span>
              {r.waiting ? <i className="waitdot" title="Needs you" /> : r.busy ? <Loader size={10} /> : <small>{ago(r.updated)}</small>}
            </button>
          ))}
          {!rooms.length && <div className="sbempty">Rooms you start show up here.</div>}
        </div>
        <div className="sbfoot">
          <button className={`sbitem${on('agents') ? ' on' : ''}`} onClick={() => go({ name: 'agents' })}>{on('agents') && sel}<IconAgents />Agents<small>{ready_}</small></button>
          <button className={`sbitem${on('settings') ? ' on' : ''}`} onClick={() => go({ name: 'settings' })}>{on('settings') && sel}<IconSettings />Settings</button>
          {look === 'neyra' && <div className="sbversion">lunchbox {env.version}</div>}
        </div>
      </aside>

      <main className="sheet">
        {view.name === 'room' && <RoomView key={view.id} id={view.id} focus={view.focus} access={access} setAccess={setAccess} open={(id) => go({ name: 'room', id })} say={say} />}
        {view.name === 'new' && <NewRoom key={view.skill?.id ?? view.pack ?? 'new'} skill={view.skill} pack={view.pack} text={view.text} onCreated={(id) => go({ name: 'room', id })} go={go} access={access} setAccess={setAccess} workspace={workspace} setWorkspace={setWorkspace} />}
        {view.name === 'agents' && <Agents say={say} />}
        {view.name === 'flows' && <Flows key={view.edit ?? view.template ?? 'list'} edit={view.edit} template={view.template} go={go} say={say} workspace={workspace} />}
        {view.name === 'pool' && <Pool go={go} say={say} />}
        {view.name === 'savings' && <Savings go={go} />}
        {view.name === 'library' && <Library go={go} say={say} />}
        {view.name === 'browser' && <Browser say={say} covered={palette} />}
        {view.name === 'settings' && <Settings theme={theme} setTheme={setTheme} look={look} setLook={setLook} say={say} restart={() => flow(() => { keep('ready', false); setReady(false) })} />}
      </main>

      {palette && <Palette commands={commands} close={() => openPalette(false)} openHit={openHit} anchor={searchButton} />}
      {toast && <div key={toast.id} className="toast">{toast.text}</div>}
    </div>
  )
}
