import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// What a long turn shows while it runs: thinking, a file being written, a retry, a command. node test/progress-shot.mjs
const root = new URL('..', import.meta.url).pathname
const out = root + 'test/shots/progress-'
mkdirSync(root + 'test/shots', { recursive: true })
const temp = (name) => mkdtempSync(join(tmpdir(), `lunchbox-${name}-`))
const bin = temp('bin')
chmodSync(root + 'test/fake-agent.mjs', 0o755)
symlinkSync(root + 'test/fake-agent.mjs', `${bin}/claude`)

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${temp('profile')}`], cwd: root,
  env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_WORKSPACE: temp('work'), LUNCHBOX_PATH: `${bin}:${process.execPath.replace(/\/[^/]+$/, '')}:/usr/bin:/bin`, LUNCHBOX_PATH_ONLY: '1', FAKE_DELAY: '0', FAKE_SCRIPT: 'progress' },
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
await page.keyboard.type('Build the pricing page and test it')
await page.keyboard.press('Enter')
const t0 = Date.now()
const at = process.env.FAST ? Array.from({ length: 24 }, (_, i) => 1000 + i * 250) : [9000, 17500, 26000]
for (const [k, ms] of at.entries()) {
  await page.waitForTimeout(Math.max(0, t0 + ms - Date.now()))
  const line = await page.locator('.workpair, .workline').last().innerText({ timeout: 50 }).catch(() => '(none)')
  const side = await page.locator('.planside').innerText({ timeout: 50 }).catch(() => '(no panel plan)')
  console.log(`${ms}ms`, JSON.stringify(line.replace(/\s+/g, ' ')), '| panel:', JSON.stringify(side.replace(/\s+/g, ' ').slice(0, 140)))
  await page.screenshot({ path: `${out}${String(k).padStart(2, '0')}-${ms}.png`, scale: 'css' })
}
console.log('long tasks:', JSON.stringify(await page.evaluate(() => window.__long)))
console.log('errors:', errors)
clearTimeout(kill)
await app.close()
