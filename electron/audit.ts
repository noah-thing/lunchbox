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
  return { width: W, findings, families, sizes, colours: colours.size, offGrid: spacings ? Math.round((off / spacings) * 100) : 0, spacings }
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
  }
  if (axe) {
    const list = [...axe].sort((a, b) => (ORDER[a.impact ?? 'minor'] ?? 4) - (ORDER[b.impact ?? 'minor'] ?? 4))
    lines.push('', `Accessibility (axe-core, WCAG 2.2 AA): ${list.length ? `${list.length} rule${list.length > 1 ? 's' : ''} failing` : 'nothing failing'}`)
    for (const a of list.slice(0, 10)) lines.push(`${++n}. [${a.impact ?? 'minor'}] ${a.help} (${a.id}, ${a.nodes} element${a.nodes > 1 ? 's' : ''}): ${a.at.join('; ')}`)
  }
  const d = views[0]
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
