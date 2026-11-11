import { PATHS } from './Logo'

// The image people post when they share what Lunchbox saved them. Drawn on a canvas with the app's
// own type and colours, at twice the size it is shown, in the 16:9 frame X shows in full.
export type SavingsCard = {
  headline: string
  line: string
  stats: { value: string; label: string }[]
  series: number[]
  range: string
}

const W = 1200
const H = 675
const INK = '#f2f0ea'
const GROUND = '#0e0e0d'
const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif'
const MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace'
const ink = (a: number) => `rgba(242, 240, 234, ${a})`

export async function drawSavingsCard(c: SavingsCard): Promise<string> {
  await document.fonts?.ready
  const canvas = document.createElement('canvas')
  canvas.width = W * 2
  canvas.height = H * 2
  const g = canvas.getContext('2d')!
  g.scale(2, 2)

  g.fillStyle = GROUND
  g.fillRect(0, 0, W, H)
  // A quiet dot grid, the paper the numbers sit on.
  g.fillStyle = ink(0.06)
  for (let x = 30; x < W; x += 24) for (let y = 30; y < H; y += 24) g.fillRect(x, y, 1.2, 1.2)

  const pad = 72
  // The mark, drawn from the same paths as the app's logo.
  g.save()
  g.translate(pad, pad - 4)
  const s = 34 / 690
  g.scale(s, s)
  g.translate(-282, -314.5)
  g.translate(0, 1254)
  g.scale(0.1, -0.1)
  g.fillStyle = INK
  for (const d of PATHS) g.fill(new Path2D(d))
  g.restore()
  g.fillStyle = INK
  g.font = `600 26px ${SANS}`
  g.textBaseline = 'middle'
  g.fillText('Lunchbox', pad + 48, pad + 13)
  g.font = `400 16px ${MONO}`
  g.fillStyle = ink(0.45)
  g.textAlign = 'right'
  g.fillText(c.range.toUpperCase(), W - pad, pad + 13)
  g.textAlign = 'left'

  // The number, as large as the frame allows.
  g.textBaseline = 'alphabetic'
  g.fillStyle = INK
  let size = 168
  g.font = `500 ${size}px ${SANS}`
  while (g.measureText(c.headline).width > W - pad * 2 - 300 && size > 80) { size -= 6; g.font = `500 ${size}px ${SANS}` }
  g.letterSpacing = `${-size * 0.04}px`
  g.fillText(c.headline, pad - 6, 318)
  g.letterSpacing = '0px'
  g.font = `400 30px ${SANS}`
  g.fillStyle = ink(0.62)
  g.fillText(c.line, pad, 372)

  // Seven days as bars, right of the number.
  const max = Math.max(...c.series, 0)
  if (max > 0) {
    const bw = 22, gap = 12, bh = 150
    const x0 = W - pad - (bw + gap) * c.series.length + gap
    c.series.forEach((v, i) => {
      const h = Math.max(3, (v / max) * bh)
      g.fillStyle = i === c.series.length - 1 ? INK : ink(0.28)
      g.fillRect(x0 + i * (bw + gap), 318 - h, bw, h)
    })
  }

  // Three facts under a hairline.
  const top = 470
  g.fillStyle = ink(0.12)
  g.fillRect(pad, top, W - pad * 2, 1)
  const col = (W - pad * 2) / Math.max(1, c.stats.length)
  c.stats.forEach((st, i) => {
    const x = pad + i * col
    if (i) { g.fillStyle = ink(0.12); g.fillRect(x - 24, top + 28, 1, 74) }
    g.fillStyle = INK
    g.font = `500 44px ${SANS}`
    g.fillText(st.value, x, top + 76)
    g.fillStyle = ink(0.5)
    g.font = `400 15px ${MONO}`
    g.fillText(st.label.toUpperCase(), x, top + 106)
  })

  g.fillStyle = ink(0.45)
  g.font = `400 16px ${MONO}`
  g.fillText('EVERY AI IN ONE APP', pad, H - 46)
  g.textAlign = 'right'
  g.fillText('MYLUNCHBOX.DEV', W - pad, H - 46)
  return canvas.toDataURL('image/png')
}
