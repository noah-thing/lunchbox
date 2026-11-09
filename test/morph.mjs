import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Frames from the middle of the search palette opening and closing. node test/morph.mjs
const root = new URL('..', import.meta.url).pathname
mkdirSync(root + 'test/shots', { recursive: true })
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'lunchbox-morph-'))}`], cwd: root,
  env: { ...process.env, LB_WORKSPACE: mkdtempSync(join(tmpdir(), 'lunchbox-work-')) },
  timeout: 30000,
})
const kill = setTimeout(() => app.close().finally(() => process.exit(1)), 60000)
const page = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
await page.waitForSelector('.onboard')
for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(i ? 900 : 2600) }
await page.waitForSelector('.newroom')
await page.waitForTimeout(800)

// Pause every animation at a fixed point so the frame shows exactly that moment.
const at = (ms) => page.evaluate((ms) => { for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms } }, ms)
await page.click('.sbitem:has-text("Search")')
for (const ms of [40, 100, 170, 250, 340, 440]) { await at(ms); await page.screenshot({ path: `${root}test/shots/morph-open-${ms}.png` }) }
await page.evaluate(() => { for (const a of document.getAnimations()) a.finish() })
await page.waitForTimeout(300)
await page.screenshot({ path: `${root}test/shots/morph-open-done.png` })
await page.keyboard.press('Escape')
for (const ms of [40, 100, 170, 230]) { await at(ms); await page.screenshot({ path: `${root}test/shots/morph-close-${ms}.png` }) }
await page.evaluate(() => { for (const a of document.getAnimations()) a.play() })
await page.waitForTimeout(500)
console.log('palette closed:', !(await page.$('.palette')))
clearTimeout(kill)
await app.close()
