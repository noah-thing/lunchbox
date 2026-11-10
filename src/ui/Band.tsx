import { useEffect, useRef } from 'react'
import { still } from './bits'
import { dots } from './glyphs'
import { glyph, nextPattern, PATTERNS } from './patterns'

// A band of code characters with a label in a cut-out in the middle. By default characters come in
// runs (0000 |||| \\\\ ---- llll !!!! ****) that drift into each other under a passing light. With
// `patterned` it draws one of several slow patterns instead (ripples, tides, a weave, a vortex,
// dunes, a moiré, a current, the crew gathering), a different one each visit, faint where a pattern
// is quiet so the band never shows holes. With `word` set the band spells it out of its own
// characters, the rest of the band dimmed.

const FAMILIES = ['0', '|', '\\', '-', 'l', '!', '*', '^', '~', ':', 'i', '/']
const LH = 16
// Brightness is drawn in steps: each row becomes one string per step, so a frame is a few dozen
// fillText calls instead of one per character. Monospace keeps the spaced strings in register.
const STEPS = 8

const hash = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return s - Math.floor(s)
}
function noise(x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y)
  const xf = x - xi, yf = y - yi
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf)
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

export function Band({ rows = 9, label = '', word, busy = false, patterned = false, className = '' }: { rows?: number; label?: string; word?: string; busy?: boolean; patterned?: boolean; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const props = useRef({ label, word, busy })
  props.current = { label, word, busy }

  useEffect(() => {
    let pattern: ((c: number, r: number, t: number, cols: number, rows: number) => number) | null = null
    if (patterned) {
      let last: string | null = null
      try { last = localStorage.getItem('lb.band') } catch {}
      const name = nextPattern(last)
      try { localStorage.setItem('lb.band', name) } catch {}
      pattern = PATTERNS[name]
    }
    const el = canvas.current!
    const ctx = el.getContext('2d')!
    const dpr = Math.min(2, devicePixelRatio || 1)
    let w = 0, cw = 7.2, raf = 0, drawn = 0, clock = 0, prev = performance.now()
    let ink = '#f0eee8'
    let shownWord = props.current.word, wordAt = performance.now() / 1000 + 0.3, wordK = 0
    let shownLabel = props.current.label, labelAt = 0
    const h = rows * LH

    const size = () => {
      w = el.getBoundingClientRect().width
      el.width = Math.round(w * dpr); el.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.font = '12px "IBM Plex Mono", ui-monospace, monospace'
      ctx.textBaseline = 'middle'
      cw = ctx.measureText('0').width
    }

    const draw = (now: number) => {
      const p = props.current
      const sec = now / 1000
      clock += Math.min(0.1, (now - prev) / 1000) * (p.busy ? 2.6 : 1)
      prev = now
      const t = clock
      if (p.word && p.word !== shownWord) { shownWord = p.word; wordAt = sec }
      wordK += ((p.word ? 1 : 0) - wordK) * 0.06
      if (p.label !== shownLabel) { shownLabel = p.label; labelAt = sec }

      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = ink
      const cols = Math.floor(w / cw)

      // The word, two cells per dot so it reads square, centred in the band.
      let lit: Set<number> | null = null, w0 = 0, wordW = 1
      if (shownWord && wordK > 0.01) {
        const d = dots(shownWord)
        const sx = Math.max(1, Math.min(2, Math.floor(cols / d.width)))
        w0 = Math.floor((cols - d.width * sx) / 2)
        const r0 = Math.floor((rows - d.height) / 2)
        wordW = d.width * sx
        lit = new Set()
        for (const [x, y] of d.dots) for (let a = 0; a < sx; a++) lit.add((r0 + y) * 1000 + w0 + x * sx + a)
      }

      // Label cut-out: the middle row, with two blank cells either side.
      const text = shownWord && wordK > 0.5 ? '' : shownLabel
      const mid = Math.floor(rows / 2)
      const l0 = Math.floor((cols - text.length) / 2) - 2, l1 = l0 + text.length + 4

      const sweep = ((t * 9) % (cols + 60)) - 30
      const line: string[][] = Array.from({ length: STEPS }, () => [])
      for (let r = 0; r < rows; r++) {
        const y = r * LH + LH / 2
        for (let s = 0; s < STEPS; s++) line[s].length = 0
        const put = (c: number, ch: string, a: number) => {
          const s = Math.max(0, Math.min(STEPS - 1, Math.round(a * (STEPS - 1))))
          const row = line[s]
          while (row.length < c) row.push(' ')
          row.push(ch)
        }
        for (let c = 0; c < cols; c++) {
          if (text && r >= mid - 1 && r <= mid + 1 && c >= l0 && c < l1) {
            if (r === mid && c >= l0 + 2 && c < l1 - 2) {
              const i = c - l0 - 2
              const settled = sec - labelAt > 0.06 + i * 0.022
              put(c, settled ? text[i] : FAMILIES[Math.floor(hash(c, sec * 30) * FAMILIES.length)], 0.92)
            }
            continue
          }

          let ch: string, a: number
          if (pattern) {
            const v = pattern(c, r, t, cols, rows)
            ch = glyph(v, c, r)
            a = 0.13 + 0.8 * v ** 1.25
          } else {
            const v = noise(c / 22 + t * 0.035, r / 3.2 - t * 0.02) * 0.75 + noise(c / 7 - t * 0.05, r / 1.6) * 0.25
            const jitter = (hash(c, r + Math.floor(t * 0.7)) - 0.5) * 0.09
            ch = FAMILIES[Math.max(0, Math.min(FAMILIES.length - 1, Math.floor((v + jitter) * FAMILIES.length * 1.15 - 0.6)))]
            const glow = noise(c / 11 - t * 0.08, r / 2.4 + 9)
            a = 0.16 + glow * 0.3 + Math.exp(-(((c - sweep) / 7) ** 2)) * 0.32
            if (hash(c * 3.1, r * 7.7 + Math.floor(t * 1.4)) > 0.985) a += 0.35
          }
          let out = ch
          if (lit) {
            const inWord = lit.has(r * 1000 + c)
            const k = wordK * smooth(0, 1, (sec - wordAt) * 1.6 - ((c - w0) / wordW) * 1.2)
            if (inWord) { a = a * (1 - k) + 0.95 * k; if (k > 0.5) out = '0' }
            else a *= 1 - 0.6 * k
          }
          put(c, out, Math.min(1, a))
        }
        for (let s = 1; s < STEPS; s++) {
          if (!line[s].length) continue
          ctx.globalAlpha = s / (STEPS - 1)
          ctx.fillText(line[s].join(''), 0, y)
        }
      }
      ctx.globalAlpha = 1
    }

    // Only runs while the band can be seen and the window is in front.
    let visible = true
    const loop = (now: number) => {
      raf = 0
      if (!visible || document.hidden) return
      raf = requestAnimationFrame(loop)
      if (now - drawn < 33) return
      drawn = now
      draw(now)
    }
    const wake = () => { if (!raf && visible && !document.hidden && !still()) { prev = performance.now(); raf = requestAnimationFrame(loop) } }

    // The ink follows the theme the moment it flips, not on a later frame.
    const colour = () => { ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || ink }
    colour()
    const theme = new MutationObserver(() => { colour(); draw(performance.now()) })
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-look'] })
    size()
    const ro = new ResizeObserver(() => { size(); draw(performance.now()) })
    ro.observe(el)
    const seen = new IntersectionObserver(([e]) => { visible = e.isIntersecting; wake() })
    seen.observe(el)
    document.addEventListener('visibilitychange', wake)
    if (still()) { wordK = props.current.word ? 1 : 0; wordAt = -10; draw(performance.now()) }
    else wake()
    return () => { cancelAnimationFrame(raf); ro.disconnect(); seen.disconnect(); theme.disconnect(); document.removeEventListener('visibilitychange', wake) }
  }, [rows, patterned])

  return <canvas ref={canvas} className={`band ${className}`} style={{ height: rows * LH }} aria-hidden="true" />
}
