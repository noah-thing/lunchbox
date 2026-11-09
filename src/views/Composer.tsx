import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Mark } from '../ui/bits'
import { Menu, ModePicker } from '../ui/Access'
import { IconSplit, IconStop, IconUp } from '../ui/icons'
import { agentOf, machine, unavailable, useApp, type Access } from '../lib/desk'

type Suggestion = { key: string; label: string; hint: string; insert: string; mark?: string }

export function Composer({ crew, setCrew, onSend, access, setAccess, busy = false, onStop, arena = false, setArena, draft, autoFocus = true, placeholder, pack }: {
  crew: string[]; setCrew: (c: string[]) => void; onSend: (t: string) => void; access: Access; setAccess: (a: Access) => void
  busy?: boolean; onStop?: () => void; arena?: boolean; setArena?: (a: boolean) => void; draft?: { text: string; n: number }; autoFocus?: boolean; placeholder?: string; pack?: string
}) {
  const [text, setText] = useState('')
  const [at, setAt] = useState(0)
  const [caret, setCaret] = useState(0)
  const area = useRef<HTMLTextAreaElement>(null)
  const agents = useApp((s) => s.agents)
  const skills = useApp((s) => s.skills)
  const packs = useApp((s) => s.packs)
  useApp((s) => s.ledger)

  useEffect(() => {
    if (!draft) return
    setText(draft.text)
    requestAnimationFrame(() => { area.current?.focus(); area.current?.setSelectionRange(draft.text.length, draft.text.length) })
  }, [draft])
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 240) + 'px'
  }, [text])
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
  if (mention && crew.length > 1) {
    const q = mention[2].toLowerCase()
    suggestions = crew.map((id) => agentOf(id, agents)).filter((a) => a.id.startsWith(q) || a.short.toLowerCase().startsWith(q))
      .map((a) => ({ key: a.id, label: a.short, hint: a.good, insert: `@${a.id} `, mark: a.mark }))
  } else if (slash) {
    const q = slash[1].toLowerCase()
    const checks = packs.find((p) => p.id === pack)?.checks ?? []
    suggestions = [
      ...skills.map((s) => ({ key: s.id, label: s.name, hint: `Skill, ${s.steps.length} steps`, insert: `${s.brief}\n\nSteps that worked last time:\n${s.steps.map((x) => `- ${x}`).join('\n')}` })),
      ...checks.map((c) => ({ key: c.command, label: c.label, hint: c.command, insert: `!${c.command}` })),
    ].filter((s) => s.label.toLowerCase().includes(q)).slice(0, 7)
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
    if (!text.trim()) return
    onSend(text.trim())
    setText('')
    setCaret(0)
  }
  const ready = crew.filter((id) => !unavailable(agentOf(id, agents)))
  const toggle = (id: string) => setCrew(crew.includes(id) ? (crew.length > 1 ? crew.filter((w) => w !== id) : crew) : [...crew, id])
  const listed = [...agents].filter((a) => a.found || crew.includes(a.id)).sort((a, b) => Number(!!unavailable(a)) - Number(!!unavailable(b)))

  return (
    <div className={`composer${shell ? ' shell' : ''}${arena ? ' arena' : ''}`}>
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
            <>
              {listed.map((a) => {
                const on = crew.includes(a.id)
                const why = unavailable(a)
                return (
                  <button key={a.id} className={`item${on ? ' checked' : ''}${why ? ' off' : ''}`} role="menuitemcheckbox" aria-checked={on} onClick={() => toggle(a.id)}>
                    <Mark seed={a.mark} size={14} />
                    <span className="grow"><b>{a.name}</b><span>{why ?? a.good}</span></span>
                    <i className="check" />
                  </button>
                )
              })}
              {!listed.length && <div className="menunote">No agents found. Install one, or add an API key in Agents.</div>}
            </>
          )}
        </Menu>
        {setArena && crew.length > 1 && !shell && (
          <button className={`pill${arena ? ' open' : ''}`} onClick={() => setArena(!arena)} aria-pressed={arena} title="Everyone answers on their own, you keep the best">
            <IconSplit />Side by side
          </button>
        )}
        {shell && <span className="shellnote">Runs on {machine()}</span>}
        {!shell && ready.length < crew.length && <span className="shellnote">{crew.length - ready.length} unavailable</span>}
        <span className="spacer" />
        <ModePicker value={access} onChange={setAccess} />
        {busy && !text.trim() && onStop
          ? <button className="send stop" onClick={onStop} aria-label="Stop" title="Stop (Esc)"><IconStop /></button>
          : <button className="send" disabled={!text.trim()} onClick={submit} aria-label="Send"><IconUp /></button>}
      </div>
    </div>
  )
}
