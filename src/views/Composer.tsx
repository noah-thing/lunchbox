import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Mark, Thumb } from '../ui/bits'
import { Menu, ModePicker } from '../ui/Access'
import { CrewMenu } from '../ui/ModelPicker'
import { IconClip, IconClose, IconSplit, IconStudio, IconStop, IconUp } from '../ui/icons'
import { agentOf, desk, machine, unavailable, useApp, type Access } from '../lib/desk'
import { PLAYBOOKS, fillPlaybook } from '../../shared/skills'
import { addOpenCode, hasOpenCode, openCodeFound } from './Connect'

type Suggestion = { key: string; label: string; hint: string; insert: string; mark?: string }

export function Composer({ crew, setCrew, onSend, access, setAccess, busy = false, onStop, arena = false, setArena, studio = false, setStudio, draft, autoFocus = true, placeholder, pack, folder }: {
  crew: string[]; setCrew: (c: string[]) => void; onSend: (t: string, files?: string[]) => void; access: Access; setAccess: (a: Access) => void
  busy?: boolean; onStop?: () => void; arena?: boolean; setArena?: (a: boolean) => void; studio?: boolean; setStudio?: (on: boolean) => void; draft?: { text: string; files?: string[]; n: number; merge?: boolean }; autoFocus?: boolean; placeholder?: string; pack?: string; folder?: string
}) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [over, setOver] = useState(false)
  const addFiles = (paths: string[]) => setFiles((f) => [...new Set([...f, ...paths.filter(Boolean)])].slice(0, 12))
  const attach = async () => addFiles(await desk.call('attach'))
  // Dropped files keep their path; pasted images have none, so they are written to the folder.
  const take = async (list: FileList | null) => {
    if (!list?.length) return false
    const out: string[] = []
    for (const f of Array.from(list)) {
      const path = desk.pathOf?.(f)
      if (path) { out.push(path); continue }
      if (!f.type.startsWith('image/')) continue
      const data = await new Promise<string>((done) => { const r = new FileReader(); r.onload = () => done(String(r.result)); r.readAsDataURL(f) })
      const saved = await desk.call('attach:data', data, f.type.split('/')[1] || 'png', folder)
      if (saved) out.push(saved)
    }
    addFiles(out)
    return out.length > 0
  }
  const [at, setAt] = useState(0)
  const [caret, setCaret] = useState(0)
  const area = useRef<HTMLTextAreaElement>(null)
  // The crew as it is now, for a menu action that finishes after an await.
  const crewNow = useRef(crew)
  crewNow.current = crew
  const agents = useApp((s) => s.agents)
  const connectors = useApp((s) => s.settings.connectors) ?? []
  const skills = useApp((s) => s.skills)
  const packs = useApp((s) => s.packs)
  useApp((s) => s.ledger)

  useEffect(() => {
    if (!draft) return
    // Text handed back from the queue goes in front of anything typed since, not over it.
    setText((now) => (draft.merge && now.trim() ? `${draft.text}\n\n${now}` : draft.text))
    if (draft.files) setFiles((now) => (draft.merge ? [...draft.files!, ...now] : draft.files!))
    requestAnimationFrame(() => { area.current?.focus(); area.current?.setSelectionRange(draft.text.length, draft.text.length) })
  }, [draft])
  const fit = () => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 240) + 'px'
  }
  useLayoutEffect(fit, [text])
  // A narrower window wraps the text or the hint onto more lines, so the box fits again when its
  // width changes. Only width: reacting to its own new height would loop.
  useEffect(() => {
    const el = area.current
    if (!el) return
    let width = el.offsetWidth
    const ro = new ResizeObserver(() => { if (el.offsetWidth !== width) { width = el.offsetWidth; fit() } })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === '/' && (e.target as HTMLElement)?.tagName !== 'TEXTAREA' && (e.target as HTMLElement)?.tagName !== 'INPUT') { e.preventDefault(); area.current?.focus() }
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [])

  const before = text.slice(0, caret)
  const mention = before.match(/(^|\s)@([\w-]*)$/)
  const slash = before.match(/^\/([\w -]*)$/)
  let suggestions: Suggestion[] = []
  if (mention) {
    // The crew first, then anyone else who is ready: @ brings them in for this message.
    const q = mention[2].toLowerCase()
    const others = agents.filter((a) => a.ready && !crew.includes(a.id)).map((a) => a.id)
    suggestions = [...crew, ...others].map((id) => agentOf(id, agents)).filter((a) => a.id.startsWith(q) || a.short.toLowerCase().startsWith(q))
      .map((a) => ({ key: a.id, label: a.short, hint: crew.includes(a.id) ? a.good : `Joins for this message. ${a.good}`, insert: `@${a.id} `, mark: a.mark }))
  } else if (slash) {
    const q = slash[1].toLowerCase()
    const checks = packs.find((p) => p.id === pack)?.checks ?? []
    suggestions = [
      ...checks.map((c) => ({ key: c.command, label: c.label, hint: c.command, insert: `!${c.command}` })),
      ...skills.map((s) => ({ key: s.id, label: s.name, hint: `Skill, ${s.steps.length} steps`, insert: `${s.brief}\n\nSteps that worked last time:\n${s.steps.map((x) => `- ${x}`).join('\n')}` })),
      ...PLAYBOOKS.map((p) => ({ key: `p-${p.id}`, label: p.name, hint: `${p.field} · ${p.line}`, insert: fillPlaybook(p, '') })),
    ].filter((s) => s.label.toLowerCase().includes(q) || s.hint.toLowerCase().includes(q)).slice(0, 8)
  }
  const pickSuggestion = (s: Suggestion) => {
    const start = mention ? caret - mention[2].length - 1 : 0
    const next = text.slice(0, start) + s.insert + text.slice(caret)
    setText(next)
    const pos = start + s.insert.length
    requestAnimationFrame(() => { area.current?.setSelectionRange(pos, pos); setCaret(pos) })
  }

  const shell = text.startsWith('!')
  const submit = () => {
    if (!text.trim() && !files.length) return
    onSend(text.trim() || 'Have a look at the attached files.', files.length ? files : undefined)
    setText('')
    setFiles([])
    setCaret(0)
  }
  const ready = crew.filter((id) => !unavailable(agentOf(id, agents)))
  const toggle = (id: string) => setCrew(crew.includes(id) ? (crew.length > 1 ? crew.filter((w) => w !== id) : crew) : [...crew, id])
  const listed = [...agents].filter((a) => a.found || crew.includes(a.id)).sort((a, b) => Number(!!unavailable(a)) - Number(!!unavailable(b)))

  return (
    <div className={`composer${shell ? ' shell' : ''}${arena ? ' arena' : ''}${over ? ' over' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false) }}
      onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files) }}>
      {files.length > 0 && (
        <div className="attached">
          {files.map((f) => (
            <span key={f} className="file" title={f}>
              <Thumb path={f} />
              <span>{f.split(/[\\/]/).pop()}</span>
              <button onClick={() => setFiles(files.filter((x) => x !== f))} aria-label="Remove"><IconClose /></button>
            </span>
          ))}
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="suggest" role="listbox">
          {suggestions.map((s, i) => (
            <button key={s.key} role="option" aria-selected={i === at % suggestions.length} className={i === at % suggestions.length ? 'on' : ''}
              onMouseEnter={() => setAt(i)} onMouseDown={(e) => { e.preventDefault(); pickSuggestion(s) }}>
              {s.mark && <Mark seed={s.mark} size={12} />}<b>{s.label}</b><span>{s.hint}</span>
            </button>
          ))}
        </div>
      )}
      <textarea ref={area} value={text} rows={1} autoFocus={autoFocus} spellCheck
        placeholder={placeholder ?? 'Message the room'}
        onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); setAt(0) }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); take(e.clipboardData.files) } }}
        onKeyDown={(e) => {
          if (suggestions.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); return setAt(at + 1) }
            if (e.key === 'ArrowUp') { e.preventDefault(); return setAt(at - 1 + suggestions.length) }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); return pickSuggestion(suggestions[at % suggestions.length]) }
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
        }} />
      <div className="cbar">
        <Menu label="Agents in this room" button={<><span className="stack">{crew.map((w) => <span key={w}><Mark seed={agentOf(w, agents).mark} size={12} /></span>)}</span>{crew.length === 1 ? agentOf(crew[0], agents).short : `${crew.length} agents`}</>}>
          {() => (
            <CrewMenu listed={listed} crew={crew} toggle={toggle} promote={(id) => setCrew([id, ...crew.filter((w) => w !== id)])} footer={
              <>
                {!listed.length && <div className="menunote">No agents found yet.</div>}
                <div className="sep" />
                {!hasOpenCode(connectors) && (
                  // Installed: added and seated in one click. Not installed: the Agents page shows how.
                  <button className="item" onClick={async () => {
                    const page = () => dispatchEvent(new CustomEvent('lb:go', { detail: { name: 'agents' } }))
                    if (!(await openCodeFound())) return page()
                    const id = await addOpenCode().catch(() => null)
                    if (!id) return page()
                    setCrew([...crewNow.current.filter((w) => w !== id), id])
                  }}>
                    <Mark seed="opencode" size={14} />
                    <span className="grow"><b>Add OpenCode</b><span>Free models, no key needed</span></span>
                  </button>
                )}
                {/* Everything else, free providers and custom agents, lives on the Agents page. */}
                <button className="item" onClick={() => dispatchEvent(new CustomEvent('lb:go', { detail: { name: 'agents', add: true } }))}>
                  <span className="grow"><b>See all agents</b><span>Free models, Qoder, Aider, any API or command line tool</span></span>
                </button>
              </>
            } />
          )}
        </Menu>
        {setArena && crew.length > 1 && !shell && (
          <button className={`pill split${arena ? ' open' : ''}`} onClick={() => setArena(!arena)} aria-pressed={arena} title="Everyone answers on their own, you keep the best">
            <IconSplit />Side by side
          </button>
        )}
        {setStudio && !shell && (
          <button className={`pill studio${studio ? ' open' : ''}`} onClick={() => setStudio(!studio)} aria-pressed={studio}
            title="Studio: agents set a direction, look at what they make and refine it before handing over. Your own design files and references always come first.">
            <IconStudio />Studio
          </button>
        )}
        {shell && <span className="shellnote">Runs on {machine()}</span>}
        {!shell && ready.length < crew.length && <span className="shellnote">{crew.length - ready.length} unavailable</span>}
        <span className="spacer" />
        {!shell && <button className="iconbtn" onClick={attach} aria-label="Attach files" title="Attach files, or drop and paste them"><IconClip /></button>}
        <ModePicker value={access} onChange={setAccess} />
        {busy && !text.trim() && onStop
          ? <button className="send stop" onClick={onStop} aria-label="Stop" title="Stop (Esc)"><IconStop /></button>
          : <button className="send" disabled={!text.trim() && !files.length} onClick={submit} aria-label="Send"><IconUp /></button>}
      </div>
    </div>
  )
}
