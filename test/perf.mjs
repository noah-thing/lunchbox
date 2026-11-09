import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Frame timing for the moments that should feel instant: opening search, moving between pages,
// opening a site, a room while agents work, and the app sitting idle. node test/perf.mjs [label]
const label = process.argv[2] ?? 'run'
const only = process.argv[3]
const want = (part) => !only || only.split(',').includes(part)
const root = new URL('..', import.meta.url).pathname
const temp = (name) => mkdtempSync(join(tmpdir(), `lunchbox-${name}-`))
const bin = temp('bin')
const work = temp('work')
writeFileSync(join(work, 'notes.md'), '# Notes\n')
chmodSync(root + 'test/fake-agent.mjs', 0o755)
for (const name of ['claude', 'codex', 'grok']) symlinkSync(root + 'test/fake-agent.mjs', `${bin}/${name}`)

// A heavy local page, so opening a site measures the app and not the network.
const site = createServer((_, res) => {
  res.setHeader('content-type', 'text/html')
  res.end(`<title>Probe</title><style>body{font:16px system-ui;margin:40px}</style>${Array.from({ length: 400 }, (_, i) => `<p>Paragraph ${i} <a href="#${i}">link</a> <img width=40 height=40></p>`).join('')}`)
}).listen(0)
const port = site.address().port

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${temp('profile')}`], cwd: root,
  env: { ...process.env, LB_WORKSPACE: work, LUNCHBOX_PATH: `${bin}:${process.env.PATH}`, FAKE_DELAY: '60' },
  timeout: 30000,
})
const kill = setTimeout(() => { console.log('timed out'); app.close().finally(() => process.exit(1)) }, 115000)
const page = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))

await page.waitForSelector('.onboard')
for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(i ? 900 : 2600) }
await page.waitForSelector('.newroom')
await page.waitForTimeout(800)

await page.evaluate(() => {
  const w = window
  w.__perf = { frames: [], long: [], on: false }
  new PerformanceObserver((l) => { if (w.__perf.on) for (const e of l.getEntries()) w.__perf.long.push(e.duration) }).observe({ type: 'longtask', buffered: false })
  let prev = 0
  const tick = (t) => { if (w.__perf.on && prev) w.__perf.frames.push(t - prev); prev = t; requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
})

const cpu = async () => app.evaluate(({ app }) => app.getAppMetrics().reduce((s, m) => s + m.cpu.percentCPUUsage, 0))
const results = []
async function measure(name, act, settle = 900) {
  await page.evaluate(() => { window.__perf.frames = []; window.__perf.long = []; window.__perf.on = true })
  const t0 = Date.now()
  await act()
  await page.waitForTimeout(settle)
  const r = await page.evaluate(() => { window.__perf.on = false; return { f: window.__perf.frames, l: window.__perf.long } })
  const f = r.f.filter((d) => d < 1000)
  const sorted = [...f].sort((a, b) => a - b)
  results.push({
    scenario: name,
    ms: Date.now() - t0,
    frames: f.length,
    dropped: f.filter((d) => d > 25).length,
    worst: Math.round(sorted.at(-1) ?? 0),
    p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    longTasks: r.l.length,
    longMs: Math.round(r.l.reduce((s, d) => s + d, 0)),
  })
}

await measure('idle, new room (3 s)', () => page.waitForTimeout(3000), 0)
const idleCpu = await (async () => { await cpu(); await page.waitForTimeout(2000); return Math.round(await cpu()) })()

if (want('search')) {
  for (let i = 0; i < 3; i++) {
    await measure(`open search #${i + 1}`, () => page.click('.sbitem:has-text("Search")'), 700)
    await measure(`close search #${i + 1}`, () => page.keyboard.press('Escape'), 600)
  }
  await measure('type in search', () => page.keyboard.press('Meta+k').then(() => page.keyboard.type('flows', { delay: 40 })), 500)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
}

if (want('pages')) {
  for (const name of ['Flows', 'Pool', 'Library', 'Settings', 'Agents', 'New room']) {
    await measure(`go to ${name}`, () => page.click(`.sbitem:has-text("${name}")`), 800)
  }
}

if (want('browser')) {
await page.click('.sbitem:has-text("Browser")')
await page.waitForTimeout(800)
await measure('open a site', async () => {
  await page.fill('.bstartform input', `localhost:${port}`)
  await page.keyboard.press('Enter')
  await page.waitForSelector('.addr', { timeout: 10000 })
}, 1500)
await measure('switch to phone', () => page.click('.seg button:has-text("Phone")'), 1200)
await measure('switch to desktop', () => page.click('.seg button:has-text("Desktop")'), 1200)
await measure('leave browser', () => page.click('.sbitem:has-text("Pool")'), 800)
await measure('back to browser', () => page.click('.sbitem:has-text("Browser")'), 800)
}

if (want('room')) {
await page.click('.sbitem:has-text("New room")')
await page.waitForTimeout(600)
await page.click('.composer textarea')
await page.keyboard.type('Find out what people think of agent limits and build a page about it')
await measure('room while agents work', async () => {
  await page.keyboard.press('Enter')
  await page.waitForSelector('.room')
  await page.waitForTimeout(4000)
}, 0)
const busyCpu = Math.round(await cpu())
await page.waitForSelector('.decide', { timeout: 30000 }).catch(() => {})
await measure('room idle with panel (3 s)', () => page.waitForTimeout(3000), 0)
const roomCpu = await (async () => { await cpu(); await page.waitForTimeout(2000); return Math.round(await cpu()) })()
console.log(`CPU %, all processes: room working ${busyCpu}, room idle ${roomCpu}`)
}

console.log(`\n${label}`)
console.table(results)
console.log(`CPU %, all processes, idle on the new room page: ${idleCpu}`)
clearTimeout(kill)
site.close()
await app.close()
