import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Walks the app's transitions and measures each one frame by frame: what moved more than a few
// pixels in one frame with no animation on it, what appeared or left with none, layout shift, and
// lists that grew a scrollbar. Frames are saved mid transition to look at.
// node test/motion.mjs   (npm run build first; W=900 for a narrow window, DAY=1, OUT=dir, ONLY=name)
const root = new URL('..', import.meta.url).pathname
const out = (process.env.OUT ?? root + 'test/shots/motion') + '/'
mkdirSync(out, { recursive: true })
const temp = (name) => mkdtempSync(join(tmpdir(), `lunchbox-${name}-`))
const bin = temp('bin')
chmodSync(root + 'test/fake-agent.mjs', 0o755)
for (const name of ['claude', 'codex', 'grok']) symlinkSync(root + 'test/fake-agent.mjs', `${bin}/${name}`)
const W = Number(process.env.W ?? 1440), H = Number(process.env.H ?? 900)

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${temp('profile')}`], cwd: root,
  env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_WORKSPACE: temp('work'), LB_REPORT_ENDPOINT: 'http://127.0.0.1:9/report', LUNCHBOX_PATH: `${bin}:${process.execPath.replace(/\/[^/]+$/, '')}:/usr/bin:/bin`, LUNCHBOX_PATH_ONLY: '1', FAKE_DELAY: process.env.FAKE_DELAY ?? '60' },
  timeout: 30000,
})
const kill = setTimeout(() => { console.log('timed out'); app.close().finally(() => process.exit(1)) }, 420000)
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h])
await size(W, H)

// The recorder lives in the page so it sees every frame. Each frame it reads the box of every
// element; one that moved or resized with no animation on it or above it is a snap.
const probe = () => {
  if (window.__motion) return
  const ids = new WeakMap()
  let n = 0
  const name = (el) => {
    const one = (e) => e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).slice(0, 3).join('.') : '')
    const up = []
    for (let e = el; e && e !== document.body && up.length < 3; e = e.parentElement) up.unshift(one(e))
    return up.join(' > ')
  }
  const m = window.__motion = { shifts: [], on: false, frames: 0, snaps: [], pops: [], gone: [], bars: [] }
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) m.shifts.push({ at: Math.round(e.startTime - m.t0), value: +e.value.toFixed(4), sources: (e.sources ?? []).map((s) => ({ el: s.node?.nodeType === 1 ? name(s.node) : s.node?.parentElement ? name(s.node.parentElement) + ' #text' : '?', from: [s.previousRect.x, s.previousRect.y, s.previousRect.width, s.previousRect.height].map(Math.round).join(','), to: [s.currentRect.x, s.currentRect.y, s.currentRect.width, s.currentRect.height].map(Math.round).join(',') })) })
  }).observe({ type: 'layout-shift', buffered: false })
  const moving = () => {
    const set = new Set()
    for (const a of document.getAnimations()) { const t = a.effect?.target; if (t && a.playState === 'running') set.add(t) }
    return set
  }
  const animated = (el, set) => { for (let e = el; e; e = e.parentElement) if (set.has(e)) return true; return false }
  const bars = () => [...document.querySelectorAll('*')].filter((e) => { const o = getComputedStyle(e).overflowY; return (o === 'auto' || o === 'scroll') && e.offsetWidth - e.clientWidth > 2 }).map(name)
  m.start = (ms) => {
    Object.assign(m, { shifts: [], snaps: [], pops: [], gone: [], frames: 0, t0: performance.now(), on: true, before: bars() })
    let last = new Map()
    const tick = () => {
      const t = Math.round(performance.now() - m.t0)
      const set = moving()
      const now = new Map()
      const jumped = new Set(), fresh = new Set()
      for (const el of document.body.querySelectorAll('*')) {
        if (el.closest('svg') && el.tagName !== 'svg') continue
        const r = el.getBoundingClientRect()
        if (!r.width && !r.height) continue
        if (!ids.has(el)) ids.set(el, ++n)
        const id = ids.get(el)
        now.set(id, { el, r })
        const was = last.get(id)
        if (m.frames && !was) { if (!fresh.has(el.parentElement)) { if (r.width * r.height > 60) m.pops.push({ at: t, el: name(el), box: [r.left, r.top, r.width, r.height].map(Math.round).join(','), animated: animated(el, set), opacity: getComputedStyle(el).opacity }) } fresh.add(el) }
        if (was) {
          const d = [r.left - was.r.left, r.top - was.r.top, r.width - was.r.width, r.height - was.r.height].map(Math.round)
          if (d.some((v) => Math.abs(v) >= 3)) {
            // The topmost element that moved speaks for everything inside it.
            if (!jumped.has(el.parentElement) && !animated(el, set) && r.bottom > 0 && r.top < innerHeight) m.snaps.push({ at: t, el: name(el), d: d.join(','), box: [r.left, r.top, r.width, r.height].map(Math.round).join(',') })
            jumped.add(el)
          }
        }
      }
      if (m.frames) for (const [id, was] of last) if (!now.has(id) && !was.el.isConnected && was.el.parentElement === null) {}
      if (m.frames) {
        const left = []
        for (const [id, was] of last) if (!now.has(id)) left.push(was)
        const set2 = new Set(left.map((x) => x.el))
        for (const x of left) if (!set2.has(x.el.parentElement) && x.r.width * x.r.height > 400) m.gone.push({ at: t, el: name(x.el), box: [x.r.left, x.r.top, x.r.width, x.r.height].map(Math.round).join(','), leaving: /leaving|closing/.test(String(x.el.className)) || x.faded })
      }
      for (const [, v] of now) v.faded = parseFloat(getComputedStyle(v.el).opacity) < 0.2 && animated(v.el, set)
      last = now
      m.frames++
      if (performance.now() - m.t0 < ms && m.on) requestAnimationFrame(tick)
      else { m.on = false; m.after = bars() }
    }
    tick()
  }
}

const log = []
const only = process.env.ONLY
// One transition: start the recorder, do the thing, save frames on the way, then read what moved.
const step = async (name, act, { ms = 700, shots = [50, 130, 260], quiet = [] } = {}) => {
  if (only && !name.includes(only)) return act()
  await page.evaluate(probe)
  await page.evaluate((ms) => window.__motion.start(ms), ms)
  const t0 = Date.now()
  await act()
  for (const t of shots) {
    const wait = t - (Date.now() - t0)
    if (wait > 0) await page.waitForTimeout(wait)
    await page.screenshot({ path: `${out}${name}-${String(t).padStart(4, '0')}.png` }).catch(() => {})
  }
  const rest = ms + 120 - (Date.now() - t0)
  if (rest > 0) await page.waitForTimeout(rest)
  await page.waitForFunction(() => !window.__motion.on, null, { timeout: 5000 }).catch(() => {})
  const m = await page.evaluate(() => { const { shifts, snaps, pops, gone, frames, before, after } = window.__motion; return { shifts, snaps, pops, gone, frames, before, after } })
  await page.screenshot({ path: `${out}${name}-end.png` }).catch(() => {})
  const skip = (x) => quiet.some((q) => x.el.includes(q))
  const shift = m.shifts.reduce((a, s) => a + s.value, 0)
  const snaps = m.snaps.filter((x) => !skip(x))
  const pops = m.pops.filter((x) => !x.animated && !skip(x))
  const gone = m.gone.filter((x) => !x.leaving && !skip(x))
  const bars = m.after.filter((b) => !m.before.includes(b))
  log.push({ name, frames: m.frames, shift, shifts: m.shifts, snaps, pops, gone, bars })
  console.log(`\n== ${name}  (${m.frames} frames)  shift ${shift.toFixed(4)}  snaps ${snaps.length}  pops ${pops.length}  gone ${gone.length}${bars.length ? '  NEW SCROLLBAR ' + bars.join(' | ') : ''}`)
  const few = (list, f) => { const seen = new Map(); for (const x of list) { const k = x.el; if (!seen.has(k)) seen.set(k, { ...x, n: 0 }); seen.get(k).n++ } [...seen.values()].slice(0, 8).forEach((x) => console.log('   ' + f(x))) }
  for (const s of m.shifts.filter((s) => s.value >= 0.0005).slice(0, 4)) console.log(`   shift ${s.value} at ${s.at}ms: ${s.sources.slice(0, 3).map((x) => `${x.el} [${x.from} -> ${x.to}]`).join('; ')}`)
  few(snaps, (x) => `snap  ${x.at}ms x${x.n} ${x.el}  d=${x.d}  box=${x.box}`)
  few(pops, (x) => `pop   ${x.at}ms ${x.el}  box=${x.box}`)
  few(gone, (x) => `gone  ${x.at}ms ${x.el}  box=${x.box}`)
}
const key = (k) => () => page.keyboard.press(k)
const click = (sel) => () => page.click(sel)
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

try {
  await page.waitForSelector('.onboard')
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(i ? 900 : 2600) }
  await page.waitForSelector('.newroom')
  if (process.env.DAY) await page.evaluate(() => { localStorage.setItem('lb.theme', '"light"'); location.reload() }).then(() => page.waitForSelector('.newroom'))
  await page.waitForTimeout(1500)

  // New room: every menu, open and shut.
  const crew = '[aria-label="Agents in this room"]'
  await step('01-crew-open', click(crew))
  await step('02-crew-model', click('.crewrow .modelchip >> nth=0'))
  await step('03-crew-model-back', click('.modelhead'))
  await step('04-crew-add-agent', click('.crewrow:not(.checked) .item >> nth=0'))
  await step('05-crew-close', key('Escape'))
  await step('06-mode-open', click('[aria-label^="Mode:"]'))
  await step('07-mode-pick', click('.menu .item >> nth=1'))
  await step('08-folder-open', click('[aria-label="Where the room works"]'))
  await step('09-folder-close', key('Escape'))
  await step('10-packs-open', click('[aria-label="More packs"]'))
  await step('11-packs-pick', click('.packmenu .menu .item >> nth=0'))
  await step('12-pack-general', click('.newmeta .chip >> nth=0'))
  await step('13-pack-chip', click('.newmeta .chip >> nth=1'))
  await page.click('.newmeta .chip >> nth=0')
  await step('14-expert-on', click('.pill.expert'))
  await step('15-expert-off', click('.pill.expert'))
  if (await page.$('.pill.split')) { await step('16-side-on', click('.pill.split')); await step('17-side-off', click('.pill.split')) }

  // The message box: the two lists, growing, an idea put in.
  await page.click('.composer textarea')
  await step('20-slash', () => page.keyboard.type('/'))
  await step('21-slash-filter', () => page.keyboard.type('pl'))
  await step('22-slash-escape', key('Escape'))
  await page.fill('.composer textarea', '')
  await step('23-at', () => page.keyboard.type('@'))
  await step('24-at-pick', key('Enter'))
  await page.fill('.composer textarea', '')
  await step('25-grow', async () => { await page.keyboard.type('One'); for (let i = 0; i < 5; i++) { await page.keyboard.press('Shift+Enter'); await page.keyboard.type('more') } }, { ms: 900 })
  await step('26-shrink', () => page.fill('.composer textarea', ''))
  await step('27-idea', click('.ideas button >> nth=0'))
  await page.fill('.composer textarea', '')

  // Search, and a room's right click menu later.
  await step('30-palette-open', key(`${mod}+k`))
  await step('31-palette-type', () => page.keyboard.type('set'))
  await step('32-palette-close', key('Escape'))

  // A first room: the page gives way to the room, the reply streams, a crewmate is asked.
  await page.click('.composer textarea')
  await page.keyboard.type('Write a short note on agent limits')
  await step('40-send-first', key('Enter'), { ms: 2400, shots: [60, 160, 320, 600, 1000, 1600] })
  await step('41-streaming', async () => {}, { ms: 3000, shots: [300, 900, 1500, 2400] })
  await step('42-handoff', async () => {}, { ms: 3000, shots: [300, 900, 1500, 2400] })
  await page.waitForFunction(() => !document.querySelector('.send.stop'), null, { timeout: 40000 }).catch(() => {})
  await step('43-settled', async () => {}, { ms: 1200, shots: [300] })

  // In the room.
  await step('50-panel-toggle', click('[aria-label="Room panel"]'), { ms: 1000, shots: [60, 200, 400, 700] })
  await step('51-panel-toggle-back', click('[aria-label="Room panel"]'), { ms: 1000, shots: [60, 200, 400, 700] })
  await step('52-roommenu-open', click('[aria-label="Room actions"]'))
  await step('53-roommenu-rename', click('.menu .item:has-text("Rename")'))
  await step('54-rename-done', key('Escape'))
  await step('55-find-open', key(`${mod}+f`))
  await step('56-find-type', () => page.keyboard.type('limits'))
  await step('57-find-close', key('Escape'))
  await page.hover('.ev .rich >> nth=0').catch(() => {})
  await step('58-msgtools', () => page.hover('.ev .rich >> nth=0').catch(() => {}))
  if (await page.$('.ev .msgtools .menuwrap button')) {
    await step('59-review-menu', () => page.click('.ev .msgtools .menuwrap button >> nth=0').catch(() => {}))
    await page.keyboard.press('Escape')
  }
  if (await page.$('.actsum')) { await step('60-acts-open', click('.actsum >> nth=0')); await step('61-acts-close', click('.actsum >> nth=0')) }
  await page.click('.composer textarea')
  await step('62-room-slash', () => page.keyboard.type('/'))
  await page.keyboard.press('Escape')
  await page.fill('.composer textarea', '')
  await page.keyboard.type('And a second question about the same thing')
  await step('63-send-second', key('Enter'), { ms: 2600, shots: [50, 120, 240, 500, 1000, 1800] })
  await step('64-second-streams', async () => {}, { ms: 2600, shots: [400, 1200, 2000] })
  await page.waitForFunction(() => !document.querySelector('.send.stop'), null, { timeout: 40000 }).catch(() => {})
  await page.waitForTimeout(800)
  await page.keyboard.type('A third that gets stopped')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.send.stop', { timeout: 10000 }).catch(() => {})
  await page.waitForTimeout(700)
  await step('65-stop', () => page.click('.send.stop').catch(() => {}), { ms: 1600, shots: [50, 150, 400, 900] })
  await page.waitForFunction(() => !document.querySelector('.send.stop'), null, { timeout: 40000 }).catch(() => {})
  await step('66-crew-open-room', click(crew))
  await step('67-crew-close-room', key('Escape'))

  // Pages, there and back.
  for (const [i, label] of ['Flows', 'Pool', 'Savings', 'Library', 'Browser', 'Workshop', 'Agents', 'Settings'].entries()) {
    await step(`7${i}-page-${label.toLowerCase()}`, click(`.sbitem >> text=${label}`), { ms: 900, shots: [40, 120, 300] })
  }
  await page.click('.sbitem >> text=Flows')
  await page.waitForTimeout(500)
  await step('77b-flow-edit', click('.tcard >> nth=0'), { ms: 900 })
  await step('77c-flow-edit-back', key('Escape'), { ms: 900 })
  await page.click('.sbitem >> text=Library')
  await page.waitForTimeout(500)
  for (const i of [1, 2, 3, 0]) await step(`77d-library-tab-${i}`, () => page.click(`.tabs button >> nth=${i}`).catch(() => {}), { ms: 700 })
  await step('77e-playbook-open', click('.cards .card >> nth=0'))
  await step('77f-playbook-close', () => page.mouse.click(260, 500))
  await step('77g-import-open', click('.sbimport'))
  await step('77h-import-close', () => page.mouse.click(260, 500))
  await step('77i-report-open', click('.sbbeta'))
  await step('77j-report-close', () => page.mouse.click(260, 500))
  await step('78-room-open', click('.sbroom >> nth=0'), { ms: 900, shots: [30, 80, 160, 300] })
  await step('79-newroom', click('.sbitem >> text=New room'), { ms: 900 })
  await page.click('.composer textarea')
  await page.keyboard.type('A second room')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.room')
  await page.waitForFunction(() => !document.querySelector('.send.stop') && document.querySelectorAll('.sbroom').length > 1, null, { timeout: 40000 }).catch(() => {})
  await page.waitForTimeout(1000)
  await step('80-room-switch', click('.sbroom >> nth=1'), { ms: 900, shots: [30, 80, 160, 300] })
  await step('81-room-switch-back', click('.sbroom >> nth=0'), { ms: 900, shots: [30, 80, 160, 300] })
  await step('82-room-rightclick', () => page.click('.sbroom >> nth=1', { button: 'right' }))
  await step('83-room-archive', click('.menu.ctx .item >> nth=1'), { ms: 3400, shots: [60, 200, 500, 2700, 3100] })
  if (await page.$('.sbarchived')) await step('84-archived-show', click('.sbarchived'))

  // Settings: segmented controls, toggles, the theme.
  await page.click('.sbitem >> text=Settings')
  await page.waitForTimeout(600)
  const toggles = await page.$$('.page [role=switch]')
  if (toggles[1]) { await step('90-toggle', () => toggles[1].click()); await toggles[1].click() }
  await step('91-seg-square', click('.seg button:has-text("Square")'), { ms: 900 })
  await step('92-seg-lunchbox', click('.seg button:has-text("Lunchbox")'), { ms: 900 })
  await step('93-theme-day', click('.seg button:has-text("Day")'), { ms: 1100, shots: [80, 250, 450, 700] })
  await step('94-theme-night', click('.seg button:has-text("Night")'), { ms: 1100, shots: [80, 250, 450, 700] })
  if (await page.$('.themecard')) { await step('95-theme-card', click('.themecard >> nth=1'), { ms: 1100, shots: [80, 250, 450, 700] }); await page.click('.themecard >> nth=0'); await page.waitForTimeout(800) }
  await step('96-settings-scroll', () => page.evaluate(() => document.querySelector('.page')?.scrollTo({ top: 99999 })), { ms: 500 })
  await page.click('.sbitem >> text=Agents')
  await page.waitForTimeout(600)
  await step('97-agent-open', click('.agenthead >> nth=0'), { ms: 800 })
  await step('98-agent-close', click('.agenthead >> nth=0'), { ms: 800 })

  // The window itself.
  await page.click('.sbroom >> nth=0')
  await page.waitForTimeout(700)
  await step('99-resize-narrow', () => size(900, 620), { ms: 900 })
  await step('99b-resize-wide', () => size(W, H), { ms: 900 })
} catch (e) { errors.push(String(e)); console.log('stopped early:', String(e).split('\n')[0]) }

writeFileSync(out + 'report.json', JSON.stringify(log, null, 1))
console.log('\nerrors', errors.length ? errors.join('\n') : 'none')
clearTimeout(kill)
await app.close()
process.exit(0)
