import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Mark, Thumb } from '../ui/bits'
import { Menu, ModePicker } from '../ui/Access'
import { CrewMenu } from '../ui/ModelPicker'
import { IconClip, IconClose, IconSplit, IconStudio, IconStop, IconUp } from '../ui/icons'
import { agentOf, desk, machine, unavailable, useApp, type Access } from '../lib/desk'
import { follow } from '../lib/fit'
import { PLAYBOOKS, fillPlaybook } from '../../shared/skills'
import { addOpenCode, hasOpenCode, openCodeFound } from './Connect'
import { draftOf, remember, saveDraft, sentIn } from '../lib/drafts'


type Suggestion = { key: string; label: string; hint: string; insert: string; mark?: string; run?: () => void }
type Command = { name: string; agent: string; from: string; description: string; kind: 'prompt' | 'skill' }

export function Composer({ crew, setCrew, onSend, access, setAccess, busy = false, onStop, arena = false, setArena, studio = false, setStudio, draft, autoFocus = true, placeholder, pack, folder, room }: {
  crew: string[]; setCrew: (c: string[]) => void; onSend: (t: string, files?: string[]) => void; access: Access; setAccess: (a: Access) => void
  busy?: boolean; onStop?: () => void; arena?: boolean; setArena?: (a: boolean) => void; studio?: boolean; setStudio?: (on: boolean) => void; draft?: { text: string; files?: string[]; n: number; merge?: boolean }; autoFocus?: boolean; placeholder?: string; pack?: string; folder?: string; room?: string
}) {
  const [text, setText] = useState(() => (room && draftOf(room)?.text) || '')
  const [files, setFiles] = useState<string[]>(() => (room && draftOf(room)?.files) || [])
  useEffect(() => { if (room) saveDraft(room, { text, files }) }, [room, text, files])
  const sent = sentIn(room)
  // Where the up arrow stands in the sent messages; -1 is the box as it was typed.
  const [past, setPast] = useState(-1)
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
      const data = await new Promise<string>((done) => { const r = new FileReader(); r.onload = () => done(String(r.result)); r.onerror = () => done(''); r.readAsDataURL(f) })
      const saved = data && await desk.call('attach:data', data, f.type.split('/')[1] || 'png', folder).catch(() => null)
      if (saved) out.push(saved)
    }
    addFiles(out)
    return out.length > 0
  }
  // Words quoted from the room go under whatever is already typed, with the caret after them.
  useEffect(() => {
    const quoted = (e: Event) => {
      const q = (e as CustomEvent<string>).detail
      setText((now) => (now.trim() ? `${now.replace(/\s+$/, '')}\n\n${q}` : q))
      // At once, so what is typed next is not lost before the box has grown.
      area.current?.focus()
      requestAnimationFrame(() => { const el = area.current; if (!el) return; el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.scrollTop = el.scrollHeight })
    }
    addEventListener('lb:quote', quoted)
    return () => removeEventListener('lb:quote', quoted)
  }, [])
  const takeRef = useRef(take)
  takeRef.current = take
  useEffect(() => {
    const dropped = (e: Event) => { takeRef.current((e as CustomEvent<FileList>).detail); area.current?.focus() }
    addEventListener('lb:files', dropped)
    return () => removeEventListener('lb:files', dropped)
  }, [])
  const [at, setAt] = useState(0)
  const [caret, setCaret] = useState(0)
  // Where the caret goes after text is put in for the person, set before the next key can land.
  const place = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (place.current === null || !area.current) return
    area.current.setSelectionRange(place.current, place.current)
    place.current = null
  }, [text])
  const area = useRef<HTMLTextAreaElement>(null)
  const list = useRef<HTMLDivElement>(null)
  // The crew as it is now, for a menu action that finishes after an await.
  const crewNow = useRef(crew)
  crewNow.current = crew
  const agents = useApp((s) => s.agents)
  const connectors = useApp((s) => s.settings.connectors) ?? []
  const skills = useApp((s) => s.skills)
  const packs = useApp((s) => s.packs)
  useApp((s) => s.ledger)
  // The slash commands set up in the person's agents, here and in this folder.
  const [commands, setCommands] = useState<Command[]>([])
  useEffect(() => {
    let on = true
    desk.call('commands', folder).then((c: Command[]) => on && Array.isArray(c) && setCommands(c), () => {})
    return () => { on = false }
  }, [folder])

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
      if (e.key === '/' && !document.querySelector('.scrim') && !(e.target as HTMLElement)?.isContentEditable && (e.target as HTMLElement)?.tagName !== 'TEXTAREA' && (e.target as HTMLElement)?.tagName !== 'INPUT') { e.preventDefault(); area.current?.focus() }
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [])

  const [shut, setShut] = useState<string | null>(null)
  const before = text.slice(0, caret)
  const mention = before.match(/(^|\s)@([\w-]*)$/)
  const slash = before.match(/^\/([\w: -]*)$/)
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
    const own = (c: Command) => (crew.includes(c.agent) ? 0 : 1)
    suggestions = ([
      ...builtins(setAccess, setStudio, studio, setArena, arena).filter((b) => b.key.slice(2).startsWith(q.trim())),
      ...[...commands].sort((a, b) => own(a) - own(b)).map((c) => ({ key: `c-${c.agent}-${c.name}`, label: `/${c.name}`, hint: `${c.from}${c.description ? ` · ${c.description}` : ''}`, insert: `/${c.name} `, mark: agentOf(c.agent, agents).mark })),
      ...checks.map((c) => ({ key: c.command, label: c.label, hint: c.command, insert: `!${c.command}` })),
      ...skills.map((s) => ({ key: s.id, label: s.name, hint: `Skill, ${s.steps.length} step${s.steps.length === 1 ? '' : 's'}`, insert: `${s.brief}\n\nSteps that worked last time:\n${s.steps.map((x) => `- ${x}`).join('\n')}` })),
      ...PLAYBOOKS.map((p) => ({ key: `p-${p.id}`, label: p.name, hint: `${p.field} · ${p.line}`, insert: fillPlaybook(p, '') })),
    ] as Suggestion[]).filter((s) => s.run || s.label.toLowerCase().includes(q) || s.hint.toLowerCase().includes(q)).slice(0, 10)
  }
  // Escape puts the list away until the text changes.
  if (shut === before) suggestions = []
  const pickSuggestion = (s: Suggestion) => {
    if (s.run) { s.run(); setText(''); setCaret(0); return }
    const start = mention ? caret - mention[2].length - 1 : 0
    const next = text.slice(0, start) + s.insert + text.slice(caret)
    setText(next)
    const pos = start + s.insert.length
    place.current = pos
    setCaret(pos)
  }

  // The list opens above the box, or below it when there is no room, and keeps the chosen row in view.
  // Rows without a mark keep its place when others have one, so the names line up.
  const marked = suggestions.some((x) => x.mark)
  const listing = suggestions.length
  useLayoutEffect(() => {
    if (list.current) return follow(list.current, list.current.parentElement!)
  }, [listing > 0])
  useLayoutEffect(() => { list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' }) }, [at, listing])

  const shell = text.startsWith('!')
  // Expanding a command waits on the main process; a second Enter in that moment sends nothing.
  // A message is on its way from the moment Enter is pressed until the box is empty again, so a
  // second Enter in between, which still sees the old text, sends nothing.
  const sending = useRef(false)
  useEffect(() => { sending.current = false }, [text, files])
  const submit = async () => {
    if ((!text.trim() && !files.length) || sending.current) return
    sending.current = true
    let message = text.trim() || 'Have a look at the attached files.'
    // A slash command runs in Lunchbox, or becomes the instructions it stands for; an unknown one
    // goes as typed.
    const cmd = message.match(/^\/([\w:-]+)(?:\s+([\s\S]*))?$/)
    if (cmd) {
      const b = builtins(setAccess, setStudio, studio, setArena, arena).find((x) => x.key.slice(2) === cmd[1].toLowerCase())
      if (b && !cmd[2]) { b.run!(); setText(''); setCaret(0); return }
      const matches = commands.filter((c) => c.name === cmd[1])
      const c = matches.find((x) => x.agent === crew[0]) ?? matches.find((x) => crew.includes(x.agent)) ?? matches[0]
      if (c) message = (await desk.call('commands:expand', folder, c.agent, c.name, cmd[2] ?? '', crew[0]).catch(() => null)) ?? message
    }
    onSend(message, files.length ? files : undefined)
    remember(room, text.trim())
    setPast(-1)
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
      onDrop={(e) => { setOver(false); if (e.dataTransfer.files.length) { e.preventDefault(); take(e.dataTransfer.files) } }}>
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
        <div className="suggest" role="listbox" ref={list}>
          {suggestions.map((s, i) => (
            <button key={s.key} role="option" aria-selected={i === at % suggestions.length} className={i === at % suggestions.length ? 'on' : ''}
              onMouseEnter={() => setAt(i)} onMouseDown={(e) => { e.preventDefault(); pickSuggestion(s) }}>
              {s.mark ? <Mark seed={s.mark} size={12} /> : marked && <i className="nomark" />}<b>{s.label}</b><span>{s.hint}</span>
            </button>
          ))}
        </div>
      )}
      <textarea ref={area} value={text} rows={1} autoFocus={autoFocus} spellCheck
        placeholder={placeholder ?? 'Message the room'}
        onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); setAt(0); setPast(-1) }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        // Text copied from a document or a sheet often carries a picture of itself; the words win.
        onPaste={(e) => { if (e.clipboardData.files.length && !e.clipboardData.getData('text/plain')) { e.preventDefault(); take(e.clipboardData.files) } }}
        onKeyDown={(e) => {
          if (suggestions.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); return setAt(at + 1) }
            if (e.key === 'ArrowUp') { e.preventDefault(); return setAt(at - 1 + suggestions.length) }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) { e.preventDefault(); return pickSuggestion(suggestions[at % suggestions.length]) }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopPropagation(); return setShut(before) }
          }
          // Up in an empty box brings back what was sent before; down walks forward again.
          // Inside a recalled message the arrows still move the caret; only its two ends step on.
          const el = e.currentTarget
          const recall = (to: number) => { e.preventDefault(); setPast(to); setText(to < 0 ? '' : sent[to]); setCaret(0); requestAnimationFrame(() => el.setSelectionRange(0, 0)) }
          if (e.key === 'ArrowUp' && !e.shiftKey && (past >= 0 ? el.selectionStart === 0 : !text) && past + 1 < sent.length) return recall(past + 1)
          if (e.key === 'ArrowDown' && !e.shiftKey && past >= 0 && el.selectionEnd === text.length) return recall(past - 1)
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
        }} />
      <div className="cbar">
        <Menu label="Agents in this room" button={<><span className="stack">{crew.map((w) => <span key={w}><Mark seed={agentOf(w, agents).mark} size={12} /></span>)}</span><span className="crewpill">{crew.length === 1 ? agentOf(crew[0], agents).short : `${crew.length} agents`}</span></>}>
          {(close) => (
            <CrewMenu listed={listed} crew={crew} toggle={toggle} close={close} promote={(id) => setCrew([id, ...crew.filter((w) => w !== id)])} footer={
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
                <button className="item" onClick={() => dispatchEvent(new CustomEvent('lb:go', { detail: { name: 'free' } }))}>
                  <span className="grow"><b>Free models</b><span>No key, or a free key in a minute</span></span>
                </button>
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
          <button className={`pill expert${studio ? ' open' : ''}`} onClick={() => setStudio(!studio)} aria-pressed={studio}
            title="Expert: agents set a direction, check the result in screenshots and measurements, and report what they verified. Your own design files and references come first.">
            <IconStudio />Expert
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

// What Lunchbox does itself when typed after a slash: switch mode, Expert and side by side.
function builtins(setAccess: (a: Access) => void, setStudio: ((on: boolean) => void) | undefined, studio: boolean, setArena: ((a: boolean) => void) | undefined, arena: boolean): Suggestion[] {
  const list: Suggestion[] = [
    { key: 'b-plan', label: '/plan', hint: 'Lunchbox · Plan mode: agents read and propose, nothing changes', insert: '', run: () => setAccess('plan') },
    { key: 'b-ask', label: '/ask', hint: 'Lunchbox · Ask mode: edits and commands wait for your OK', insert: '', run: () => setAccess('ask') },
    { key: 'b-auto', label: '/auto', hint: 'Lunchbox · Auto mode: agents work inside the folder', insert: '', run: () => setAccess('workspace') },
    { key: 'b-full', label: '/full', hint: 'Lunchbox · Full access to this computer', insert: '', run: () => setAccess('full') },
  ]
  if (setStudio) list.push({ key: 'b-expert', label: '/expert', hint: `Lunchbox · Turn Expert ${studio ? 'off' : 'on'}`, insert: '', run: () => setStudio(!studio) })
  if (setArena) list.push({ key: 'b-side', label: '/side', hint: `Lunchbox · Side by side ${arena ? 'off' : 'on'}: several agents answer, you keep the best`, insert: '', run: () => setArena(!arena) })
  return list
}
