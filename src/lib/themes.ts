// Themes and their two modes. Lunchbox is the app as it began, ink on black or paper, drawn by
// styles.css alone. Every other theme is built the same way, so they belong together:
// - the neutrals (frame, sheet, composer, ink and every line) are one hue at low strength, set in
//   OKLCH at the same lightness steps in every theme, so contrast and rhythm never change;
// - a few colours from the theme's own palette each do one job: the block a selected row sits in,
//   the accent of everything that acts (send, ticks, progress, selection), and the ASCII ramp;
// - day and night are tuned separately, not inverted: a colour that is a soft block at night is
//   often the deep one by day.

import { contrast, grounds, hexOf, lift, oklch, on } from './custom'

// The built in themes by name; a theme a person makes has an id of its own.
export type ThemeId = string
export type Mode = 'dark' | 'light'
type Ramp = [string, string, string, string]
// A theme made by hand or by an agent may also set its own text, sheet, frame and message box,
// which then replace the neutrals for that mode. pinned says waiting and failure were picked by
// hand, so no reach recolours them.
type Tone = { block: string; onBlock: string; accent: string; onAccent: string; glyphs: Ramp; warn?: string; bad?: string; text?: string; sheet?: string; frame?: string; box?: string; pinned?: boolean }
export type Theme = { id: ThemeId; name: string; note: string; hue: number; chroma: number; dark: Tone; light: Tone; custom?: boolean }

export const THEMES: Theme[] = [
  { id: 'lunchbox', name: 'Lunchbox', note: 'Ink on black or paper', hue: 90, chroma: 0.004,
    dark: { block: '#1c1c1a', onBlock: '#f2f0ea', accent: '#f2f0ea', onAccent: '#080807', glyphs: ['#3a3936', '#77756f', '#b9b6ae', '#f2f0ea'] },
    light: { block: '#e4e3de', onBlock: '#0e0e0d', accent: '#0e0e0d', onAccent: '#fbfaf7', glyphs: ['#cfcdc6', '#9b9890', '#55534e', '#0e0e0d'] } },
  // After AgentIndex: petrol, teal, sea green, mint and a pale lime that labels things.
  { id: 'lagoon', name: 'Lagoon', note: 'Petrol, teal, pale lime', hue: 205, chroma: 0.024,
    dark: { block: '#dff3b8', onBlock: '#0b2228', accent: '#2bbfcc', onAccent: '#03191d', glyphs: ['#1d5664', '#13a6b6', '#65d3b0', '#e6f8b8'] },
    light: { block: '#0f3a44', onBlock: '#e6f8c8', accent: '#0e8c9c', onAccent: '#ffffff', glyphs: ['#9fd3c6', '#3fb3a2', '#13849a', '#0f3a44'] } },
  // After Infinite Ascent: cobalt on navy, sky and ice, and one yellow that acts. Waiting is orange.
  { id: 'cobalt', name: 'Cobalt', note: 'Cobalt, ice, one yellow', hue: 264, chroma: 0.034,
    dark: { block: '#2b5cf2', onBlock: '#ffffff', accent: '#ffd84a', onAccent: '#0a1f6b', glyphs: ['#2a4fb8', '#2f7bf0', '#74ccf8', '#e3f2fc'], warn: '#ff9f43', bad: '#ff7a6b' },
    light: { block: '#0b45d6', onBlock: '#ffffff', accent: '#ffcf2e', onAccent: '#0a1f6b', glyphs: ['#a9cdf0', '#5cb2ec', '#1c74d5', '#0b2a86'], warn: '#c26a00', bad: '#d1342a' } },
  // After Zeroflow: mint and sage, blush, butter and moss.
  { id: 'meadow', name: 'Meadow', note: 'Mint, blush and butter', hue: 152, chroma: 0.02,
    dark: { block: '#f6e3a6', onBlock: '#2b3424', accent: '#f4a29a', onAccent: '#3b1712', glyphs: ['#4b6a55', '#93b09d', '#e9a596', '#fbe9bc'] },
    light: { block: '#fbe3a0', onBlock: '#2c3527', accent: '#ec8f86', onAccent: '#3b1712', glyphs: ['#c7d9cc', '#93b09d', '#d98b7e', '#3f4634'] } },
  // Lagoon's warm opposite: aubergine and lilac, rose, coral and peach.
  { id: 'dusk', name: 'Dusk', note: 'Aubergine, coral, peach', hue: 330, chroma: 0.03,
    dark: { block: '#ffc2a6', onBlock: '#2a0c1f', accent: '#ff7262', onAccent: '#2a0805', glyphs: ['#4a2a72', '#b4507a', '#ff8a65', '#ffd9bd'], bad: '#ff4f6a' },
    light: { block: '#4a1a4f', onBlock: '#ffd9c4', accent: '#ea5a49', onAccent: '#ffffff', glyphs: ['#e3b8cf', '#c86a8e', '#e0714c', '#4a1a4f'], bad: '#b8122e' } },
  // Cobalt's cold sibling, with no yellow: ice, sky and navy.
  { id: 'glacier', name: 'Glacier', note: 'Ice, sky and navy', hue: 232, chroma: 0.026,
    dark: { block: '#cfe6fb', onBlock: '#0b2a5a', accent: '#5cc0f4', onAccent: '#04203a', glyphs: ['#24507e', '#3f9ae0', '#9fd6f7', '#f2fbff'] },
    light: { block: '#0b2a86', onBlock: '#ffffff', accent: '#1f6fe0', onAccent: '#ffffff', glyphs: ['#bcd8f2', '#5cb2ec', '#1c74d5', '#0b2a86'] } },
  // From the koi pond: stone and ink, vermilion and gold. Failure is a deeper red, never the button.
  { id: 'koi', name: 'Koi', note: 'Stone, vermilion, gold', hue: 70, chroma: 0.012,
    dark: { block: '#ece6d8', onBlock: '#1b1a17', accent: '#f0583f', onAccent: '#ffffff', glyphs: ['#5a564e', '#a8a296', '#f0583f', '#f2b632'], bad: '#c22a1c' },
    light: { block: '#1d1c1a', onBlock: '#f7f5f0', accent: '#e4503a', onAccent: '#ffffff', glyphs: ['#cbc6bb', '#8f8a80', '#e4503a', '#c48a08'], bad: '#9e1b12' } },
]

export const themeOf = (id: string, custom: Theme[] = []): Theme => THEMES.find((t) => t.id === id) ?? custom.find((t) => t.id === id) ?? THEMES[0]

// The neutrals of a theme in a mode, at the same lightness steps for every theme.
export function surfaces(t: Theme, mode: Mode) {
  const c = t.chroma, h = t.hue
  return mode === 'dark'
    ? { ground: `oklch(14.5% ${c} ${h})`, sheet: `oklch(18% ${c} ${h})`, well: `oklch(22% ${c} ${h})`, ink: `oklch(96% ${c * 0.6} ${h})` }
    : { ground: `oklch(93% ${c * 1.3} ${h})`, sheet: `oklch(98.6% ${c * 0.35} ${h})`, well: `oklch(96% ${c * 0.6} ${h})`, ink: `oklch(25% ${c * 2.4} ${h})` }
}

// The neutrals with whatever the theme sets for itself in that mode.
export function surfacesOf(t: Theme, mode: Mode) {
  const s = surfaces(t, mode), tone = t[mode]
  return { ground: tone.frame ?? s.ground, sheet: tone.sheet ?? s.sheet, well: tone.box ?? s.well, ink: tone.text ?? s.ink }
}

// How far a theme's colour reaches past the send button, the selected row and the ASCII. Quiet is
// those three. Balanced adds what shows state: focus, switches, links, progress, the mode icons,
// and waiting, failure and Full access in colours that belong to the theme. Rich adds the main buttons, the lines and
// hover, on surfaces that hold more of the theme's hue.
export type Reach = 'quiet' | 'balanced' | 'rich'
export const REACH: { id: Reach; name: string; line: string }[] = [
  { id: 'quiet', name: 'Quiet', line: 'Colour on send, the selected row and the ASCII.' },
  { id: 'balanced', name: 'Balanced', line: 'Also on focus, switches, links, progress and the mode icons.' },
  { id: 'rich', name: 'Rich', line: 'Also on buttons, lines and hover, over deeper surfaces.' },
]
export const reachOf = (v: unknown): Reach => REACH.find((r) => r.id === v)?.id ?? 'balanced'

const HEX = /^#[0-9a-f]{6}$/i
const hexOr = (v: string | undefined, fallback: string) => (v && HEX.test(v) ? v : fallback)
const apart = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const loud = (hex: string) => oklch(hex).c > 0.07

// The surfaces as hex, for working out contrast.
function solid(t: Theme, mode: Mode) {
  const g = grounds(t.hue, t.chroma, mode), tone = t[mode]
  const well = mode === 'dark' ? hexOf(0.22, t.chroma, t.hue) : hexOf(0.96, t.chroma * 0.6, t.hue)
  return { sheet: hexOr(tone.sheet, g.sheet), ground: hexOr(tone.frame, g.ground), well: hexOr(tone.box, well) }
}

// What asks to be noticed is coloured from the theme's own family, so on a blue theme it is a
// blue: the notice comes from being brighter and fuller than what is around it, and from its
// shape and its motion, never from a hue that fights the rest.
const cool = (h: number) => h > 100 && h < 300
const far = (h: number, from: string[]) => from.every((c) => !loud(c) || apart(oklch(c).h, h) >= 26)
const bright = (l: number, c: number, h: number, bg: string, mode: Mode) => lift(hexOf(mode === 'dark' ? clamp(l, 0.74, 0.86) : clamp(l, 0.42, 0.58), c, (h + 360) % 360), bg, 4.5, mode)

// Waiting for you: the brightest note the theme's palette has that is not the accent, such as
// Meadow's butter or Cobalt's sky. A palette of one hue gets the neighbour of its lead colour.
function waiting(t: Theme, mode: Mode, bg: string, lead: string, avoid: string[]) {
  const tone = t[mode], g = tone.glyphs
  const own = (mode === 'dark' ? [g[3], g[2], tone.block, g[1]] : [g[2], g[1], tone.block, g[3]]).map((c) => oklch(c)).find((c) => c.c >= 0.05 && far(c.h, avoid))
  if (own) return bright(own.l, Math.max(own.c, mode === 'dark' ? 0.12 : 0.16), own.h, bg, mode)
  const a = oklch(lead)
  const h = [a.h - 40, a.h + 40].find((x) => far((x + 360) % 360, avoid)) ?? a.h - 40
  return bright(0.86, mode === 'dark' ? 0.12 : 0.16, h, bg, mode)
}

// Full access: the theme's own hue, a little towards violet and fuller and brighter than anything
// near it, so on a blue theme it is a vivid blue; the open padlock says what it means. A warm theme
// is already beside red, so there it is the theme's failure colour, as it is in Quiet.
function risk(t: Theme, mode: Mode, bg: string, bad: string) {
  if (!cool(t.hue)) return bad
  return bright(mode === 'dark' ? 0.8 : 0.48, 0.21, t.hue + 16, bg, mode)
}

// Failure stays a red, since it has to be read as one, turned to the end of red that sits with
// the theme: rose beside blues and greens, a deeper or an orange red beside warm palettes. It
// keeps clear of the accent, so a coral accent is never taken for it.
const SIGNAL = { dark: '#f2542d', light: '#d43a16' }
function failure(t: Theme, mode: Mode, bg: string, avoid: string[]) {
  const base = oklch(SIGNAL[mode])
  const lo = 4, hi = 42
  let h = cool(t.hue) ? 10 : clamp(base.h + clamp(((t.hue - base.h + 540) % 360) - 180, -25, 25), lo, hi)
  if (!far(h, avoid)) h = [lo, hi].sort((x, y) => Math.min(...avoid.filter(loud).map((c) => apart(oklch(c).h, y))) - Math.min(...avoid.filter(loud).map((c) => apart(oklch(c).h, x))))[0]
  return lift(hexOf(base.l, base.c, h), bg, 4.5, mode)
}

// A colour to put words on: moved further from the page until its own text reads on it.
function filled(color: string, mode: Mode) {
  let { l } = oklch(color)
  const { c, h } = oklch(color)
  let out = color
  for (let i = 0; i < 24 && contrast(on(out), out) < 4.5; i++) {
    l = mode === 'dark' ? Math.min(0.97, l + 0.02) : Math.max(0.15, l - 0.02)
    out = hexOf(l, c, h)
  }
  return out
}

// The colours behind each reach. Every one is held to the contrast its job needs: 3 to 1 for a
// ring, a dot or an icon, 4.5 to 1 for text.
function reaching(t: Theme, mode: Mode, reach: Reach): Record<string, string> {
  if (reach === 'quiet') return {}
  const tone = t[mode], s = solid(t, mode)
  // What the theme reaches with is its own colour: of its colours with any strength, the one
  // nearest its hue. Cobalt's is its blue, not the yellow it keeps for the send button. A theme
  // with no such colour, such as plain Lunchbox, uses its accent, or its block when a pale accent
  // could not draw a ring on paper.
  const own = [tone.block, tone.accent, ...tone.glyphs].filter(loud).sort((a, b) => apart(oklch(a).h, t.hue) - apart(oklch(b).h, t.hue))[0]
  // An accent the person chose, by hand or in a theme of their own, is theirs to keep.
  const chosen = t.custom || tone.accent !== THEMES.find((x) => x.id === t.id)?.[mode].accent
  const strong = !chosen && t.chroma >= 0.01 && own ? own : contrast(tone.accent, s.sheet) >= 2 || !loud(tone.block) || contrast(tone.block, s.sheet) < 2 ? tone.accent : tone.block
  const focus = lift(lift(strong, s.sheet, 3, mode), s.ground, 3, mode)
  // A built in cool theme's own failure and waiting colours are its Quiet ones; here they join
  // the family. What a person picked, in a theme of their own or by hand, is left alone.
  const kept = t.custom || tone.pinned || !cool(t.hue)
  const bad = kept && tone.bad ? tone.bad : failure(t, mode, s.sheet, [tone.accent])
  const full = kept && tone.bad ? bad : risk(t, mode, s.well, bad)
  const warn = kept && tone.warn ? tone.warn : waiting(t, mode, s.sheet, strong, [strong, tone.accent, bad, full])
  // The modes other than Full access take a colour that cannot be read as failure or waiting.
  // Full access may share their family: its padlock and its brightness set it apart.
  const safe = (c: string) => loud(c) && apart(oklch(c).h, oklch(bad).h) >= 40 && far(oklch(c).h, [warn])
  const calm = [strong, tone.accent, tone.block, tone.glyphs[1]].find(safe)
  const auto = calm && lift(calm, s.well, 3, mode)
  const set: Record<string, string> = {
    '--focus': focus, '--live': focus, '--lit': focus, '--on-lit': on(focus),
    '--link': lift(focus, s.sheet, 4.5, mode),
    '--thumb': `color-mix(in oklab, ${focus} 30%, var(--cell))`,
    '--edge': `color-mix(in oklab, ${focus} ${reach === 'rich' ? 34 : 20}%, var(--line))`,
    '--warn': warn, '--bad': bad, '--full': full,
    '--sel': reach === 'rich' ? '24%' : '20%', '--sel-edge': reach === 'rich' ? '38%' : '32%',
    ...(auto ? { '--mode-auto': auto, '--mode-ask': `color-mix(in oklab, ${auto} 72%, var(--dim))`, '--mode-plan': `color-mix(in oklab, ${auto} 44%, var(--dim))` } : {}),
  }
  if (reach === 'rich') {
    const line = (n: number) => `color-mix(in oklab, color-mix(in oklab, ${focus} 45%, var(--ink)) ${n}%, transparent)`
    const btn = filled(focus, mode)
    Object.assign(set, { '--btn': btn, '--on-btn': on(btn), '--line': line(11), '--line2': line(19), '--cell': line(15), '--hover': `color-mix(in oklab, ${focus} 8%, transparent)` })
  }
  return set
}

// Every custom property a theme sets on the root. Lunchbox sets none: styles.css is its source.
export function tokens(t: Theme, mode: Mode, reach: Reach = 'quiet'): Record<string, string> {
  if (t.id === 'lunchbox') return {}
  // Rich lets the surfaces hold more of the hue; the lightness steps stay where they are.
  const s = surfacesOf(reach === 'rich' ? { ...t, chroma: Math.min(0.055, t.chroma * 1.6) } : t, mode)
  const tone = t[mode]
  const mix = (n: number) => `color-mix(in oklab, var(--ink) ${n}%, transparent)`
  return {
    '--ground': s.ground, '--sheet': s.sheet, '--well': s.well, '--ink': s.ink,
    '--dim': mix(64), '--faint': mix(40), '--line': mix(9), '--line2': mix(16), '--cell': mix(13), '--hover': mix(5),
    '--block': tone.block, '--on-block': tone.onBlock, '--accent': tone.accent, '--on-accent': tone.onAccent,
    ...(tone.warn ? { '--warn': tone.warn } : {}), ...(tone.bad ? { '--bad': tone.bad } : {}),
    ...Object.fromEntries(tone.glyphs.map((g, i) => [`--glyph-${i + 1}`, g])),
    ...reaching(t, mode, reach),
  }
}

// A theme with the single colours a person changed by hand folded in, so what follows from a
// colour (the ring, the switches, the links) follows the changed one.
export function withTune(t: Theme, mode: Mode, own: Partial<Record<string, string>>): Theme {
  const tone = { ...t[mode] }
  const put = (key: string, to: 'block' | 'accent' | 'warn' | 'bad' | 'text' | 'sheet' | 'frame' | 'box') => { const v = own[key]; if (v) tone[to] = v }
  put('--block', 'block'); put('--accent', 'accent'); put('--warn', 'warn'); put('--bad', 'bad')
  put('--ink', 'text'); put('--sheet', 'sheet'); put('--ground', 'frame'); put('--well', 'box')
  if (own['--warn'] || own['--bad']) tone.pinned = true
  return { ...t, [mode]: tone }
}

// The ASCII on its own: the welcome band, the room's field and the dot fields. Theme follows the theme; Ink is plain; the rest are ramps from faint
// to loud, one set for dark grounds and one for light, so each reads on both.
export type AsciiId = 'theme' | 'ink' | 'lagoon' | 'cobalt' | 'dusk' | 'meadow' | 'koi' | 'ember' | 'aurora' | 'riso' | 'phosphor' | 'amber' | 'sakura' | 'brass'
export type Ascii = { id: AsciiId; name: string; dark?: Ramp; light?: Ramp }

export const ASCII: Ascii[] = [
  { id: 'theme', name: 'Theme' },
  { id: 'ink', name: 'Ink' },
  { id: 'lagoon', name: 'Lagoon', dark: ['#1d5664', '#13a6b6', '#65d3b0', '#e6f8b8'], light: ['#9fd3c6', '#3fb3a2', '#13849a', '#0f3a44'] },
  { id: 'cobalt', name: 'Cobalt', dark: ['#2a4fb8', '#2f7bf0', '#74ccf8', '#e3f2fc'], light: ['#a9cdf0', '#5cb2ec', '#1c74d5', '#0b2a86'] },
  { id: 'dusk', name: 'Dusk', dark: ['#4a2a72', '#b4507a', '#ff8a65', '#ffd9bd'], light: ['#e3b8cf', '#c86a8e', '#e0714c', '#4a1a4f'] },
  { id: 'meadow', name: 'Meadow', dark: ['#4b6a55', '#93b09d', '#e9a596', '#fbe9bc'], light: ['#c7d9cc', '#93b09d', '#d98b7e', '#3f4634'] },
  { id: 'koi', name: 'Koi', dark: ['#5a564e', '#a8a296', '#f0583f', '#f2b632'], light: ['#cbc6bb', '#8f8a80', '#e4503a', '#c48a08'] },
  { id: 'ember', name: 'Ember', dark: ['#6e1c12', '#c2410c', '#fb923c', '#fde3b8'], light: ['#f3c3a6', '#ea7a3c', '#c2410c', '#5c1a0c'] },
  { id: 'aurora', name: 'Aurora', dark: ['#40288c', '#7c5cff', '#38d9c4', '#d9fff3'], light: ['#cfc2ff', '#8b70ff', '#14a89a', '#2a1a78'] },
  { id: 'riso', name: 'Riso', dark: ['#00788c', '#00a3b4', '#ff48b0', '#ffd1ea'], light: ['#a6e0e6', '#00a3b4', '#ff48b0', '#7a0a4c'] },
  { id: 'phosphor', name: 'Phosphor', dark: ['#145a28', '#1f9e4a', '#4dff88', '#d4ffe0'], light: ['#b6e6c4', '#2fb35c', '#16803a', '#0b3d1c'] },
  { id: 'amber', name: 'Amber CRT', dark: ['#6e3c00', '#b86e00', '#ffb000', '#ffe7a8'], light: ['#f0d3a0', '#d08c10', '#a35f00', '#4a2a00'] },
  { id: 'sakura', name: 'Sakura', dark: ['#78394f', '#d98aa5', '#f6c1d2', '#fff4f7'], light: ['#f3cdd9', '#e59ab4', '#c25b80', '#5e1f36'] },
  { id: 'brass', name: 'Brass', dark: ['#5a461e', '#9c7a35', '#d9b25f', '#f6e7bf'], light: ['#e6d4ac', '#b8913f', '#8a6420', '#3d2a08'] },
]

export const asciiOf = (id: string): Ascii => ASCII.find((a) => a.id === id) ?? ASCII[0]
