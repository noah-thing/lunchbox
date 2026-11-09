import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ACCESS, type Access } from '../lib/desk'
import { IconDown } from './icons'

const P = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

// Each mode drawn as what it lets the agents do: look, ask first, work in the folder, or open
// the whole machine. Only full access gets colour, because it is the one to notice.
export function ModeIcon({ id }: { id: Access }) {
  if (id === 'plan') return <svg {...P} className="modeicon"><path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z" /><circle cx="8" cy="8" r="1.9" /></svg>
  if (id === 'ask') return <svg {...P} className="modeicon"><path d="M2.75 3.25h10.5v7.25H8.5l-3 2.5v-2.5H2.75z" /><path d="M6.6 5.9a1.45 1.45 0 1 1 2.05 1.32c-.42.2-.65.5-.65.93" /><circle cx="8" cy="9.05" r=".05" strokeWidth="1.5" /></svg>
  if (id === 'workspace') return <svg {...P} className="modeicon"><path d="M2.25 4.25h4l1.25 1.5h6.25v6.5H2.25z" /><path d="M5.9 9.1l1.4 1.35 2.8-2.85" /></svg>
  return <svg {...P} className="modeicon full"><rect x="3.25" y="7.25" width="9.5" height="6.25" rx="1.25" /><path d="M5.5 7.25V5a2.5 2.5 0 0 1 4.85-.85" /><path d="M8 9.6v1.5" /></svg>
}

export function Menu({ label, button, children, className = '', bare = false }: { label: string; button: ReactNode; children: (close: () => void) => ReactNode; className?: string; bare?: boolean }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    addEventListener('pointerdown', away)
    addEventListener('keydown', esc)
    return () => { removeEventListener('pointerdown', away); removeEventListener('keydown', esc) }
  }, [open])
  return (
    <div className={`menuwrap ${className}`} ref={box}>
      <button className={`${bare ? 'iconbtn' : 'pill'}${open ? (bare ? ' on' : ' open') : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-label={label}>{button}{!bare && <IconDown />}</button>
      {open && <div className="menu" role="menu">{children(() => setOpen(false))}</div>}
    </div>
  )
}

export function ModePicker({ value, onChange }: { value: Access; onChange: (a: Access) => void }) {
  const now = ACCESS.find((a) => a.id === value)!
  return (
    <Menu label={`Mode: ${now.name}`} className={value === 'full' ? 'full' : ''} button={<><ModeIcon id={now.id} />{now.name}</>}>
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
