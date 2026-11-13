// Keeps the end of a conversation steady while it grows.
//
// When a line wraps or a block arrives, everything under it is pushed down in one frame, and the
// view then has to catch up. Here the pushed rows stay where they were and travel to their new
// place at the same rate the view scrolls, so at the bottom of a room the working line stands
// still and the text above it rises. What grew is uncovered at that same rate from under the row
// it pushed, so the two never overlap.
//
// Only translate and clip-path are written, once per frame, and only while something is moving.

type Spot = { top: number; off: number }

const ROWS = 14
const RATE = 96
const NESTS = '.workpair, .exchange'

// The room panel opening or closing changes the column's width once. Rows then travel to where
// the new width puts them; a window being dragged wider reflows every frame and takes its places.
let toggled = 0
export const reflow = () => { toggled = performance.now() + 400 }
export const reflowing = () => performance.now() < toggled

export type Glide = { sync(): void; wake(): void; stop(): void }

export function glide(box: HTMLElement, column: HTMLElement, o: { stuck(): boolean; busy(): boolean; scrolled(top: number): void }): Glide {
  const spots = new WeakMap<HTMLElement, Spot>()
  const moving = new Set<HTMLElement>()
  const veiled = new Set<HTMLElement>()
  const still = matchMedia('(prefers-reduced-motion: reduce)')
  // A room that has just opened, or reflowed to a new width, takes its places without travelling.
  let calm = performance.now() + 300
  let width = column.offsetWidth
  let raf = 0
  let last = 0
  let idle = 0

  const place = (el: HTMLElement, rebase: boolean) => {
    const top = el.offsetTop
    const s = spots.get(el)
    if (!s) { spots.set(el, { top, off: 0 }); return }
    const d = top - s.top
    s.top = top
    if (rebase) s.off = 0
    else if (Math.abs(d) > 1 && Math.abs(d) < 2400) { s.off -= d; moving.add(el) }
  }

  // The last rows of the room; the empty marker that ends the column is not one of them.
  const rows = () => {
    const all = column.children
    return (Array.prototype.slice.call(all, Math.max(0, all.length - ROWS)) as HTMLElement[]).filter((el) => !el.classList.contains('tail'))
  }

  const measure = () => {
    const w = column.offsetWidth
    const rebase = (w !== width && !reflowing()) || still.matches || performance.now() < calm
    width = w
    for (const row of rows()) {
      place(row, rebase)
      const body = row.classList.contains('ev') ? row.lastElementChild : null
      if (!body) continue
      for (const unit of body.children as HTMLCollectionOf<HTMLElement>) {
        place(unit, rebase)
        if (unit.matches(NESTS)) for (const part of unit.children as HTMLCollectionOf<HTMLElement>) place(part, rebase)
      }
    }
    if (rebase) { for (const el of moving) el.style.translate = ''; moving.clear(); unveil() }
  }

  const unveil = () => { for (const el of veiled) el.style.clipPath = ''; veiled.clear() }

  const paint = () => {
    const covered = new Set<HTMLElement>()
    for (const el of moving) {
      const s = spots.get(el)!
      if (!el.isConnected || Math.abs(s.off) < 0.5) { s.off = 0; el.style.translate = ''; moving.delete(el); continue }
      el.style.translate = `0 ${s.off.toFixed(2)}px`
      // The row above shows only as far as this one has moved out of its way.
      const above = el.previousElementSibling as HTMLElement | null
      const a = above && spots.get(above)
      const over = a ? a.off - s.off : 0
      if (above && over > 0.5) { above.style.clipPath = `inset(0 0 ${over.toFixed(2)}px 0)`; covered.add(above) }
    }
    for (const el of veiled) if (!covered.has(el)) { el.style.clipPath = ''; veiled.delete(el) }
    for (const el of covered) veiled.add(el)
  }

  const tick = (now: number) => {
    const dt = Math.min(50, now - (last || now - 16))
    last = now
    measure()
    const k = 1 - Math.exp(-dt / RATE)
    for (const el of moving) {
      const s = spots.get(el)!
      const size = Math.abs(s.off)
      s.off -= Math.sign(s.off) * Math.min(size, Math.max(1, size * k))
    }
    paint()
    let gap = 0
    if (o.stuck()) {
      gap = box.scrollHeight - box.clientHeight - box.scrollTop
      if (gap > 0.5) { box.scrollTop += still.matches ? gap : Math.min(gap, Math.max(1, gap * k)); o.scrolled(box.scrollTop) }
    }
    idle = moving.size || gap > 0.5 || o.busy() ? 0 : idle + dt
    raf = idle > 1200 ? 0 : requestAnimationFrame(tick)
  }

  const wake = () => { idle = 0; if (!raf) { last = 0; raf = requestAnimationFrame(tick) } }

  // Sizes change after layout and before paint, which is when the pushed rows have to be put
  // back; waiting for the next frame would show the push for one frame first.
  const watched = new Set<Element>()
  const ro = new ResizeObserver(() => { measure(); paint(); wake() })
  const sync = () => {
    const now = new Set<Element>([column, ...rows()])
    for (const el of watched) if (!now.has(el)) { ro.unobserve(el); watched.delete(el) }
    for (const el of now) if (!watched.has(el)) { ro.observe(el); watched.add(el) }
  }
  sync()
  wake()

  return {
    sync, wake,
    stop() {
      cancelAnimationFrame(raf)
      ro.disconnect()
      for (const el of moving) el.style.translate = ''
      unveil()
    },
  }
}
