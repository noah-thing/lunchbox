import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Counts what jumps in a room while a turn plays. A jump is anything already on screen that moves
// or changes height in a single frame and then stays there; a glide keeps moving the next frame.
// node test/flow-shot.mjs [prose|progress|consult|handoff|arena|subagents|showcase] [--shots] [--strict]
const root = new URL('..', import.meta.url).pathname
const scene = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'prose'
const shots = process.argv.includes('--shots')
const scenes = {
  prose: { say: 'Fix the date parser', script: 'prose', delay: '0', agents: ['claude'], ms: 12000, then: 'Now do the same for times', more: 12000 },
  progress: { say: 'Build the pricing page and test it', script: 'progress', delay: '0', agents: ['claude'], ms: 27000 },
  consult: { say: 'Consult: check the island renders', script: '', delay: '120', agents: ['claude', 'codex', 'grok'], ms: 22000 },
  handoff: { say: 'What do people say about agent limits?', script: '', delay: '60', agents: ['claude', 'grok'], ms: 16000 },
  showcase: { say: 'Our hackathon Build Night is in three weeks. Find out what people on X want from hackathons, write the announcement, design the banner and put up the event page.', script: 'showcase', delay: '12', agents: ['claude', 'codex', 'grok'], ms: 80000, env: { SHOWCASE_PACE: 'real', SHOWCASE_HOLD: '1500' } },
  arena: { say: 'Write a short note on agent limits', script: '', delay: '60', agents: ['claude', 'grok'], ms: 9000, click: '.pill.split' },
  subagents: { say: 'Audit the auth code', script: 'subagents', delay: '0', agents: ['claude'], ms: 12000 },
}
const s = scenes[scene]
if (!s) throw new Error(`no scene called ${scene}`)
const out = root + `test/shots/flow-${scene}-`
mkdirSync(root + 'test/shots', { recursive: true })
const temp = (name) => mkdtempSync(join(tmpdir(), `lunchbox-${name}-`))
const bin = temp('bin')
chmodSync(root + 'test/fake-agent.mjs', 0o755)
for (const n of s.agents) symlinkSync(root + 'test/fake-agent.mjs', `${bin}/${n}`)

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${temp('profile')}`], cwd: root,
  env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_WORKSPACE: temp('work'), LUNCHBOX_PATH: `${bin}:${process.execPath.replace(/\/[^/]+$/, '')}:/usr/bin:/bin`, LUNCHBOX_PATH_ONLY: '1', FAKE_DELAY: s.delay, FAKE_SCRIPT: s.script, ...(s.env ?? {}) },
  timeout: 30000,
})
const kill = setTimeout(() => { console.log('timed out'); app.close().finally(() => process.exit(1)) }, 110000 + s.ms)
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const [w, h] = (process.env.SIZE ?? '1200x800').split('x').map(Number)
await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h])
await page.waitForSelector('.onboard')
for (let i = 0; i < 30 && !(await page.locator('.newroom').count()); i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(700) }
await page.waitForSelector('.newroom')
if (s.click) await page.click(s.click)
await page.click('.composer textarea')
await page.keyboard.type(s.say)
await page.evaluate(() => {
  const flow = window.__flow = { jumps: [], gaps: [], trace: [] }
  window.__trace = new URLSearchParams(location.hash.slice(1)).get('trace')
  const WATCH = '.column > :not(.tail), .arenacol > *, .column > .ev > .evbody > *, .column .rich > *, .column .exchange > *, .convo .dock'
  const name = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`
  const sig = (el) => (el.matches('.rich > *') ? el.textContent.slice(0, 32) : '')
  let prev = new Map()
  let lastTop = 0
  let last = performance.now()
  const t0 = last
  // A move is judged three frames on: a glide has kept going by then, a jump has not. Frames are
  // not all the same length, so it is the distance covered that counts, not each step.
  let open = []
  const look = (now) => {
    flow.gaps.push(now - last)
    last = now
    const box = document.querySelector('.transcript')
    if (!box) return
    const top = box.scrollTop
    const t = Math.round(now - t0)
    if (top < lastTop - 0.5) flow.jumps.push({ t, kind: 'pulled', by: Math.round(top - lastTop), el: 'transcript' })
    lastTop = top
    const cur = new Map()
    const moved = new Map()
    if (window.__trace === 'scroll' && t >= window.__from && t < window.__to) {
      const col = box.firstElementChild
      flow.trace.push(`${t} top=${top.toFixed(1)} scroll=${box.scrollHeight} client=${box.clientHeight} column=${col.offsetHeight}x${col.offsetWidth} held=${col.style.minHeight}`)
    }
    for (const el of document.querySelectorAll(WATCH)) {
      const r = el.getBoundingClientRect()
      const inside = el.closest('.transcript')
      // What grew is uncovered from under the row it pushed: only the part in view counts.
      let bottom = r.bottom
      for (let up = el; up && up !== box; up = up.parentElement) {
        const cut = up.style.clipPath.match(/inset\(0(?:px)? 0(?:px)? ([\d.]+)px/)
        if (cut) bottom = Math.min(bottom, up.getBoundingClientRect().bottom - Number(cut[1]))
      }
      const at = { y: r.top + (inside ? top : 0), h: Math.max(0, bottom - r.top), sig: sig(el), seen: getComputedStyle(el).opacity !== '0' }
      cur.set(el, at)
      const was = prev.get(el)
      if (was && at.seen) moved.set(el, { moved: at.y - was.y, resized: at.h - was.h })
      if (window.__trace && window.__trace !== 'scroll' && t >= window.__from && t < window.__to && el.matches(window.__trace)) flow.trace.push(`${t} ${name(el).slice(0, 30)} y=${at.y.toFixed(1)} h=${at.h.toFixed(1)} lay=${el.offsetTop} tr=${el.style.translate} ${JSON.stringify(el.textContent.slice(0, 24))}`)
    }
    open = open.filter((o) => {
      const d = moved.get(o.el)?.[o.kind] ?? 0
      if (Math.sign(d) === Math.sign(o.by)) o.sum += Math.abs(d)
      if (++o.age < 3) return true
      if (o.sum < Math.abs(o.by) * 0.8) flow.jumps.push({ t: o.t, kind: o.kind, by: Math.round(o.by), el: name(o.el), text: o.el.textContent.slice(0, 40) })
      o.el.__open = ''
      return false
    })
    for (const [el, d] of moved) {
      // Only a box that can be seen counts as resized: a row is as tall as what is in it.
      const boxed = el.matches('.rich > *, .mine, .acts, .term, .subs, .xsearch, .decide, .dock')
      for (const [kind, limit] of [['moved', 3], ['resized', 30]]) {
        if (kind === 'resized' && !boxed) continue
        const by = d[kind]
        const key = `${kind}${Math.sign(by)}`
        const was = el.__step?.[key] ?? 0
        // A step much larger than the last one is a new move, even in the middle of a glide.
        if (Math.abs(by) > limit && (el.__open !== key || Math.abs(by) > was * 2.5 + 3)) { open.push({ el, t, kind, by, sum: 0, age: 0 }); el.__open = key }
        el.__step = { ...(el.__step ?? {}), [key]: Math.abs(by), [`${kind}${-Math.sign(by)}`]: 0 }
      }
    }
    // A row swapped for another that says the same thing must stand where the first one stood.
    const gone = [...prev].filter(([el]) => !cur.has(el) && prev.get(el).sig)
    for (const [el, at] of cur) {
      if (prev.has(el) || !at.sig) continue
      const old = gone.find(([, g]) => g.sig === at.sig)
      if (old && Math.abs(old[1].y - at.y) > 1) flow.jumps.push({ t, kind: 'swapped', by: Math.round(at.y - old[1].y), el: name(el), text: at.sig })
    }
    prev = cur
  }
  // Read after layout, once the room has made its own corrections for the frame: that is what gets
  // painted. A probe that changes size every frame brings the observer round each time.
  const probe = document.body.appendChild(document.createElement('i'))
  probe.style.cssText = 'position:fixed;left:0;top:0;height:1px;opacity:0;pointer-events:none'
  let n = 0
  const beat = () => { probe.style.width = `${1 + (n++ % 2)}px`; requestAnimationFrame(beat) }
  const start = () => {
    if (!document.querySelector('.transcript .column')) return requestAnimationFrame(start)
    new ResizeObserver(() => look(performance.now())).observe(probe)
    beat()
  }
  start()
})
if (process.env.TRACE) await page.evaluate(([sel, from, to]) => { window.__trace = sel; window.__from = from; window.__to = to }, [process.env.TRACE, ...(process.env.TRACE_AT ?? '0-600').split('-').map(Number)])
await page.keyboard.press('Enter')
const t0 = Date.now()
if (shots) for (const [k, at] of (process.env.AT ?? '').split(',').filter(Boolean).map(Number).entries()) {
  await page.waitForTimeout(Math.max(0, t0 + at - Date.now()))
  await page.screenshot({ path: `${out}${k}-${at}.png`, scale: 'css' })
}
await page.waitForTimeout(Math.max(0, t0 + s.ms - Date.now()))
// A second message: the room already holds a finished turn when the next one starts.
if (s.then) {
  await page.click('.composer textarea')
  await page.keyboard.type(s.then)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(s.more)
}
if (shots) await page.screenshot({ path: `${out}end.png`, scale: 'css' })
const { jumps, gaps, trace } = await page.evaluate(() => window.__flow)
for (const l of trace) console.log(l)
const sorted = [...gaps].sort((a, b) => a - b)
const pct = (p) => sorted[Math.floor(sorted.length * p)].toFixed(1)
const kinds = {}
for (const j of jumps) kinds[j.kind] = (kinds[j.kind] ?? 0) + 1
console.log(`${scene}: ${jumps.length} jumps`, JSON.stringify(kinds))
if (!process.argv.includes('--quiet')) for (const j of jumps) console.log(`  ${String(j.t).padStart(6)}ms ${j.kind.padEnd(8)} ${String(j.by).padStart(5)}px  ${j.el.slice(0, 44).padEnd(44)} ${JSON.stringify(j.text ?? '')}`)
console.log(`frames ${gaps.length}, median ${pct(0.5)}ms, p95 ${pct(0.95)}ms, p99 ${pct(0.99)}ms, max ${sorted[sorted.length - 1].toFixed(0)}ms, over 50ms: ${gaps.filter((x) => x > 50).length}`)
console.log('errors:', errors)
clearTimeout(kill)
await app.close()
if (process.argv.includes('--strict') && (jumps.length || errors.length)) process.exit(1)
