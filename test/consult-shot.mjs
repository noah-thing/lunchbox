import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Help asked for mid-turn stays inside the turn that asked, live and after. node test/consult-shot.mjs
const root = new URL('..', import.meta.url).pathname
const out = root + 'test/shots/consult-'
mkdirSync(root + 'test/shots', { recursive: true })
const temp = (name) => mkdtempSync(join(tmpdir(), `lunchbox-${name}-`))
const bin = temp('bin')
chmodSync(root + 'test/fake-agent.mjs', 0o755)
for (const n of ['claude', 'codex', 'grok']) symlinkSync(root + 'test/fake-agent.mjs', `${bin}/${n}`)

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${temp('profile')}`], cwd: root,
  env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_WORKSPACE: temp('work'), LUNCHBOX_PATH: `${bin}:${process.env.PATH}`, FAKE_DELAY: '120' },
  timeout: 30000,
})
const kill = setTimeout(() => { console.log('timed out'); app.close().finally(() => process.exit(1)) }, 110000)
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800))
await page.waitForSelector('.onboard')
// Each onboarding step takes Enter once it has settled; detecting local models can take a while.
for (let i = 0; i < 30 && !(await page.locator('.newroom').count()); i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(700) }
await page.waitForSelector('.newroom')
await page.evaluate(() => { window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([Math.round(e.startTime), Math.round(e.duration)]) }).observe({ type: 'longtask', buffered: true }) })
await page.click('.composer textarea')
await page.keyboard.type('Consult: check the island renders')
await page.keyboard.press('Enter')
const t0 = Date.now()
for (const [k, ms] of [2500, 4500, 22000].entries()) {
  await page.waitForTimeout(Math.max(0, t0 + ms - Date.now()))
  const order = await page.locator('.transcript .ev').evaluateAll((els) => els.map((el) => `${el.className.replace(/\bev\b|settled/g, '').trim()}: ${el.innerText.replace(/\s+/g, ' ').slice(0, 70)}`))
  console.log(`--- ${ms}ms`); for (const o of order) console.log('  ', o)
  await page.screenshot({ path: `${out}${k}-${ms}.png`, scale: 'css' })
}
console.log('long tasks:', JSON.stringify(await page.evaluate(() => window.__long)))
console.log('errors:', errors)
clearTimeout(kill)
await app.close()
