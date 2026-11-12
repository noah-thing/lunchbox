import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ACCESS, type Access } from '../lib/desk'
import { IconDown } from './icons'
import { follow } from '../lib/fit'

const P = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

// Each mode drawn as what it lets the agents do: look, ask first, work in the folder, or open
// the whole machine. Only full access gets colour, because it is the one to notice.
export function ModeIcon({ id }: { id: Access }) {
  if (id === 'plan') return <svg {...P} className="modeicon"><path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z" /><circle cx="8" cy="8" r="1.9" /></svg>
  if (id === 'ask') return <svg {...P} className="modeicon"><path d="M2.75 3.25h10.5v7.25H8.5l-3 2.5v-2.5H2.75z" /><path d="M6.6 5.9a1.45 1.45 0 1 1 2.05 1.32c-.42.2-.65.5-.65.93" /><circle cx="8" cy="9.05" r=".05" strokeWidth="1.5" /></svg>
  if (id === 'workspace') return <svg {...P} className="modeicon"><path d="M2.25 4.25h4l1.25 1.5h6.25v6.5H2.25z" /><path d="M5.9 9.1l1.4 1.35 2.8-2.85" /></svg>
  return <svg {...P} className="modeicon full"><rect x="3.25" y="7.25" width="9.5" height="6.25" rx="1.25" /><path d="M5.5 7.25V5a2.5 2.5 0 0 1 4.85-.85" /><path d="M8 9.6v1.5" /></svg>
}

// Arrow keys, Home and End walk the buttons of an open menu. Typing in a field inside it is left alone.
export function rove(e: { key: string; target: EventTarget | null; preventDefault(): void }, menu: HTMLElement | null | undefined) {
  if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || (e.target as HTMLElement)?.matches?.('input, textarea')) return
  const items = [...menu.querySelectorAll<HTMLElement>('button:not(:disabled), [role=button][tabindex]')]
  if (!items.length) return
  e.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLElement)
  const step = e.key === 'ArrowDown' ? 1 : -1
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length
  items[next].focus()
}

export function Menu({ label, button, children, className = '', bare = false }: { label: string; button: ReactNode; children: (close: () => void) => ReactNode; className?: string; bare?: boolean }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  // Closing from inside the menu hands focus back to the button, so the keyboard stays in place.
  // It runs before any state update, so a field the chosen item opens can still take focus after.
  const close = () => {
    const at = document.activeElement
    if (at === document.body || box.current?.contains(at)) trigger.current?.focus()
    setOpen(false)
  }
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    // Capture, so the menu hears Escape before the room does and the room can tell it was used.
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as Element)?.closest?.('[role=dialog]')) { e.preventDefault(); e.stopPropagation(); close() } }
    addEventListener('pointerdown', away)
    addEventListener('keydown', esc, true)
    return () => { removeEventListener('pointerdown', away); removeEventListener('keydown', esc, true) }
  }, [open])
  // The menu stays inside the window: it flips to the side with room, and scrolls when neither has enough.
  useLayoutEffect(() => {
    const menu = open && box.current?.querySelector<HTMLElement>('.menu')
    if (menu && trigger.current) return follow(menu, trigger.current)
  }, [open])
  return (
    <div className={`menuwrap ${className}`} ref={box}
      onKeyDown={(e) => { if (open) rove(e, box.current?.querySelector<HTMLElement>('.menu')) }}
      onBlur={(e) => { if (open && e.relatedTarget && !box.current?.contains(e.relatedTarget as Node)) setOpen(false) }}>
      <button ref={trigger} className={`${bare ? 'iconbtn' : 'pill'}${open ? (bare ? ' on' : ' open') : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" aria-label={label}>{button}{!bare && <IconDown />}</button>
      {open && <div className="menu" role="menu">{children(close)}</div>}
    </div>
  )
}

export function ModePicker({ value, onChange }: { value: Access; onChange: (a: Access) => void }) {
  const now = ACCESS.find((a) => a.id === value)!
  return (
    <Menu label={`Mode: ${now.name}`} className={value === 'full' ? 'full' : ''} button={<><ModeIcon id={now.id} /><span className="pilltext">{now.name}</span></>}>
      {(close) => (
        <>
          {ACCESS.map((a) => (
            <button key={a.id} role="menuitemradio" aria-checked={a.id === value} className={`item${a.id === value ? ' on' : ''}`} onClick={() => { onChange(a.id); close() }}>
              <ModeIcon id={a.id} />
              <span className="grow"><b>{a.name}</b><span>{a.line}</span></span>
            </button>
          ))}
        </>
      )}
    </Menu>
  )
}
