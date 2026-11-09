import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentInfo } from '../../shared/types'
import { Mark } from './bits'
import { IconBack, IconChevron } from './icons'
import { desk, reload, unavailable, useApp } from '../lib/desk'

// Model ids as people say them: claude-fable-5-2 is Fable 5.2, gpt-6-sol is GPT-6 Sol.
export function modelName(id: string) {
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)
  const claude = id.match(/^claude-([a-z]+)-(\d+)-(\d+)/)
  if (claude) return `${cap(claude[1])} ${claude[2]}.${claude[3]}`
  if (/^(fable|opus|sonnet|haiku)$/.test(id)) return `${cap(id)}, newest`
  const gpt = id.match(/^gpt-([\d.]+)(?:-(.+))?$/)
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ' ' + gpt[2].split('-').map(cap).join(' ') : ''}`
  if (/^auto-gemini-/.test(id)) return `Gemini ${id.slice(12)}, auto`
  if (/^(gemini|grok|gemma)-/.test(id)) return id.split('-').map((w, i) => (i === 0 || /^[a-z]/.test(w) ? cap(w) : w)).join(' ')
  return id
}

const lists = new Map<string, Promise<string[]>>()
function listOf(a: AgentInfo) {
  if (!lists.has(a.id)) lists.set(a.id, desk.call('agents:models', a.id).then((r: unknown) => (Array.isArray(r) ? (r as string[]) : [])).catch(() => []))
  return lists.get(a.id)!
}

// The crew menu: who is in the room, and beside each one the model it uses. The model opens that
// agent's list in place; picking one slides back. The same setting as on the Agents page.
// The first in the crew is the main agent; Make main moves another one to the front.
export function CrewMenu({ listed, crew, toggle, promote, footer }: { listed: AgentInfo[]; crew: string[]; toggle: (id: string) => void; promote: (id: string) => void; footer: ReactNode }) {
  const models = useApp((s) => s.settings.models)
  const [at, setAt] = useState<AgentInfo | null>(null)
  const [came, setCame] = useState(false)
  const open = (a: AgentInfo) => { setCame(true); setAt(a) }
  const back = () => setAt(null)
  return (
    <Fit>
      {at ? (
        <div key={at.id} className="slide in"><Choices a={at} value={models[at.id] ?? ''} back={back} /></div>
      ) : (
        <div key="crew" className={`slide${came ? ' returning' : ''}`}>
          {listed.map((a) => {
            const on = crew.includes(a.id)
            const why = unavailable(a)
            return (
              <div key={a.id} className={`crewrow${on ? ' checked' : ''}${why ? ' off' : ''}`}>
                <button className={`item${on ? ' checked' : ''}`} role="menuitemcheckbox" aria-checked={on} onClick={() => toggle(a.id)}>
                  <Mark seed={a.mark} size={14} />
                  <span className="grow"><b className="crewname"><span>{a.name}</span>{on && crew.length > 1 && (crew[0] === a.id
                    ? <em className="maintag">Main</em>
                    : !why && <em className="maintag make" role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); promote(a.id) }} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); promote(a.id) } }}>Make main</em>)}</b><span>{why ?? a.good}</span></span>
                  <i className="check" />
                </button>
                {on && !why && (
                  <button className="modelchip" onClick={() => open(a)} title={`Model for ${a.short}`}>
                    {models[a.id] ? modelName(models[a.id]) : 'Default model'}<IconChevron />
                  </button>
                )}
              </div>
            )
          })}
          {footer}
        </div>
      )}
    </Fit>
  )
}

// Animates its height to whatever it holds, so the menu grows and shrinks instead of jumping.
function Fit({ children }: { children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null)
  const [h, setH] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    const el = inner.current!
    const ro = new ResizeObserver(() => setH(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return <div className="fit" style={{ height: h }}><div ref={inner}>{children}</div></div>
}

function Choices({ a, value, back }: { a: AgentInfo; value: string; back: () => void }) {
  const models = useApp((s) => s.settings.models)
  const [list, setList] = useState<string[] | null>(null)
  const [find, setFind] = useState('')
  const [other, setOther] = useState(false)
  useEffect(() => { let on = true; listOf(a).then((l) => on && setList(l)); return () => { on = false } }, [a])
  const pick = (m: string) => { reload.settings({ models: { ...models, [a.id]: m } }); back() }
  const shown = (list ?? []).filter((m) => !find || m.toLowerCase().includes(find.toLowerCase()) || modelName(m).toLowerCase().includes(find.toLowerCase()))
  const fallback = a.via === 'cli' ? 'as set up in the tool' : a.model ? `now ${modelName(a.model)}` : 'picked for you'
  const row = (m: string) => (
    <button key={m} role="menuitemradio" aria-checked={value === m} className={`item modelrow${value === m ? ' on' : ''}`} onClick={() => pick(m)}>
      <span className="grow">{modelName(m)}</span>{modelName(m) !== m && <code>{m}</code>}
    </button>
  )
  return (
    <div className="modelset">
      <button className="modelhead" onClick={back}><IconBack /><Mark seed={a.mark} size={12} /><b>{a.short}</b><span>model</span></button>
      {(list?.length ?? 0) > 12 && <input className="modelfind" placeholder={`Find among ${list!.length}`} value={find} onChange={(e) => setFind(e.target.value)} autoFocus />}
      <div className="modellist">
        <button role="menuitemradio" aria-checked={!value} className={`item modelrow${!value ? ' on' : ''}`} onClick={() => pick('')}>
          <span className="grow">Default</span><span className="now">{fallback}</span>
        </button>
        {list === null && <div className="menunote">Looking up models</div>}
        {shown.slice(0, 80).map(row)}
        {value && list && !list.includes(value) && row(value)}
      </div>
      {other ? (
        <input className="modelfind" autoFocus placeholder="Model id, then Enter" onKeyDown={(e) => { const v = e.currentTarget.value.trim(); if (e.key === 'Enter' && v) pick(v) }} />
      ) : (
        <button className="item modelrow quiet" onClick={() => setOther(true)}><span className="grow">Another model by name</span></button>
      )}
    </div>
  )
}
