// The patterns the band on New room draws, one per visit. Each gives a brightness from 0 to 1 for a
// cell at a time, from smooth functions only: nothing is random per frame, so a cell changes only
// when the pattern moves past it, one step at a time.

// Cells are about twice as tall as wide; y is scaled by this so round shapes stay round.
const ASPECT = 2.1

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
const fbm = (x: number, y: number) => noise(x, y) * 0.55 + noise(x * 2.03 + 17, y * 2.03 - 9) * 0.3 + noise(x * 4.1 - 31, y * 4.1 + 5) * 0.15
const clamp = (v: number) => Math.max(0, Math.min(1, v))

export type Pattern = (c: number, r: number, t: number, cols: number, rows: number) => number

export const PATTERNS: Record<string, Pattern> = {
  // Rings from two drifting points, like two agents talking.
  ripples(c, r, t, cols, rows) {
    const ax = cols * (0.3 + 0.08 * Math.sin(t * 0.11)), ay = rows * 0.5 + 2 * Math.sin(t * 0.17)
    const bx = cols * (0.7 + 0.08 * Math.cos(t * 0.09)), by = rows * 0.5 + 2 * Math.cos(t * 0.13)
    const da = Math.hypot(c - ax, (r - ay) * ASPECT), db = Math.hypot(c - bx, (r - by) * ASPECT)
    return clamp(0.45 + 0.27 * Math.sin(da / 3.2 - t * 1.1) + 0.27 * Math.sin(db / 3.6 - t * 0.95))
  },
  // Long swells rolling across at different speeds.
  tide(c, r, t) {
    const y = r * ASPECT
    const swell = Math.sin(c / 11 - t * 0.9 + Math.sin(y / 4 + t * 0.2) * 2)
    return clamp(0.48 + 0.22 * Math.sin(c / 19 - t * 0.55 + y / 5) + 0.16 * Math.sin(c / 31 + t * 0.32 - y / 7 + 1.7) + 0.12 * swell)
  },
  // Threads that cross, part and cross again.
  weave(c, r, t) {
    const y = r * ASPECT
    const warp = fbm(c / 40 + t * 0.012, y / 10) * 5
    const a = Math.sin((c + y) / 3.4 + warp + t * 0.5)
    const b = Math.sin((c - y) / 3.8 - warp * 0.8 - t * 0.38)
    return clamp(0.42 + 0.3 * Math.max(a, b) + 0.15 * a * b)
  },
  // A slow spiral turning around a point that wanders.
  vortex(c, r, t, cols, rows) {
    const cx = cols * (0.5 + 0.18 * Math.sin(t * 0.07)), cy = rows / 2 + Math.sin(t * 0.1)
    const dx = c - cx, dy = (r - cy) * ASPECT
    const d = Math.hypot(dx, dy)
    const arm = Math.sin(Math.atan2(dy, dx) * 3 + d / 4.5 - t * 0.8)
    return clamp(0.45 + 0.35 * arm * Math.exp(-d / 70) + 0.12 * Math.sin(d / 2.6 - t * 0.6))
  },
  // Wind-shaped ridges with bright crests.
  dunes(c, r, t) {
    const y = r * ASPECT
    const ridge = 1 - Math.abs(Math.sin(c / 9 + y / 3.5 + fbm(c / 30 - t * 0.03, y / 12) * 6 - t * 0.35))
    return clamp(0.18 + 0.72 * ridge ** 3 + 0.12 * noise(c / 8, y / 8 + t * 0.1))
  },
  // Two fine grids sliding over each other.
  moire(c, r, t) {
    const y = r * ASPECT, k = 0.06 * Math.sin(t * 0.05)
    return clamp(0.45 + 0.42 * Math.sin(c * 0.9 + y * 0.12) * Math.sin(c * (0.9 + k) - y * (0.12 + k * 2) + t * 0.4))
  },
  // A warped current, like ink in water.
  flow(c, r, t) {
    const x = c / 30, y = (r * ASPECT) / 30
    const qx = fbm(x + t * 0.03, y - t * 0.01), qy = fbm(x - 4.7 - t * 0.02, y + 2.1)
    return clamp((fbm(x + 2.4 * qx, y + 2.4 * qy - t * 0.015) - 0.25) * 1.7)
  },
  // Four soft bodies, one per agent, on their own slow orbits. Where they meet their fields add up
  // and they merge; as they part the neck between them thins and lets go.
  gather(c, r, t, cols, rows) {
    let field = 0
    for (let k = 0; k < 4; k++) {
      const x = cols * (0.5 + 0.38 * Math.sin(t * (0.11 + k * 0.023) + k * 1.9))
      const y = rows / 2 + 2.6 * Math.sin(t * (0.17 + k * 0.031) + k * 2.7)
      const dx = c - x, dy = (r - y) * ASPECT
      field += 90 / (dx * dx + dy * dy + 30)
    }
    return clamp(0.12 + (field / (1 + field)) * 0.95 + 0.05 * Math.sin(c / 3.1 + r * 1.7 - t * 1.3))
  },
  // Four traces on one screen, a line per agent. Where two cross they brighten, and a sweep leaves
  // a short afterglow behind it.
  signal(c, r, t, cols, rows) {
    let v = 0.05
    for (let k = 0; k < 4; k++) {
      const y = rows / 2 + (rows / 2 - 1.2) * Math.sin(c / (9 + k * 3.3) + t * (0.5 + k * 0.17) + k * 1.7) * (0.55 + 0.45 * Math.sin(t * 0.13 + k))
      const d = Math.abs(r - y) * ASPECT
      v += Math.exp(-d * d / 2.2) * 0.62
    }
    const sweep = ((t * 22) % (cols + 40)) - 20
    const behind = c <= sweep ? Math.exp(-(sweep - c) / 26) : 0
    return clamp(v * (0.55 + 0.45 * behind) + 0.04 * Math.sin(c / 2 + r))
  },
  // A dot grid like a printed proof. A slow diagonal light crosses it and each dot swells to a
  // heavier mark as it passes, then settles back.
  grid(c, r, t) {
    if (c % 4 !== 1 || r % 2 !== 0) return 0.02
    const y = r * ASPECT
    const wave = Math.sin((c + y * 1.6) / 22 - t * 0.7)
    return clamp(0.18 + 0.62 * Math.max(0, wave) ** 2 + 0.3 * (fbm(c / 50 + t * 0.03, y / 20) - 0.4))
  },
  // Striped bands pushed around by a slow current, like marbled paper.
  marble(c, r, t) {
    const x = c / 26, y = (r * ASPECT) / 26
    const w = fbm(x + t * 0.025, y - t * 0.012) * 4.2
    return clamp(0.5 + 0.38 * Math.sin(c / 7 + w * 3 + t * 0.3) + 0.1 * Math.sin(c / 2.7 + y * 4 - t * 0.5))
  },
  // Flat tiles, each its own tone. Their borders slide as the tiles drift, and they trade shades.
  mosaic(c, r, t, cols, rows) {
    let a = 1e9, b = 1e9, tone = 0
    for (let k = 0; k < 14; k++) {
      const x = cols * ((k * 0.618) % 1) + 10 * Math.sin(t * (0.06 + k * 0.009) + k * 2.3)
      const y = rows * ((k * 0.383) % 1) + 2.5 * Math.sin(t * (0.08 + k * 0.011) + k * 1.1)
      const d = Math.hypot(c - x, (r - y) * ASPECT)
      if (d < a) { b = a; a = d; tone = 0.3 + 0.6 * (0.5 + 0.5 * Math.sin(k * 2.4 + t * 0.15)) } else if (d < b) b = d
    }
    return clamp(b - a < 1.1 ? 0.12 : tone)
  },
  // A herringbone weave: stripes lean one way in a column and the other way in the next, with a
  // sheen moving across as if the cloth turned.
  herringbone(c, r, t) {
    const dir = Math.floor(c / 10) % 2 ? 1 : -1
    const stripe = ((((c + dir * r * 2) / 6) % 1) + 1) % 1 < 0.5 ? 1 : 0
    const sheen = 0.5 + 0.5 * Math.sin(c / 34 - t * 0.5 + Math.sin(r / 3 + t * 0.2))
    return clamp(0.16 + 0.34 * stripe + 0.42 * sheen * (0.45 + 0.55 * stripe))
  },
  // A checkerboard on rippling cloth: the squares bend and swell as slow waves pass through.
  checker(c, r, t) {
    const y = r * ASPECT
    const wx = c + 3.2 * Math.sin(y / 7 + t * 0.6) + 2 * Math.sin(c / 17 - t * 0.35)
    const wy = y + 2.4 * Math.sin(c / 11 - t * 0.5)
    const on = (Math.floor(wx / 7) + Math.floor(wy / 4.2)) % 2 === 0 ? 1 : 0
    const shade = 0.5 + 0.5 * Math.sin(c / 23 + y / 9 - t * 0.45)
    return clamp(0.14 + 0.5 * on + 0.3 * shade * (0.4 + 0.6 * on))
  },
}

export const NAMES = Object.keys(PATTERNS)

// Code characters from faint to heavy. Every cell shows one; the quiet parts of a pattern use the
// small marks at the start, so the band reads as a field with depth and never as holes.
export const RAMP = ['.', ',', ':', ';', '-', '~', '=', '+', '<>', '!/\\', '|()', '[]{}', 'il1t', 'fjrc', 'vxz?', '7Y3', '5n2u', 'e0S', 'Z49', '#%', '&8', '@']

// The glyph for a brightness. Which of a level's glyphs a cell shows is fixed per cell, so a level
// has texture without flicker.
export function glyph(v: number, c: number, r: number) {
  const level = RAMP[Math.min(RAMP.length - 1, Math.floor(Math.max(0, v) * RAMP.length))]
  return level[Math.floor(hash(c, r) * level.length)]
}

// A different pattern from the one shown last time, so every visit looks new.
export function nextPattern(last: string | null, roll = Math.random()) {
  const pool = NAMES.filter((n) => n !== last)
  return pool[Math.floor(roll * pool.length) % pool.length]
}
