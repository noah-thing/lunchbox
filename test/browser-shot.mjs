import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Two agents browse at the same moment, each in its own tab of the Browser page.
// node test/browser-shot.mjs
const root = new URL('..', import.meta.url).pathname
const out = root + 'test/shots/browser-'
mkdirSync(root + 'test/shots', { recursive: true })
const temp = (name) => mkdtempSync(join(tmpdir(), `lunchbox-${name}-`))
const bin = temp('bin')
chmodSync(root + 'test/fake-agent.mjs', 0o755)
for (const name of ['claude', 'codex', 'grok', 'gemini']) symlinkSync(root + 'test/fake-agent.mjs', `${bin}/${name}`)

const server = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<title>Pricing, read by ${req.url.slice(1)}</title><body style="font:16px system-ui;margin:64px;background:#f6f4ee"><h1>Pricing</h1><p>This page was opened by ${req.url.slice(1)}.</p><a href="/more">More</a>`))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${temp('profile')}`], cwd: root,
  env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_WORKSPACE: temp('work'), LUNCHBOX_PATH: `${bin}:${process.execPath.replace(/\/[^/]+$/, '')}:/usr/bin:/bin`, LUNCHBOX_PATH_ONLY: '1', FAKE_BROWSE: '9000' },
  timeout: 30000,
})
const kill = setTimeout(() => { console.log('timed out'); app.close().finally(() => process.exit(1)) }, 110000)
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h])
await size(1280, 800)
await page.waitForSelector('.onboard')
for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(i ? 900 : 2600) }
await page.waitForSelector('.newroom')
// Side by side sends the same message to both agents at once.
await page.click('.cbar >> text=Side by side')
await page.click('.composer textarea')
await page.keyboard.type(`Browse: ${base}`)
await page.keyboard.press('Enter')
await page.waitForSelector('.room')
await page.click('.sbitem >> text=Browser')
await page.waitForSelector('.btab >> nth=2', { timeout: 20000 })
await page.waitForTimeout(1200)
// The native page is drawn by the window, so the picture comes from the window itself.
const shot = async (name) => { const img = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64')); (await import('node:fs')).writeFileSync(`${out}${name}.png`, Buffer.from(img, 'base64')) }
await shot('1-two-agents')
const tabs = await page.$$eval('.btab', (els) => els.map((e) => e.textContent))
console.log('tabs:', tabs)
await page.click('.btab >> nth=2 >> button >> nth=0')
await page.waitForTimeout(600)
await shot('2-second-tab')
await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
await size(960, 640)
await page.waitForTimeout(600)
await shot('3-light-small')
await page.waitForTimeout(9000)
await page.click('.btab >> nth=1 >> .btabx')
await page.waitForTimeout(500)
await shot('4-after-close')
const state = await page.evaluate(() => window.lb.call('browser'))
console.log('after close:', state.tabs.map((t) => `${t.id.split(':')[1] ?? t.id} ${t.title}`), 'errors:', errors)
const said = await page.evaluate(() => window.lb.call('rooms').then((r) => window.lb.call('room', r[0].id)).then((r) => r.events.filter((e) => e.kind === 'say').map((e) => e.text)))
console.log('said:', said)
clearTimeout(kill)
await app.close()
server.close()
const ok = tabs.length === 3 && said.some((t) => /claude read: Pricing, read by claude/.test(t)) && said.some((t) => /codex read: Pricing, read by codex/.test(t)) && state.tabs.length === 1 && !errors.length
console.log(ok ? 'ok' : 'FAIL')
process.exit(ok ? 0 : 1)
