import { useEffect, useRef, useState } from 'react'
import type { Hit } from '../../shared/types'
import { IconSearch } from '../ui/icons'
import { desk } from '../lib/desk'

export type Command = { label: string; hint: string; group: 'Rooms' | 'Go to' | 'Actions' | 'Skills'; run: () => void }
type Item = { key: string; label: string; hint: string; group: string; run: () => void }

const GROUPS = ['Rooms', 'Messages', 'Skills', 'Go to', 'Actions']

export function Palette({ commands, close, openHit }: { commands: Command[]; close: () => void; openHit: (h: Hit) => void }) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const [hits, setHits] = useState<Hit[]>([])
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => {
    if (q.trim().length < 2) return setHits([])
    const t = setTimeout(() => desk.call('search', q).then((h: Hit[]) => setHits(h.filter((x) => x.event))), 120)
    return () => clearTimeout(t)
  }, [q])

  const needle = q.trim().toLowerCase()
  const match = (s: string) => !needle || needle.split(/\s+/).every((w) => s.toLowerCase().includes(w))
  const items: Item[] = [
    ...commands.filter((c) => match(`${c.label} ${c.hint}`)).map((c, i) => ({ key: `c${i}`, label: c.label, hint: c.hint, group: c.group, run: c.run })),
    ...hits.slice(0, 8).map((h) => ({ key: `h${h.event}`, label: h.text, hint: h.roomName, group: 'Messages', run: () => openHit(h) })),
  ]
  const shown = needle ? items : items.filter((i) => i.group !== 'Rooms' || items.filter((x) => x.group === 'Rooms').indexOf(i) < 6)
  const ordered = GROUPS.flatMap((g) => shown.filter((i) => i.group === g))
  const sel = ordered.length ? ((at % ordered.length) + ordered.length) % ordered.length : 0

  useEffect(() => setAt(0), [q])
  useEffect(() => { list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' }) }, [sel])

  const pick = (i: Item) => { close(); i.run() }
  let group = ''
  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div className="palette" role="dialog" aria-label="Search">
        <div className="pinput">
          <IconSearch />
          <input ref={input} value={q} placeholder="Search rooms, messages and actions" onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setAt(sel + 1) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setAt(sel - 1) }
              if (e.key === 'Enter' && ordered[sel]) pick(ordered[sel])
              if (e.key === 'Escape') close()
            }} />
          <kbd>esc</kbd>
        </div>
        <div className="plist" ref={list}>
          {ordered.map((c, i) => {
            const head = c.group !== group ? <div className="pgroup" key={`g${c.group}`}>{c.group}</div> : null
            group = c.group
            return [
              head,
              <button key={c.key} className={`${i === sel ? 'on' : ''}${c.group === 'Messages' ? ' hit' : ''}`} onMouseMove={() => i !== sel && setAt(i)} onClick={() => pick(c)}>
                <span>{c.label}</span><small>{c.hint}</small>
              </button>,
            ]
          })}
          {!ordered.length && <div className="empty">{needle.length >= 2 ? `Nothing matches “${q.trim()}”` : 'Type to search'}</div>}
        </div>
      </div>
    </div>
  )
}
