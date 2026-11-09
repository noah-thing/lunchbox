import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Hit } from '../../shared/types'
import { IconSearch } from '../ui/icons'
import { still } from '../ui/bits'
import { desk } from '../lib/desk'

const OPEN = 'cubic-bezier(.32,.72,0,1)'
const SHUT = 'cubic-bezier(.4,0,.2,1)'

// The Search button becomes the search field. The panel is laid out at its final size and only
// revealed: a rounded clip grows from the button's rectangle while the panel travels from the
// button to its place, so nothing is ever stretched and the icon moves with the field. The rows
// follow on the same clock. Transform, clip and opacity only.
function morph(box: HTMLElement, clip: HTMLElement, glow: HTMLElement, rows: HTMLElement, from: DOMRect | undefined, back: boolean) {
  if (!from || still()) return Promise.resolve()
  const to = clip.getBoundingClientRect()
  const dx = from.left - to.left, dy = from.top - to.top
  const small = { transform: `translate(${dx}px, ${dy}px)`, clipPath: `inset(0px ${to.width - from.width}px ${to.height - from.height}px 0px round 6px)` }
  const large = { transform: 'translate(0px, 0px)', clipPath: `inset(0px 0px 0px 0px round ${getComputedStyle(clip).borderTopLeftRadius})` }
  const time = back ? 240 : 440
  const runs = [
    box.animate([{ transform: small.transform }, { transform: large.transform }], { duration: time, easing: back ? SHUT : OPEN, fill: 'both', direction: back ? 'reverse' : 'normal' }),
    clip.animate([{ clipPath: small.clipPath }, { clipPath: large.clipPath }], { duration: time, easing: back ? SHUT : OPEN, fill: 'both', direction: back ? 'reverse' : 'normal' }),
    glow.animate([{ opacity: 0 }, { opacity: 1 }], { duration: back ? 140 : 360, delay: back ? 0 : 120, easing: 'linear', fill: 'both', direction: back ? 'reverse' : 'normal' }),
  ]
  const kids = [...rows.children].slice(0, 12) as HTMLElement[]
  kids.forEach((el, i) => runs.push(el.animate(
    back ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
    { duration: back ? 90 : 280, delay: back ? 0 : 110 + i * 18, easing: 'cubic-bezier(.23,1,.32,1)', fill: 'both' },
  )))
  return Promise.all(runs.map((r) => r.finished)).then(() => {})
}

export type Command = { label: string; hint: string; group: 'Rooms' | 'Go to' | 'Actions' | 'Skills' | 'Flows'; run: () => void }
type Item = { key: string; label: string; hint: string; group: string; run: () => void }

const GROUPS = ['Rooms', 'Messages', 'Skills', 'Go to', 'Actions']

export function Palette({ commands, close, openHit, anchor }: { commands: Command[]; close: () => void; openHit: (h: Hit) => void; anchor?: RefObject<HTMLElement | null> }) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const [hits, setHits] = useState<Hit[]>([])
  const [leaving, setLeaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const clip = useRef<HTMLDivElement>(null)
  const glow = useRef<HTMLElement>(null)
  const from = () => anchor?.current?.getBoundingClientRect()
  const parts = () => [box.current!, clip.current!, glow.current!, list.current!] as const
  const dismiss = () => {
    if (leaving) return
    setLeaving(true)
    morph(...parts(), from(), true).then(close, close)
  }

  // While the field is out, the button it came from is empty.
  useLayoutEffect(() => {
    const button = anchor?.current
    if (button) button.style.opacity = '0'
    morph(...parts(), from(), false).catch(() => {})
    return () => { if (button) button.style.opacity = '' }
  }, [])
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
    <div className={`scrim${leaving ? ' leaving' : ''}`} onPointerDown={(e) => { if (e.target === e.currentTarget) dismiss() }}>
      <div className="palette" role="dialog" aria-label="Search" ref={box}>
        <i className="pglow" ref={glow} aria-hidden="true" />
        <div className="pbody" ref={clip}>
        <div className="pinput">
          <IconSearch />
          <input ref={input} value={q} placeholder="Search rooms, messages and actions" onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setAt(sel + 1) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setAt(sel - 1) }
              if (e.key === 'Enter' && ordered[sel]) pick(ordered[sel])
              if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) { e.preventDefault(); dismiss() }
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
    </div>
  )
}
