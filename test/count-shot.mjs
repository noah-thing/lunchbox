import { _electron as electron } from 'playwright-core'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The anonymous count, silent: one ping with four fields and nothing on screen, none again the
// same day, none at all once turned off, and no error when the server cannot be reached.
// node test/count-shot.mjs
const root = new URL('..', import.meta.url).pathname
mkdirSync(root + 'test/shots', { recursive: true })
const temp = (name) => mkdtempSync(join(tmpdir(), `lunchbox-${name}-`))
const pings = []
const server = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => { pings.push(JSON.parse(b)); res.writeHead(204); res.end() }) })
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const url = `http://127.0.0.1:${server.address().port}/v1/ping`
const bin = temp('bin')
chmodSync(root + 'test/fake-agent.mjs', 0o755)
symlinkSync(root + 'test/fake-agent.mjs', `${bin}/claude`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const launch = async (profile, statsUrl = url) => {
  const app = await electron.launch({
    executablePath: createRequire(import.meta.url)('electron'), args: ['.', `--user-data-dir=${profile}`], cwd: root,
    env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_WORKSPACE: temp('work'), LUNCHBOX_PATH: `${bin}:${process.execPath.replace(/\/[^/]+$/, '')}:/usr/bin:/bin`, LUNCHBOX_PATH_ONLY: '1', LUNCHBOX_STATS_URL: statsUrl },
    timeout: 30000,
  })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  return { app, page, errors }
}
const onboard = async (page) => {
  await page.waitForSelector('.onboard')
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(i ? 900 : 2600) }
  await page.waitForSelector('.newroom')
}
const popups = (page) => page.locator('.ntoast, .scrim, .nbanner').count()

const a = temp('profile-a')
let s = await launch(a)
await onboard(s.page)
await wait(4000)
console.log('1. pings:', pings.length, JSON.stringify(pings[0]), '| keys:', Object.keys(pings[0] ?? {}).join(','), '| popups on screen:', await popups(s.page))
await s.app.close()
s = await launch(a)
await s.page.waitForSelector('.newroom')
await wait(4000)
console.log('2. relaunch same day, pings in total:', pings.length)
// The next day: the last day sent is moved back, then the switch is turned off in Settings.
await s.page.evaluate(() => window.lb.call('settings:set', { countDay: '2000-01-01' }))
await s.page.click('.sbitem:has-text("Settings")')
await s.page.waitForSelector('.setting:has-text("Anonymous count")')
await s.page.locator('.setting:has-text("Anonymous count") .toggle').click()
await s.page.locator('.setting:has-text("Anonymous count")').screenshot({ path: root + 'test/shots/count-setting.png' })
const off = await s.page.locator('.setting:has-text("Anonymous count") .toggle').getAttribute('aria-checked')
await s.app.close()
const before = pings.length
s = await launch(a)
await s.page.waitForSelector('.newroom')
await wait(4000)
console.log('3. switch on:', off, '| pings after turning off, on a new day:', pings.length - before)
await s.app.close()

// A server that cannot be reached: nothing on screen, nothing in the console.
s = await launch(temp('profile-b'), 'http://127.0.0.1:9/v1/ping')
await onboard(s.page)
await wait(5000)
console.log('4. unreachable server, popups:', await popups(s.page), '| console errors:', s.errors.filter((e) => /ping|count|stats|fetch/i.test(e)))
await s.app.close()
server.close()
