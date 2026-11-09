import { useEffect, useRef, type MutableRefObject } from 'react'
import { still } from './bits'

// A source is one agent's region of the field. It writes in its own alphabet.
export type Source = { alphabet: string; x: number; y: number; energy: number }
export type Cable = { from: number; to: number; at: number }
export type Scene = {
  sources: Source[]
  active: number
  cables: Cable[]
  mask?: { dots: [number, number][]; width: number; height: number }
  maskAt?: number
  bump?: number
  hold?: boolean
}

const CELL_H = 14
const DIM = 0, MID = 1, INK = 2
const NOISE = '#%*+=-:.'

const hash = (a: number, b: number) => {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return n - Math.floor(n)
}

// Three slow textures, mixed on their own clocks so the ground never repeats.
const MOODS = [
  (x: number, y: number, t: number) => (Math.sin(x + t * 0.7 + Math.sin(y * 0.9 - t * 0.5) * 1.5) + Math.sin(y * 1.3 - t * 0.55 + Math.sin(x * 0.6 + t * 0.3) * 1.2)) / 2,
  (x: number, y: number, t: number) => {
    const h = Math.sin(x * 0.7 + t * 0.21) + Math.sin(y * 0.8 - t * 0.17) + Math.sin((x + y) * 0.45 + t * 0.13)
    const band = Math.abs(((h * 1.6 + 8) % 1) - 0.5) * 2
    return band < 0.2 ? 0.75 : h * 0.16 - 0.3
  },
  (x: number, y: number, t: number) => {
    const a = Math.sin(x * 2.1 + y * 1.3 + t * 0.4), b = Math.sin(x * 2.1 - y * 1.3 - t * 0.33)
    return (Math.sin(x * 0.5 + y * 0.9 - t * 0.2) > 0 ? a : b) * 0.8
  },
]

type Ripple = { c: number; r: number; at: number; amp: number }

export function Field({ scene, height = 168, quiet = 0.25, className = '' }: { scene: MutableRefObject<Scene>; height?: number; quiet?: number; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current!
    const ctx = el.getContext('2d')!
    let cols = 0, rows = 0, cellW = 7.2, raf = 0, last = 0, shown = true, bumps = scene.current.bump ?? 0
    let slow = 0, vt = 0, prev = 0
    let ink = '', faint = '', font = ''
    const energy: number[] = []
    const ripples: Ripple[] = []
    const pointer = { c: -99, r: -99, lift: 0 }
    const clocks = MOODS.map(() => 0.04 + Math.random() * 0.06)
    const phases = MOODS.map(() => Math.random() * 6.28)

    const colours = () => {
      const s = getComputedStyle(el)
      ink = s.getPropertyValue('--ink').trim()
      faint = s.getPropertyValue('--faint').trim()
      font = `12px ${s.getPropertyValue('--mono')}`
    }
    const size = () => {
      const dpr = devicePixelRatio || 1
      el.width = el.clientWidth * dpr
      el.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      colours()
      ctx.font = font
      cellW = ctx.measureText('0'.repeat(20)).width / 20
      cols = Math.floor(el.clientWidth / cellW)
      rows = Math.floor(height / CELL_H)
    }

    const draw = (t: number) => {
      const s = scene.current
      const n = s.sources.length
      // While the room waits for you the ground nearly stops and dims; handoffs and ripples keep real time.
      slow += ((s.hold ? 1 : 0) - slow) * 0.06
      vt += Math.min(0.1, prev ? t - prev : 0) * (1 - slow * 0.85)
      prev = t
      const mt = vt + (phases[0] * 10)
      const hush = quiet + slow * 0.12
      while (energy.length < n) energy.push(0)
      for (let i = 0; i < n; i++) energy[i] += (s.sources[i].energy + (s.active === i ? 0.9 : 0) - energy[i]) * 0.05
      if ((s.bump ?? 0) !== bumps && n) {
        bumps = s.bump ?? 0
        const a = s.active >= 0 ? s.sources[s.active] : s.sources[0]
        ripples.push({ c: a.x * cols, r: a.y * rows, at: t, amp: 1.3 })
      }
      while (ripples.length && t - ripples[0].at > 2.4) ripples.shift()
      pointer.lift *= 0.93

      // Where each source sits right now. They drift a little, never far from home.
      const at = s.sources.map((src, i) => ({
        c: src.x * cols + Math.sin(mt * 0.13 + i * 1.7) * cols * 0.04,
        r: src.y * rows + Math.cos(mt * 0.11 + i * 2.3) * rows * 0.12,
      }))
      const sigma = Math.max(el.clientWidth, 260) * 0.15

      // Cables are sampled into cells once a frame, each with the character its slope calls for.
      const wire = new Map<number, [number, string]>()
      for (const cab of s.cables) {
        const age = t - cab.at
        if (age < 0 || age > 3.2 || !at[cab.from] || !at[cab.to]) continue
        const p0 = at[cab.from], p2 = at[cab.to]
        const p1 = { c: (p0.c + p2.c) / 2, r: Math.min(p0.r, p2.r) - rows * 0.5 }
        const head = Math.min(1, age / 0.5)
        const fade = age > 2.6 ? 1 - (age - 2.6) / 0.6 : 1
        const pulse = (age * 0.8) % 1
        for (let k = 0; k <= 120; k++) {
          const u = k / 120
          if (u > head) break
          const c = Math.round((1 - u) ** 2 * p0.c + 2 * (1 - u) * u * p1.c + u * u * p2.c)
          const r = Math.round((1 - u) ** 2 * p0.r + 2 * (1 - u) * u * p1.r + u * u * p2.r)
          if (c < 0 || r < 0 || c >= cols || r >= rows) continue
          const dc = 2 * (1 - u) * (p1.c - p0.c) + 2 * u * (p2.c - p1.c)
          const dr = (2 * (1 - u) * (p1.r - p0.r) + 2 * u * (p2.r - p1.r)) * (CELL_H / cellW)
          const slope = Math.abs(dr) / (Math.abs(dc) + 1e-6)
          const near = Math.abs(u - pulse) < 0.035
          const ch = near ? (dc >= 0 ? '>' : '<') : slope < 0.4 ? (fade > 0.5 ? '=' : '-') : slope > 2.5 ? '|' : dr * dc > 0 ? '\\' : '/'
          wire.set(c * 1000 + r, [near ? 1 : fade * 0.8, ch])
        }
      }

      // The mask (the wordmark) settles cell by cell out of noise.
      let mx0 = 0, my0 = 0, ms = 0
      const lit = new Set<number>()
      if (s.mask) {
        ms = Math.max(1, Math.min((cols * 0.52) / (s.mask.width * 2), (rows * 0.4) / s.mask.height))
        mx0 = Math.floor((cols - s.mask.width * 2 * ms) / 2)
        my0 = Math.floor((rows - s.mask.height * ms) / 2)
        for (const [x, y] of s.mask.dots) lit.add(x * 100 + y)
      }

      ctx.clearRect(0, 0, el.clientWidth, height)
      ctx.font = font
      ctx.textBaseline = 'top'
      let total = 0
      const w = MOODS.map((_, i) => { const v = Math.max(0, Math.sin(mt * clocks[i] + phases[i])) ** 2 + 0.15; total += v; return v })

      for (let r = 0; r < rows; r++) {
        const line = ['', '', '']
        for (let c = 0; c < cols; c++) {
          let tone = DIM, mark = ' '
          const x = c * 0.085, y = r * 0.3
          let v = 0
          for (let i = 0; i < MOODS.length; i++) v += MOODS[i](x, y, mt) * w[i] / total
          for (const p of ripples) {
            const age = t - p.at, d = Math.hypot((c - p.c) * 0.5, r - p.r)
            v += p.amp * Math.sin(d * 0.9 - age * 7) * Math.exp(-age * 1.5) * Math.exp(-Math.abs(d - age * 8) * 0.28)
          }
          if (pointer.lift > 0.01) v += pointer.lift * Math.exp(-(((c - pointer.c) * 0.5) ** 2 + (r - pointer.r) ** 2) / 12)

          let best = -1, bw = 0
          for (let i = 0; i < n; i++) {
            const dx = (c - at[i].c) * cellW, dy = (r - at[i].r) * CELL_H
            const reach = sigma * (0.75 + energy[i] * 0.45)
            const wobble = 1 + 0.22 * Math.sin(c * 0.21 + r * 0.9 + mt * 0.8 + i * 2)
            const wi = Math.exp(-(dx * dx + dy * dy) / (2 * reach * reach)) * (0.45 + energy[i]) * wobble
            if (wi > bw) { bw = wi; best = i }
          }
          const alphabet = best >= 0 ? s.sources[best].alphabet : '.:-=+*#%@'
          let k = Math.max(0, Math.min(1, 0.42 * v + bw * 0.8 - hush))

          const cell = wire.get(c * 1000 + r)
          if (s.mask && ms) {
            const dx = Math.floor((c - mx0) / (2 * ms)), dy = Math.floor((r - my0) / ms)
            const inside = dx >= -1 && dy >= -1 && dx <= s.mask.width && dy <= s.mask.height
            if (inside) k *= 0.3
            if (dx >= 0 && dy >= 0 && lit.has(dx * 100 + dy)) {
              const settle = (s.maskAt ?? 0) + hash(c, r) * 1.1 + ((c - mx0) / cols) * 0.7
              if (t > settle) { tone = INK; mark = alphabet[alphabet.length - 1 - Math.floor(hash(c + Math.floor(t * 0.6), r) * 2)] }
              else if (t > settle - 0.6) { tone = MID; mark = NOISE[Math.floor(t * 14 + c * 3) % NOISE.length] }
            }
          }
          if (mark === ' ' && cell) { tone = cell[0] > 0.9 ? INK : MID; mark = cell[1] }
          if (mark === ' ' && k > 0.1) {
            mark = alphabet[Math.min(alphabet.length - 1, Math.floor(k * alphabet.length))]
            tone = k > 0.72 || (best === s.active && k > 0.5) ? INK : k > 0.42 ? MID : DIM
          }
          for (let i = 0; i < 3; i++) line[i] += i === tone ? mark : ' '
        }
        const yy = r * CELL_H
        ctx.fillStyle = faint
        ctx.fillText(line[DIM], 0, yy)
        ctx.fillStyle = ink
        ctx.globalAlpha = 0.6
        ctx.fillText(line[MID], 0, yy)
        ctx.globalAlpha = 1
        ctx.fillText(line[INK], 0, yy)
      }
    }

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (!shown || now - last < 33) return
      last = now
      draw(now / 1000)
    }

    size()
    document.fonts.ready.then(size)
    const fit = new ResizeObserver(size)
    fit.observe(el)
    const theme = new MutationObserver(colours)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const seen = new IntersectionObserver(([e]) => { shown = e.isIntersecting })
    seen.observe(el)
    const cell = (e: PointerEvent) => {
      const box = el.getBoundingClientRect()
      return { c: (e.clientX - box.left) / cellW, r: (e.clientY - box.top) / CELL_H }
    }
    const move = (e: PointerEvent) => { Object.assign(pointer, cell(e), { lift: 1.2 }) }
    const press = (e: PointerEvent) => { ripples.push({ ...cell(e), at: performance.now() / 1000, amp: 1.4 }) }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerdown', press)
    if (still()) document.fonts.ready.then(() => draw(performance.now() / 1000 + 30))
    else raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      fit.disconnect(); theme.disconnect(); seen.disconnect()
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerdown', press)
    }
  }, [height, quiet, scene])

  return <canvas ref={canvas} className={`field ${className}`} style={{ height }} aria-hidden="true" />
}
