import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { dots, glyph } from './glyphs'

export const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches

// Each agent's mark is drawn by hand on a 7 by 7 dot grid, and says what the agent is for:
// Claude's burst, Codex's prompt, Grok's X, Gemini's four-point star, the local model's closed ring.
const MARKS: Record<string, string[]> = {
  claude: ['...#...', '.#.#.#.', '..###..', '###.###', '..###..', '.#.#.#.', '...#...'],
  codex: ['.......', '.#.....', '..#....', '...#...', '..#....', '.#.###.', '.......'],
  grok: ['#.....#', '.#...#.', '..#.#..', '...#...', '..#.#..', '.#...#.', '#.....#'],
  gemini: ['...#...', '...#...', '..###..', '#######', '..###..', '...#...', '...#...'],
  local: ['..###..', '.#...#.', '#.....#', '#..#..#', '#.....#', '.#...#.', '..###..'],
  lunchbox: ['#######', '#######', '#.....#', '#..#..#', '#.....#', '#.....#', '#######'],
}

// Any other tool gets its initial from the same dot font as the wordmark.
function cells(seed: string) {
  const drawn = MARKS[seed]
  if (drawn) return drawn.flatMap((row, y) => [...row].flatMap((ch, x) => (ch === '#' ? [[x, y]] : [])))
  return glyph(seed[0] ?? '?').flatMap((bits, y) => Array.from({ length: 5 }, (_, x) => ((bits >> (4 - x)) & 1 ? [[x + 1, y]] : [])).flat())
}

import { BRANDS } from './brands'
const ALIAS: Record<string, string> = { local: 'ollama' }

export function Mark({ seed, size = 16, blink = 0, active = false }: { seed: string; size?: number; blink?: number; active?: boolean }) {
  const brand = BRANDS[ALIAS[seed] ?? seed]
  if (brand) return (
    <svg key={blink} className={`mark brand${blink ? ' blink' : ''}${active ? ' active' : ''}`} width={size} height={size} viewBox="0 0 24 24" fillRule="evenodd" aria-hidden="true">
      {brand.map((d, i) => <path key={i} d={d} />)}
    </svg>
  )
  const on = useMemo(() => cells(seed), [seed])
  const grid = size >= 20
  return (
    <svg key={blink} className={`mark${blink ? ' blink' : ''}${active ? ' active' : ''}`} width={size} height={size} viewBox="0 0 7 7" aria-hidden="true">
      {grid && Array.from({ length: 49 }, (_, i) => <circle key={'g' + i} className="off" cx={(i % 7) + 0.5} cy={Math.floor(i / 7) + 0.5} r=".3" />)}
      {on.map(([x, y], i) => (
        <circle key={i} className="on" cx={x + 0.5} cy={y + 0.5} r=".42" style={{ '--d': `${(Math.abs(x - 3) + Math.abs(y - 3)) * 70}ms` } as CSSProperties} />
      ))}
    </svg>
  )
}

export function Loader({ size = 14 }: { size?: number }) {
  return (
    <svg className="loader" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Working">
      {Array.from({ length: 25 }, (_, i) => {
        const x = i % 5, y = Math.floor(i / 5)
        return <rect key={i} x={x * 5} y={y * 5} width="4" height="4" rx=".7" style={{ animationDelay: `${(Math.abs(x - 2) + Math.abs(y - 2)) * 90}ms` }} />
      })}
    </svg>
  )
}

// Each cell is a share of what is left, so the picture is the number.
export function Meter({ value, cells = 20, tone }: { value: number; cells?: number; tone?: 'warn' | 'bad' }) {
  const lit = Math.round(value * cells)
  return (
    <span className={`meter${tone ? ' ' + tone : ''}`} role="img" aria-label={`${Math.round(value * 100)} percent left`}>
      {Array.from({ length: cells }, (_, i) => <i key={i} className={i < lit ? 'on' : ''} style={{ '--i': i } as CSSProperties} />)}
    </span>
  )
}

// Text drawn in our own dot matrix. Dots arrive column by column when it first appears.
export function Matrix({ text, dot = 4, gap = 2, animate = true, className = '' }: { text: string; dot?: number; gap?: number; animate?: boolean; className?: string }) {
  const m = useMemo(() => dots(text), [text])
  const step = dot + gap
  return (
    <svg className={`matrix ${animate ? 'in' : ''} ${className}`} width={m.width * step - gap} height={m.height * step - gap} role="img" aria-label={text}>
      {m.dots.map(([x, y], i) => (
        <rect key={i} x={x * step} y={y * step} width={dot} height={dot} rx={dot * 0.18} style={{ '--d': `${x * 14 + y * 6}ms` } as CSSProperties} />
      ))}
    </svg>
  )
}

// One shared clock for every small live strip, so twenty of them cost one frame callback.
const strips = new Set<() => void>()
let clock = 0
function tickStrips() {
  let last = 0
  const frame = (now: number) => {
    clock = requestAnimationFrame(frame)
    if (now - last < 80) return
    last = now
    strips.forEach((f) => f())
  }
  clock = requestAnimationFrame(frame)
}

// A line of an agent's own alphabet, drifting. Used wherever an agent is working.
export function Strip({ alphabet, length = 18, calm = false }: { alphabet: string; length?: number; calm?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const ramp = ' ' + alphabet
    const seed = Math.random() * 10
    const draw = () => {
      const now = performance.now() / (calm ? 900 : 380)
      let line = ''
      for (let i = 0; i < length; i++) {
        const v = Math.sin(i * 0.6 + now + seed) + Math.sin(i * 0.23 - now * 0.7)
        line += ramp[Math.max(0, Math.min(ramp.length - 1, Math.floor(((v + 2) / 4) * ramp.length)))]
      }
      if (ref.current) ref.current.textContent = line
    }
    draw()
    if (still()) return
    strips.add(draw)
    if (strips.size === 1) tickStrips()
    return () => { strips.delete(draw); if (!strips.size) cancelAnimationFrame(clock) }
  }, [alphabet, length, calm])
  return <span ref={ref} className="strip" aria-hidden="true" />
}

const NOISE = '#%*+=-:.'

// Settles out of characters, left to right, once. For headings that matter, never for body text.
export function Resolve({ text, speed = 28, delay = 0 }: { text: string; speed?: number; delay?: number }) {
  const [shown, setShown] = useState(still() ? text : '')
  useEffect(() => {
    if (still()) return setShown(text)
    let raf = 0
    const t0 = performance.now() + delay
    const frame = (now: number) => {
      const k = Math.max(0, (now - t0) / speed)
      const settled = Math.floor(k / 2)
      let out = text.slice(0, settled)
      for (let i = settled; i < Math.min(text.length, settled + 6); i++) out += text[i] === ' ' ? ' ' : NOISE[(i * 7 + Math.floor(now / 40)) % NOISE.length]
      setShown(out)
      if (settled < text.length) raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [text, speed, delay])
  return <span className="resolve" aria-label={text}><span aria-hidden="true">{shown}</span><span className="ghost" aria-hidden="true">{text.slice(shown.length)}</span></span>
}

// A small preview of a file on disk: the image itself when it is one, its extension otherwise.
export function Thumb({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const image = /\.(png|jpe?g|gif|webp)$/i.test(path)
  useEffect(() => {
    if (!image || !window.lb) return
    let alive = true
    window.lb.call('file:image', path).then((url: string | null) => { if (alive && url) setSrc(url) })
    return () => { alive = false }
  }, [path, image])
  return src ? <img className="thumb" src={src} alt="" /> : <i className="thumb">{path.split('.').pop()?.slice(0, 4) || 'file'}</i>
}
