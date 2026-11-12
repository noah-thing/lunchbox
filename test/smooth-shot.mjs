import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { chmodSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Frame times while a long turn plays, with no screenshots in the way. node test/smooth-shot.mjs
const root = new URL('..', import.meta.url).pathname
const temp = (name) => mkdtempSync(join(tmpdir(), `lunchbox-${name}-`))
const bin = temp('bin')
chmodSync(root + 'test/fake-agent.mjs', 0o755)
symlinkSync(root + 'test/fake-agent.mjs', `${bin}/claude`)
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${temp('profile')}`], cwd: root,
  env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_WORKSPACE: temp('work'), LUNCHBOX_PATH: `${bin}:${process.env.PATH}`, FAKE_DELAY: '0', FAKE_SCRIPT: 'progress' },
  timeout: 30000,
})
const page = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
await page.waitForSelector('.onboard')
// Each onboarding step takes Enter once it has settled; detecting local models can take a while.
for (let i = 0; i < 30 && !(await page.locator('.newroom').count()); i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(700) }
await page.waitForSelector('.newroom')
await page.click('.composer textarea')
await page.keyboard.type('Build the pricing page and test it')
await page.evaluate(() => {
  window.__gaps = []
  let last = performance.now()
  const tick = (now) => { window.__gaps.push(now - last); last = now; requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
})
await page.keyboard.press('Enter')
await page.waitForTimeout(24000)
const g = await page.evaluate(() => window.__gaps)
const sorted = [...g].sort((a, b) => a - b)
const pct = (p) => sorted[Math.floor(sorted.length * p)].toFixed(1)
console.log(`frames ${g.length}, median ${pct(0.5)}ms, p95 ${pct(0.95)}ms, p99 ${pct(0.99)}ms, max ${sorted[sorted.length - 1].toFixed(0)}ms, over 50ms: ${g.filter((x) => x > 50).length}`)
await app.close()
