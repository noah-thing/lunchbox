export type Side = 'up' | 'down'

const GAP = 6
const EDGE = 8
// Below this a list stops being usable, so a floating surface never shrinks further.
const LEAST = 96

// Which side of its anchor a floating surface opens on, and how tall it may be there. It keeps the
// side it was designed for while it fits, flips when only the other side fits, and otherwise takes
// the roomier side with its height capped so it scrolls inside.
export function side(height: number, above: number, below: number, prefer: Side): { side: Side; max: number } {
  const room = { up: above, down: below }
  const other: Side = prefer === 'up' ? 'down' : 'up'
  if (height <= room[prefer]) return { side: prefer, max: room[prefer] }
  if (height <= room[other]) return { side: other, max: room[other] }
  const best = room[other] > room[prefer] ? other : prefer
  return { side: best, max: Math.max(LEAST, room[best]) }
}

// How far to slide a surface sideways so it stays between the two edges. The left edge wins when
// the surface is wider than the gap between them.
export function shift(left: number, width: number, min: number, max: number) {
  return Math.max(min, Math.min(left, max - width)) - left
}

// The nearest box that would cut a floating surface off, or the window.
function bounds(el: HTMLElement) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (getComputedStyle(p).overflowY !== 'visible') { const r = p.getBoundingClientRect(); return { top: Math.max(0, r.top), bottom: Math.min(innerHeight, r.bottom) } }
  }
  return { top: 0, bottom: innerHeight }
}

// Fits a surface that hangs off its anchor into the window: above or below, capped in height,
// nudged sideways. Sizes come from the layout box, so an opening animation's scale does not skew
// them. `hold` keeps the current side while the content changes, so an open menu never jumps across.
export function place(el: HTMLElement, anchor: HTMLElement, { hold = false, centered = false } = {}) {
  const held = hold ? (el.dataset.side as Side | undefined) : undefined
  const scrolled = el.scrollTop
  const s = el.style
  s.maxHeight = s.overflowY = s.translate = ''
  if (!held) s.top = s.bottom = s.transformOrigin = s.animationName = ''
  const a = anchor.getBoundingClientRect()
  const edge = bounds(el)
  const room = { up: a.top - edge.top - GAP - EDGE, down: edge.bottom - a.bottom - GAP - EDGE }
  let to = held
  if (!to) {
    const natural: Side = el.offsetTop < 0 ? 'up' : 'down'
    to = side(el.offsetHeight, room.up, room.down, natural).side
    if (to !== natural) {
      const css = getComputedStyle(el)
      s.top = to === 'down' ? `calc(100% + ${GAP}px)` : 'auto'
      s.bottom = to === 'down' ? 'auto' : `calc(100% + ${GAP}px)`
      s.transformOrigin = `${css.transformOrigin.split(' ')[0]} ${to === 'down' ? 'top' : 'bottom'}`
      if (css.animationName === 'menu' || css.animationName === 'menudown') s.animationName = to === 'down' ? 'menudown' : 'menu'
    }
    el.dataset.side = to
  }
  const most = Math.max(LEAST, room[to])
  if (el.offsetHeight > most) { s.maxHeight = `${most}px`; s.overflowY = 'auto' }
  const parent = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect()
  if (parent) {
    const w = el.offsetWidth
    const dx = shift(parent.left + el.offsetLeft - (centered ? w / 2 : 0), w, EDGE, innerWidth - EDGE)
    if (dx) s.translate = `${Math.round(dx)}px 0`
  }
  if (scrolled) el.scrollTop = scrolled
}

// Keeps a placed surface fitted while it is open: the window resizing, its own content growing,
// the page scrolling under it. Returns the cleanup.
export function follow(el: HTMLElement, anchor: HTMLElement, opts: { centered?: boolean } = {}) {
  place(el, anchor, opts)
  const again = () => place(el, anchor, { ...opts, hold: true })
  const fresh = () => place(el, anchor, opts)
  const scroll = (e: Event) => { if (!el.contains(e.target as Node)) again() }
  const grown = new ResizeObserver(again)
  grown.observe(el)
  addEventListener('resize', fresh)
  addEventListener('scroll', scroll, true)
  return () => { grown.disconnect(); removeEventListener('resize', fresh); removeEventListener('scroll', scroll, true) }
}
