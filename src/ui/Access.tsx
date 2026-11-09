import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ACCESS, type Access } from '../lib/desk'
import { IconDown } from './icons'

// Three cells of trust. Only full access gets colour, because it is the one to notice.
export function Ladder({ level }: { level: number }) {
  return (
    <span className={`ladder l${level}`} aria-hidden="true">
      {[1, 2, 3].map((i) => <i key={i} className={i <= level ? 'on' : ''} />)}
    </span>
  )
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
    <Menu label={`Mode: ${now.name}`} className={value === 'full' ? 'full' : ''} button={<><Ladder level={now.level} />{now.name}</>}>
      {(close) => (
        <>
          {ACCESS.map((a) => (
            <button key={a.id} role="menuitemradio" aria-checked={a.id === value} className={`item${a.id === value ? ' on' : ''}`} onClick={() => { onChange(a.id); close() }}>
              <Ladder level={a.level} />
              <span className="grow"><b>{a.name}</b><span>{a.line}</span></span>
            </button>
          ))}
        </>
      )}
    </Menu>
  )
}
