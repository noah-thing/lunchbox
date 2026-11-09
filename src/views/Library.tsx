import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { CATALOG, GROUPS, type CatalogTool } from '../../shared/catalog'
import { FIELDS, PLAYBOOKS, fillPlaybook, type Field, type Playbook } from '../../shared/skills'
import type { Pack } from '../../shared/types'
import { Loader, Mark } from '../ui/bits'
import { IconClose, IconSearch, IconShare } from '../ui/icons'
import { agentOf, desk, reason, reload, useApp } from '../lib/desk'
import type { View } from '../App'
import { Toggle } from './Flows'

type Tab = 'playbooks' | 'tools' | 'packs' | 'skills'
export type ToolState = { id: string; state: 'off' | 'starting' | 'ready' | 'error'; tools: { name: string; description: string }[]; error?: string; missing?: string[] }

const TABS: { id: Tab; name: string }[] = [
  { id: 'playbooks', name: 'Playbooks' },
  { id: 'tools', name: 'Tools' },
  { id: 'packs', name: 'Packs' },
  { id: 'skills', name: 'Your skills' },
]

export function Library({ go, say }: { go: (v: View) => void; say: (t: string) => void }) {
  const [tab, setTab] = useState<Tab>(() => (sessionStorage.getItem('lb.libtab') as Tab) || 'playbooks')
  const [q, setQ] = useState('')
  useEffect(() => { sessionStorage.setItem('lb.libtab', tab) }, [tab])
  const skills = useApp((s) => s.skills)
  const packs = useApp((s) => s.packs)
  const counts: Record<Tab, number> = { playbooks: PLAYBOOKS.length, tools: CATALOG.length, packs: packs.length, skills: skills.length }

  return (
    <div className="page">
      <div className="pagebody wide">
        <header className="pagehead rise">
          <h1>Library</h1>
          <p>Playbooks for work that comes up again and again, tools any agent can use, and packs that set up a room for a field.</p>
        </header>
        <div className="libbar rise" style={{ '--i': 1 } as CSSProperties}>
          <span className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.name}<small>{counts[t.id]}</small></button>
            ))}
          </span>
          <label className="search"><IconSearch /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${TABS.find((t) => t.id === tab)!.name.toLowerCase()}`} /></label>
        </div>
        <div key={tab} className="libbody">
          {tab === 'playbooks' && <Playbooks q={q} go={go} />}
          {tab === 'tools' && <Tools q={q} say={say} />}
          {tab === 'packs' && <Packs q={q} go={go} say={say} />}
          {tab === 'skills' && <Skills q={q} go={go} say={say} />}
        </div>
      </div>
    </div>
  )
}

const match = (q: string, ...parts: (string | undefined)[]) => !q.trim() || parts.join(' ').toLowerCase().includes(q.trim().toLowerCase())

function Playbooks({ q, go }: { q: string; go: (v: View) => void }) {
  const [field, setField] = useState<Field | 'All'>('All')
  const [open, setOpen] = useState<Playbook | null>(null)
  const shown = PLAYBOOKS.filter((p) => (field === 'All' || p.field === field) && match(q, p.name, p.line, p.field, p.prompt))
  return (
    <>
      <div className="chips rise" style={{ '--i': 2 } as CSSProperties}>
        {(['All', ...FIELDS] as const).map((f) => (
          <button key={f} className={`chip small${field === f ? ' on' : ''}`} onClick={() => setField(f)}>{f}</button>
        ))}
      </div>
      <div className="cards">
        {shown.map((p, i) => (
          <button key={p.id} className="card" style={{ '--i': Math.min(i, 16) } as CSSProperties} onClick={() => setOpen(p)}>
            <small>{p.field}</small>
            <b>{p.name}</b>
            <span>{p.line}</span>
            {(p.crew || p.tools) && (
              <span className="cardfoot">
                {p.crew?.map((id) => <Mark key={id} seed={agentOf(id).mark} size={12} />)}
                {p.tools?.slice(0, 2).map((t) => <i key={t}>{CATALOG.find((c) => c.id === t)?.name}</i>)}
              </span>
            )}
          </button>
        ))}
        {!shown.length && <p className="hint">Nothing matches. Try another word.</p>}
      </div>
      {open && <PlaybookSheet p={open} close={() => setOpen(null)} go={go} />}
    </>
  )
}

function PlaybookSheet({ p, close, go }: { p: Playbook; close: () => void; go: (v: View) => void }) {
  const [input, setInput] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { box.current?.focus() }, [])
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [close])
  const start = () => go({ name: 'new', pack: p.pack, text: fillPlaybook(p, input) })
  const tools = (p.tools ?? []).map((t) => CATALOG.find((c) => c.id === t)).filter((t): t is CatalogTool => !!t)
  return createPortal(
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="sheetcard" role="dialog" aria-label={p.name}>
        <header className="row">
          <div className="grow"><small className="quiet mono">{p.field}</small><h2>{p.name}</h2></div>
          <button className="iconbtn" onClick={close} aria-label="Close"><IconClose /></button>
        </header>
        <p className="dim">{p.line}</p>
        {p.ask && (
          <label className="askfield">
            <span>{p.ask}</span>
            <textarea ref={box} rows={3} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start() }} />
          </label>
        )}
        <details className="peek">
          <summary>What the crew is told</summary>
          <pre>{fillPlaybook(p, input || '…')}</pre>
        </details>
        {tools.length > 0 && <p className="hint">Works best with {tools.map((t) => t.name).join(', ')} connected under Tools.</p>}
        <footer className="row">
          <span className="spacer" />
          <button className="btn quiet" onClick={close}>Cancel</button>
          <button className="btn" onClick={start} disabled={!!p.ask && !input.trim()}>Set up the room</button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

function Tools({ q, say }: { q: string; say: (t: string) => void }) {
  const [states, setStates] = useState<ToolState[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const settings = useApp((s) => s.settings)
  useEffect(() => {
    desk.call('tools').then((s) => s && setStates(s))
    return desk.on('tools', setStates)
  }, [])
  const state = (id: string) => states.find((s) => s.id === id)
  const ready = states.filter((s) => s.state === 'ready')
  const count = ready.reduce((n, s) => n + s.tools.length, 0)
  return (
    <>
      <div className="toolnote rise" style={{ '--i': 2 } as CSSProperties}>
        <div className="grow">
          <b>{ready.length ? `${ready.length} connected, ${count} tools in every room` : 'Connect a tool once, every agent can use it'}</b>
          <span>Lunchbox runs these open source MCP servers itself and passes their tools to Claude Code, Codex and Gemini in every room. Nothing to configure per agent.</span>
        </div>
        <div className="row">
          <span className="quiet">Built-in browser</span>
          <Toggle on={settings.browser !== false} set={(on) => reload.settings({ browser: on })} label="Let agents use the built-in browser" />
        </div>
      </div>
      {GROUPS.map((g) => {
        const list = CATALOG.filter((t) => t.group === g && match(q, t.name, t.line, t.repo))
        if (!list.length) return null
        return (
          <section key={g} className="group">
            <h2>{g}</h2>
            <div className="tools">
              {list.map((t, i) => <ToolCard key={t.id} t={t} i={i} s={state(t.id)} open={open === t.id} toggle={() => setOpen(open === t.id ? null : t.id)} say={say} />)}
            </div>
          </section>
        )
      })}
    </>
  )
}

function ToolCard({ t, i, s, open, toggle, say }: { t: CatalogTool; i: number; s?: ToolState; open: boolean; toggle: () => void; say: (t: string) => void }) {
  const conf = useApp((x) => x.settings.tools?.[t.id])
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [have, setHave] = useState<Record<string, boolean>>({})
  const [input, setInput] = useState(conf?.input ?? t.input?.default ?? '')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) desk.call('tools:secrets', t.id).then((h) => h && setHave(h)) }, [open, t.id])
  const on = !!conf?.on
  const state = s?.state ?? 'off'
  const needs = (t.secrets?.some((x) => !x.optional) || t.input) && !on

  const save = async (patch: { on?: boolean }) => {
    setBusy(true)
    try {
      const filled = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim()))
      const r: ToolState | undefined = await desk.call('tools:set', t.id, { ...patch, secrets: filled, ...(t.input ? { input } : {}) })
      setSecrets({})
      await reload.settings({})
      if (r?.state === 'ready') say(`${t.name} connected with ${r.tools.length} tools`)
      else if (r?.state === 'error') say(r.error ?? `${t.name} could not start`)
    } catch (e) { say(reason(e)) } finally { setBusy(false) }
  }
  const flip = (next: boolean) => {
    if (next && needs && !open) return toggle()
    save({ on: next })
  }

  return (
    <div className={`tool${open ? ' open' : ''} ${state}`} style={{ '--i': i } as CSSProperties}>
      <div className="toolhead">
        <button className="grow toolmain" onClick={toggle}>
          <b>{t.name}</b>
          <span>{t.line}</span>
        </button>
        <span className={`toolstate ${state}`}>
          {state === 'starting' || busy ? <Loader size={10} /> : state === 'ready' ? `${s!.tools.length} tools` : state === 'error' ? 'Needs a look' : ''}
        </span>
        <Toggle on={on} set={flip} label={`Connect ${t.name}`} />
      </div>
      {open && (
        <div className="toolbody">
          {s?.error && <p className="hint warn">{s.error}</p>}
          {t.secrets?.map((x) => (
            <label key={x.id} className="field">
              <span>{x.label}{x.optional ? ' (optional)' : ''}{x.url && <> · <a href={x.url} target="_blank" rel="noreferrer">get one</a></>}</span>
              <input type="password" value={secrets[x.id] ?? ''} placeholder={have[x.id] ? 'Saved. Type to replace' : x.hint ?? ''} onChange={(e) => setSecrets({ ...secrets, [x.id]: e.target.value })} />
            </label>
          ))}
          {t.input && (
            <label className="field">
              <span>{t.input.label}</span>
              <input value={input} placeholder={t.input.placeholder} onChange={(e) => setInput(e.target.value)} />
            </label>
          )}
          {s?.state === 'ready' && s.tools.length > 0 && (
            <div className="toolnames">{s.tools.slice(0, 24).map((x) => <code key={x.name} title={x.description}>{x.name}</code>)}{s.tools.length > 24 && <code>+{s.tools.length - 24}</code>}</div>
          )}
          <div className="row">
            <a className="hint mono" href={`https://github.com/${t.repo}`} target="_blank" rel="noreferrer">github.com/{t.repo}</a>
            <span className="spacer" />
            <button className="btn small" disabled={busy} onClick={() => save({ on: true })}>{on ? 'Save and restart' : 'Connect'}</button>
          </div>
        </div>
      )}
    </div>
  )
}

function Packs({ q, go, say }: { q: string; go: (v: View) => void; say: (t: string) => void }) {
  const packs = useApp((s) => s.packs)
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const shown = packs.filter((p) => match(q, p.name, p.line, p.brief))
  const add = async () => {
    setBusy(true)
    try {
      const p: Pack = await desk.call('packs:link', link)
      await reload.packs()
      setLink('')
      say(`Added the ${p.name} pack`)
    } catch (e) { say(reason(e)) } finally { setBusy(false) }
  }
  const importFile = async () => {
    try { const p = await desk.call('packs:import'); if (p) { await reload.packs(); say(`Added the ${p.name} pack`) } } catch (e) { say(reason(e)) }
  }
  const remove = async (p: Pack) => { await desk.call('packs:remove', p.id); await reload.packs(); say(`Removed ${p.name}`) }
  return (
    <>
      <div className="cards">
        {shown.map((p, i) => (
          <div key={p.id} className="card static" style={{ '--i': i } as CSSProperties}>
            <small>{p.source === 'user' ? 'Added by you' : 'Built in'}</small>
            <b>{p.name}</b>
            <span>{p.line}</span>
            <span className="cardfoot">
              <button className="btn small quiet" onClick={() => go({ name: 'new', pack: p.id })}>New room</button>
              <span className="spacer" />
              <button className="iconbtn" title="Share as a file" aria-label="Share" onClick={() => desk.call('packs:export', p.id).then((f: string | null) => f && say('Pack saved'))}><IconShare /></button>
              {p.source === 'user' && <button className="iconbtn" title="Remove" aria-label="Remove" onClick={() => remove(p)}><IconClose /></button>}
            </span>
          </div>
        ))}
      </div>
      <section className="group">
        <h2>Add a pack<span className="quiet">from a link someone shared, or a file</span></h2>
        <div className="row">
          <label className="search grow"><input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://gist.github.com/… or a raw GitHub file" onKeyDown={(e) => e.key === 'Enter' && link && add()} /></label>
          <button className="btn small" disabled={!link || busy} onClick={add}>{busy ? <Loader size={10} /> : 'Add'}</button>
          <button className="btn small quiet" onClick={importFile}>From a file</button>
        </div>
        <p className="hint">A pack is a small JSON file: a name, a brief for the crew, a few ideas and optional checks. Share yours as a gist.</p>
      </section>
    </>
  )
}

function Skills({ q, go, say }: { q: string; go: (v: View) => void; say: (t: string) => void }) {
  const skills = useApp((s) => s.skills)
  const shown = useMemo(() => skills.filter((s) => match(q, s.name, s.brief, ...s.steps)), [skills, q])
  const importOne = async () => {
    try { const s = await desk.call('skills:import'); if (s) say(`Added ${s.name}`) } catch (e) { say(reason(e)) }
  }
  return (
    <>
      {!skills.length && (
        <div className="empty rise">
          <b>Your own skills land here</b>
          <span>When a room goes well, open its menu and choose Save as skill. Lunchbox keeps the brief and the steps that worked, ready to start again with /.</span>
        </div>
      )}
      <div className="cards">
        {shown.map((s, i) => (
          <div key={s.id} className="card static" style={{ '--i': i } as CSSProperties}>
            <small>{s.steps.length} steps</small>
            <b>{s.name}</b>
            <span>{s.brief.slice(0, 120)}</span>
            <span className="cardfoot">
              <button className="btn small quiet" onClick={() => go({ name: 'new', skill: s })}>Use</button>
              <span className="spacer" />
              <button className="iconbtn" title="Share as a file" aria-label="Share" onClick={() => desk.call('skills:export', s.id).then((f: string | null) => f && say('Skill saved'))}><IconShare /></button>
              <button className="iconbtn" title="Delete" aria-label="Delete" onClick={() => desk.call('skills:remove', s.id)}><IconClose /></button>
            </span>
          </div>
        ))}
      </div>
      <div className="row"><button className="btn small quiet" onClick={importOne}>Import a skill file</button></div>
    </>
  )
}
