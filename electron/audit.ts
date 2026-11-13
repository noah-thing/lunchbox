// Studio's audit: what a page actually does at a given width, measured rather than judged.
// MEASURE runs inside the page and returns facts; report() turns them into a short list an agent
// can act on. Accessibility comes from axe-core, the rest from the layout as the browser drew it.

export type Finding = { kind: string; text: string; at: string[] }
export type Measured = {
  width: number
  findings: Finding[]
  families: string[]
  sizes: number[]
  colours: number
  offGrid: number
  spacings: number
  // Defaults nobody chose, the marks of a page made without a direction.
  tells: string[]
  // How much of the first screen carries anything, in percent, whole and by half.
  first?: { all: number; left: number; right: number; top: number; bottom: number }
}
export type Axe = { id: string; impact: string | null; help: string; nodes: number; at: string[] }

// A string so it can be sent into the page. Kept to plain browser APIs.
export const MEASURE = `(() => {
  const W = innerWidth
  const phone = W < 600
  const findings = []
  const short = (el) => {
    const part = (e) => {
      if (e.id) return '#' + CSS.escape(e.id)
      let s = e.tagName.toLowerCase()
      const cls = [...e.classList].filter((c) => !/^(css|sc|jsx|svelte)-|\\d{3,}/.test(c)).slice(0, 2)
      if (cls.length) s += '.' + cls.map((c) => CSS.escape(c)).join('.')
      return s
    }
    const path = []
    for (let e = el; e && e !== document.body && path.length < 3; e = e.parentElement) {
      path.unshift(part(e))
      if (e.id) break
    }
    return path.join(' > ') || 'body'
  }
  const shown = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05
  }
  const els = [...document.body.querySelectorAll('*')].filter((e) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(e.tagName)).filter(shown)
  const ownText = (e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)
  const texts = els.filter(ownText)

  const wide = document.documentElement.scrollWidth
  if (wide > W + 1) {
    const out = els.filter((e) => e.getBoundingClientRect().right > W + 1).sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
    findings.push({ kind: 'overflow', text: 'The page scrolls sideways: ' + wide + 'px of content in a ' + W + 'px window', at: out.slice(0, 3).map(short) })
  }

  // Text on top of other text. Nested elements are skipped; one inside the other is not a clash.
  const boxes = texts.slice(0, 500).map((e) => [e, e.getBoundingClientRect()])
  const clashes = []
  for (let i = 0; i < boxes.length && clashes.length < 5; i++) {
    for (let j = i + 1; j < boxes.length && clashes.length < 5; j++) {
      const [a, ra] = boxes[i], [b, rb] = boxes[j]
      if (a.contains(b) || b.contains(a)) continue
      const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
      const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
      if (x > 4 && y > 4) clashes.push(short(a) + ' and ' + short(b))
    }
  }
  if (clashes.length) findings.push({ kind: 'overlap', text: 'Text overlaps other text', at: clashes })

  const cut = texts.filter((e) => {
    const cs = getComputedStyle(e)
    if (cs.textOverflow === 'ellipsis' || !/(hidden|clip)/.test(cs.overflow + cs.overflowX + cs.overflowY)) return false
    return e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 2
  })
  if (cut.length) findings.push({ kind: 'clipped', text: cut.length + ' text element(s) cut off by their box', at: cut.slice(0, 3).map(short) })

  const tiny = texts.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12)
  if (tiny.length) findings.push({ kind: 'small text', text: tiny.length + ' text element(s) under 12px', at: tiny.slice(0, 3).map(short) })

  if (phone) {
    const taps = els.filter((e) => e.matches('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link]'))
      .filter((e) => {
        const cs = getComputedStyle(e)
        // A link inside a sentence is exempt; it is part of the text around it.
        const p = e.parentElement
        if (e.tagName === 'A' && cs.display === 'inline' && p && p.matches('p, li, td, dd, label, blockquote, figcaption, h1, h2, h3, h4, h5, h6, span') && (p.textContent || '').trim().length > (e.textContent || '').trim().length + 20) return false
        const r = e.getBoundingClientRect()
        return r.width < 44 || r.height < 44
      })
    if (taps.length) findings.push({ kind: 'tap targets', text: taps.length + ' control(s) smaller than 44px to tap', at: taps.slice(0, 4).map(short) })
  } else {
    const long = els.filter((e) => e.matches('p, li, blockquote, dd') && (e.textContent || '').length > 240).filter((e) => {
      const size = parseFloat(getComputedStyle(e).fontSize) || 16
      return e.getBoundingClientRect().width / (size * 0.5) > 95
    })
    if (long.length) findings.push({ kind: 'line length', text: long.length + ' paragraph(s) with lines over about 90 characters', at: long.slice(0, 3).map(short) })
  }

  // A broken image often draws nothing at all, so it is not required to be visible.
  const broken = [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.getAttribute('src'))
  if (broken.length) findings.push({ kind: 'broken image', text: broken.length + ' image(s) failed to load', at: broken.slice(0, 3).map((i) => (i.getAttribute('src') || short(i)).slice(0, 80)) })
  const loose = [...document.images].filter((i) => shown(i) && !(i.getAttribute('width') && i.getAttribute('height')) && getComputedStyle(i).aspectRatio === 'auto')
  if (loose.length) findings.push({ kind: 'layout shift', text: loose.length + ' image(s) without width and height, so the page jumps as they load', at: loose.slice(0, 3).map(short) })

  // The first screen as one frame, the way a visitor meets it: where it carries something and
  // where it is bare. Text counts where its letters are, not across the width of its box; a band
  // of plain colour across the page is ground, not content.
  const H = innerHeight
  const COLS = 24, ROWS = 16
  const grid = new Uint8Array(COLS * ROWS)
  const paint = (r) => {
    if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.top >= H || r.right <= 0 || r.left >= W) return
    const x0 = Math.max(0, Math.floor(r.left / W * COLS)), x1 = Math.min(COLS - 1, Math.floor((r.right - 1) / W * COLS))
    const y0 = Math.max(0, Math.floor(r.top / H * ROWS)), y1 = Math.min(ROWS - 1, Math.floor((r.bottom - 1) / H * ROWS))
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[y * COLS + x] = 1
  }
  for (const e of els) {
    const r = e.getBoundingClientRect()
    if (r.bottom <= 0 || r.top >= H) continue
    const cs = getComputedStyle(e)
    if (/^(img|svg|canvas|video|input|button|select|textarea|iframe)$/i.test(e.tagName) || /url\\(/.test(cs.backgroundImage)) { paint(r); continue }
    if (ownText(e)) {
      const range = document.createRange()
      for (const n of e.childNodes) if (n.nodeType === 3 && n.textContent.trim()) { range.selectNodeContents(n); for (const q of range.getClientRects()) paint(q) }
    }
    const boxed = cs.backgroundImage !== 'none' || !/rgba\\(\\d+, \\d+, \\d+, 0\\)|transparent/.test(cs.backgroundColor) || parseFloat(cs.borderTopWidth) > 0
    if (boxed && r.width < W * 0.85 && r.width * r.height < W * H * 0.5) paint(r)
  }
  const used = (x0, x1, y0, y1) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += grid[y * COLS + x]; return Math.round(n / ((x1 - x0) * (y1 - y0)) * 100) }
  // The halves are compared below the strip a navigation bar sits in, which spans both.
  const first = { all: used(0, COLS, 0, ROWS), left: used(0, COLS / 2, 2, ROWS), right: used(COLS / 2, COLS, 2, ROWS), top: used(0, COLS, 0, ROWS / 2), bottom: used(0, COLS, ROWS / 2, ROWS) }
  const frame = 'the first screen (' + W + ' by ' + H + ')'
  const goesOn = document.documentElement.scrollHeight > H * 1.2
  if (first.all < 10) findings.push({ kind: 'first screen', text: 'Only ' + first.all + '% of ' + frame + ' carries anything. A visitor meets a nearly bare frame: bring the main thing into it at a size that holds it', at: [] })
  else if (!phone && Math.min(first.left, first.right) < 12 && Math.max(first.left, first.right) >= 28) {
    const bare = first.left < first.right ? 'left' : 'right'
    findings.push({ kind: 'first screen', text: 'The ' + bare + ' half of ' + frame + ' is bare (' + first[bare] + '% used, the other half ' + Math.max(first.left, first.right) + '%). Compose the frame on purpose: bring the one move or the strongest image into that half, or set the layout so the space is a margin something sits against', at: [] })
  } else if (goesOn && first.bottom < 8 && first.top >= 20) findings.push({ kind: 'first screen', text: 'The lower half of ' + frame + ' is bare while the page goes on below it. Let the next thing show at the bottom edge, or fill the frame', at: [] })
  // A wide empty band between what sits above it and below it splits the frame in two.
  const bare = Array.from({ length: ROWS }, (_, y) => used(0, COLS, y, y + 1) === 0)
  let gap = 0, run = 0
  for (let y = bare.indexOf(false); y >= 0 && y <= bare.lastIndexOf(false); y++) { run = bare[y] ? run + 1 : 0; gap = Math.max(gap, run) }
  if (gap / ROWS >= 0.3) findings.push({ kind: 'first screen', text: 'A band about ' + Math.round(gap / ROWS * H) + 'px tall across ' + frame + ' is empty, with content above and below it, so the frame reads as two loose parts. Bring the groups together or let one of them grow into the space, unless the direction names that space as the point', at: [] })
  const sized = texts.map((e) => [e, parseFloat(getComputedStyle(e).fontSize) || 0, e.getBoundingClientRect().top])
  const inFrame = Math.max(0, ...sized.filter((x) => x[2] < H).map((x) => x[1]))
  const under = sized.filter((x) => x[2] >= H).sort((a, b) => b[1] - a[1])[0]
  if (under && under[1] >= 28 && under[1] > inFrame * 1.25) findings.push({ kind: 'first screen', text: 'The largest type on the page (' + Math.round(under[1]) + 'px) is below the first screen, where the largest is ' + Math.round(inFrame) + 'px. The strongest moment should not need a scroll to be seen', at: [short(under[0])] })
  const actions = els.filter((e) => e.matches('a[href], button, [role=button], input[type=submit]'))
  if (actions.length && !actions.some((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= H })) findings.push({ kind: 'first screen', text: 'No link or button shows on the first screen. The main action should be there without scrolling', at: actions.slice(0, 1).map(short) })

  const families = [...new Set(texts.map((e) => getComputedStyle(e).fontFamily.split(',')[0].replace(/["']/g, '').trim()))]
  const sizes = [...new Set(texts.map((e) => Math.round(parseFloat(getComputedStyle(e).fontSize))))].sort((a, b) => a - b)
  const colours = new Set()
  for (const e of els.slice(0, 1500)) {
    const cs = getComputedStyle(e)
    if (ownText(e)) colours.add(cs.color)
    if (!/rgba\\(\\d+, \\d+, \\d+, 0\\)|transparent/.test(cs.backgroundColor)) colours.add(cs.backgroundColor)
  }
  let spacings = 0, off = 0
  for (const e of els.slice(0, 1500)) {
    const cs = getComputedStyle(e)
    for (const p of ['marginTop', 'marginBottom', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'rowGap', 'columnGap']) {
      const v = parseFloat(cs[p])
      if (!(v > 2)) continue
      spacings++
      if (Math.round(v) % 4) off++
    }
  }
  // What makes a page read as machine made at a glance. Each is looked for the way an eye finds
  // it: by what is drawn, not by class names.
  const tells = []
  const seen = els.filter(shown).slice(0, 1500)
  const hue = (c) => {
    const m = c.match(/rgba?\\((\\d+), (\\d+), (\\d+)/)
    if (!m) return -1
    const [r, g, b] = [m[1] / 255, m[2] / 255, m[3] / 255], max = Math.max(r, g, b), d = max - Math.min(r, g, b)
    if (d < 0.15) return -1
    return Math.round(60 * (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4))
  }
  const grads = seen.filter((e) => /gradient\\(/.test(getComputedStyle(e).backgroundImage))
  const violet = grads.filter((e) => { const h = (getComputedStyle(e).backgroundImage.match(/rgba?\\([^)]+\\)/g) || []).map(hue).filter((x) => x >= 0); return h.length > 1 && h.every((x) => x >= 215 && x <= 310) })
  if (violet.length) tells.push('a purple to blue gradient (' + violet.slice(0, 2).map(short).join('; ') + ')')
  const filled = grads.filter((e) => /text/.test(getComputedStyle(e).webkitBackgroundClip || getComputedStyle(e).backgroundClip))
  if (filled.length) tells.push('gradient filled text (' + filled.slice(0, 2).map(short).join('; ') + ')')
  const pict = /^(\\p{Extended_Pictographic}|\\uFE0F|\\u200D|\\s)+/u
  const emoji = seen.filter((e) => ownText(e) && pict.test(e.textContent.trim()) && /\\p{Extended_Pictographic}/u.test(e.textContent))
  if (emoji.length > 1) tells.push(emoji.length + ' places use emoji as icons (' + emoji.slice(0, 2).map(short).join('; ') + ')')
  // Three or more boxes in a row with the same build: an icon, a heading, a line of text.
  const shape = (e) => e.tagName + '.' + [...e.classList].join('.') + ':' + [...e.children].map((c) => c.tagName).join(',')
  for (const p of seen) {
    const kids = [...p.children].filter(shown)
    if (kids.length < 3 || kids.length > 8) continue
    const top = kids[0].getBoundingClientRect().top
    const same = kids.every((k) => shape(k) === shape(kids[0]) && Math.abs(k.getBoundingClientRect().top - top) < 4)
    const card = (k) => k.querySelector('svg, img, i, [class*=icon]') && k.querySelector('h2, h3, h4, strong, b') && k.querySelector('p, span')
    if (same && kids.every(card) || same && kids.every((k) => pict.test(k.textContent.trim()) && k.querySelector('h2, h3, h4'))) { tells.push('a row of ' + kids.length + ' identical icon cards (' + short(p) + ')'); break }
  }
  const h1 = document.querySelector('h1')
  if (h1 && shown(h1)) {
    const prev = h1.previousElementSibling
    if (prev && shown(prev)) {
      const r = prev.getBoundingClientRect(), cs = getComputedStyle(prev)
      if (r.height < 44 && parseFloat(cs.borderTopLeftRadius) >= r.height / 2 - 1 && parseFloat(cs.fontSize) <= 14 && (cs.borderTopWidth !== '0px' || !/rgba\\(\\d+, \\d+, \\d+, 0\\)|transparent/.test(cs.backgroundColor))) tells.push('a pill badge above the headline (' + short(prev) + ')')
    }
    const hr = h1.getBoundingClientRect()
    if (!phone && getComputedStyle(h1).textAlign === 'center' && Math.abs(hr.left + hr.width / 2 - W / 2) < 8 && hr.top < innerHeight * 0.6) tells.push('a centred headline over a centred page, the default hero')
  }
  for (const h of document.querySelectorAll('h1, h2')) {
    if (!shown(h)) continue
    const base = getComputedStyle(h)
    const odd = [...h.querySelectorAll('span, em, i, strong, b, mark')].filter((x) => shown(x) && x.textContent.trim().split(/\\s+/).length <= 3)
    const tinted = odd.find((x) => getComputedStyle(x).color !== base.color || /gradient\\(/.test(getComputedStyle(x).backgroundImage))
    const slanted = odd.find((x) => getComputedStyle(x).fontStyle === 'italic' && getComputedStyle(x).fontFamily !== base.fontFamily)
    if (tinted) { tells.push('a word of a headline picked out in an accent colour (' + short(h) + ')'); break }
    if (slanted) { tells.push('an italic word in another typeface inside a headline (' + short(h) + ')'); break }
  }
  const stock = /^(inter|roboto|arial|helvetica|helvetica neue|system-ui|-apple-system|blinkmacsystemfont|segoe ui|ui-sans-serif|sans-serif|open sans|poppins)$/i
  if (families.length && families.every((f) => stock.test(f))) tells.push('only a default sans in use (' + families.slice(0, 2).join(', ') + '), chosen by no one')
  const radii = new Map()
  for (const e of seen) { const cs = getComputedStyle(e), r = parseFloat(cs.borderTopLeftRadius); if (r > 0 && r < 200 && (cs.borderTopWidth !== '0px' || cs.boxShadow !== 'none' || !/rgba\\(\\d+, \\d+, \\d+, 0\\)|transparent/.test(cs.backgroundColor))) radii.set(r, (radii.get(r) || 0) + 1) }
  const shadows = new Set(seen.map((e) => getComputedStyle(e).boxShadow).filter((x) => x !== 'none'))
  if (radii.size === 1 && [...radii.values()][0] >= 8 && shadows.size <= 1) tells.push('one radius' + (shadows.size ? ' and one shadow' : '') + ' on every box')
  const blobs = seen.filter((e) => { const cs = getComputedStyle(e), m = cs.filter.match(/blur\\((\\d+)/), r = e.getBoundingClientRect(); return m && +m[1] >= 30 && r.width > 120 && !ownText(e) })
  if (blobs.length) tells.push(blobs.length + ' blurred decorative shape(s) (' + blobs.slice(0, 2).map(short).join('; ') + ')')
  const filler = (document.body.innerText.match(/unlock the (full )?(power|potential)|supercharge|seamless(ly)?|revolutioni[sz]e|next[- ]generation|elevate your|to the next level|game[- ]chang|in today.s fast[- ]paced|cutting[- ]edge|effortless(ly)?|all[- ]in[- ]one (platform|solution)/gi) || [])
  if (filler.length) tells.push('stock phrases: ' + [...new Set(filler.map((x) => x.toLowerCase()))].slice(0, 4).join(', '))
  return { width: W, findings, families, sizes, colours: colours.size, offGrid: spacings ? Math.round((off / spacings) * 100) : 0, spacings, tells, first }
})()`

export const AXE_RUN = `axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] })
  .then((r) => r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, at: v.nodes.slice(0, 3).map((n) => String(n.target.join(' '))) })))`

const ORDER: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 }

export function report(target: string, views: Measured[], axe: Axe[] | null, errors: string[]): string {
  const lines = [`Audit of ${target}`]
  let n = 0
  // A problem already listed for an earlier width is not listed again, only noted.
  const seen = new Set<string>()
  const key = (f: Finding) => `${f.kind}|${f.at.join('|')}`
  for (const v of views) {
    const label = v.width < 600 ? `Phone, ${v.width}px` : `Desktop, ${v.width}px`
    const fresh = v.findings.filter((f) => !seen.has(key(f)))
    const repeated = v.findings.length - fresh.length
    const counted = fresh.length ? `${fresh.length} problem${fresh.length > 1 ? 's' : ''}` : v.findings.length ? 'nothing new' : 'no layout problems found'
    lines.push('', `${label}: ${counted}${repeated ? ` (${repeated} more also seen above)` : ''}`)
    for (const f of fresh) { seen.add(key(f)); lines.push(`${++n}. [${f.kind}] ${f.text}${f.at.length ? `: ${f.at.join('; ')}` : ''}`) }
    // Always stated, so the first screen is judged as a composition even when no rule trips.
    if (v.first) lines.push(`First screen: ${v.first.all}% of the frame carries content (left ${v.first.left}%, right ${v.first.right}%, top ${v.first.top}%, bottom ${v.first.bottom}%). Open the capture and check that the one move is in it.`)
  }
  if (axe) {
    const list = [...axe].sort((a, b) => (ORDER[a.impact ?? 'minor'] ?? 4) - (ORDER[b.impact ?? 'minor'] ?? 4))
    lines.push('', `Accessibility (axe-core, WCAG 2.2 AA): ${list.length ? `${list.length} rule${list.length > 1 ? 's' : ''} failing` : 'nothing failing'}`)
    for (const a of list.slice(0, 10)) lines.push(`${++n}. [${a.impact ?? 'minor'}] ${a.help} (${a.id}, ${a.nodes} element${a.nodes > 1 ? 's' : ''}): ${a.at.join('; ')}`)
  }
  const d = views[0]
  // Not faults a rule can settle, so they are named for the agent to decide on with its direction.
  if (d?.tells?.length) {
    lines.push('', `Reads as made by default (${d.tells.length}), the marks of work nobody directed. Unless the person or the project asked for one, replace it with a choice that comes from your direction:`)
    for (const t of d.tells) lines.push(`${++n}. [default] ${t}`)
  }
  if (d) {
    const notes = [
      `${d.families.length} font famil${d.families.length === 1 ? 'y' : 'ies'} (${d.families.slice(0, 5).join(', ')})${d.families.length > 3 ? ', more than three' : ''}`,
      `${d.sizes.length} font sizes (${d.sizes.join(', ')}px)${d.sizes.length > 9 ? ', too many for a clear type scale' : ''}`,
      `${d.colours} distinct text and background colours${d.colours > 16 ? ', a sign the palette has drifted' : ''}`,
      d.spacings ? `${d.offGrid}% of spacing values off a 4px grid${d.offGrid > 25 ? ', so check the spacing against its unit' : ''}` : '',
    ].filter(Boolean)
    lines.push('', `Design system in use on the desktop view, as observations to compare with the project's own system (not problems on their own): ${notes.join('; ')}.`)
  }
  lines.push('', errors.length ? `Console errors (${errors.length}): ${errors.slice(0, 4).join(' | ')}` : 'Console errors: none')
  lines.push('', n ? 'Fix the most serious problems first, then run expert_audit again to confirm.' : 'Nothing to fix from the measurements. Still look at the screenshots for what numbers cannot judge.')
  return lines.join('\n')
}

// The controls a person meets on the first screen, where states matter most: up to eight, in
// reading order, with their place on the page in CSS pixels.
export const CONTROLS = `(() => {
  const els = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [tabindex]:not([tabindex="-1"])')]
  return els.map((e) => {
    const r = e.getBoundingClientRect()
    const cs = getComputedStyle(e)
    const label = (e.getAttribute('aria-label') || e.textContent || e.getAttribute('placeholder') || e.tagName).trim().replace(/\\s+/g, ' ').slice(0, 40)
    return { x: r.left, y: r.top, w: r.width, h: r.height, label, ok: r.width > 4 && r.height > 4 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05 }
  }).filter((c) => c.ok).slice(0, 8)
})()`

// Where keyboard focus is now, in CSS pixels, or null when it is on the page itself.
export const FOCUSED = `(() => {
  const e = document.activeElement
  if (!e || e === document.body || e === document.documentElement) return null
  const r = e.getBoundingClientRect()
  const label = (e.getAttribute('aria-label') || e.textContent || e.getAttribute('placeholder') || e.tagName).trim().replace(/\\s+/g, ' ').slice(0, 40)
  return { x: r.left, y: r.top, w: r.width, h: r.height, label, inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && scrollY === 0 }
})()`

// Every short label made three times longer, the way real names, prices and translations grow.
export const STRETCH = `(() => {
  let n = 0
  for (const e of document.querySelectorAll('a, button, h1, h2, h3, h4, h5, label, th, td, li, dt, dd, figcaption, [role=button], [class*=badge], [class*=tag], [class*=chip], [class*=title], [class*=name]')) {
    for (const t of e.childNodes) {
      if (t.nodeType !== 3) continue
      const s = t.textContent.trim()
      if (s.length < 2 || s.length > 40) continue
      t.textContent = t.textContent.replace(s, [s, s, s].join(' '))
      n++
    }
  }
  return n
})()`
