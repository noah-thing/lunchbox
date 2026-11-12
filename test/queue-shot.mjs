import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A message queued behind a slow turn, then taken back with Edit. node test/queue-shot.mjs
const root = new URL('..', import.meta.url).pathname
const out = root + 'test/shots/queue-'
mkdirSync(root + 'test/shots', { recursive: true })
const temp = (name) => mkdtempSync(join(tmpdir(), `lunchbox-${name}-`))
const bin = temp('bin')
chmodSync(root + 'test/fake-agent.mjs', 0o755)
symlinkSync(root + 'test/fake-agent.mjs', `${bin}/claude`)

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${temp('profile')}`], cwd: root,
  env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_WORKSPACE: temp('work'), LUNCHBOX_PATH: `${bin}:${process.execPath.replace(/\/[^/]+$/, '')}:/usr/bin:/bin`, LUNCHBOX_PATH_ONLY: '1', FAKE_DELAY: '700' },
  timeout: 30000,
})
const kill = setTimeout(() => { console.log('timed out'); app.close().finally(() => process.exit(1)) }, 110000)
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800))
await page.waitForSelector('.onboard')
for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(i ? 900 : 2600) }
await page.waitForSelector('.newroom')
await page.click('.composer textarea')
await page.keyboard.type('Write a short note on agent limits')
await page.keyboard.press('Enter')
await page.waitForSelector('.live, .evlive, [class*="live"]', { timeout: 15000 }).catch(() => {})
await page.waitForTimeout(1500)
await page.click('.composer textarea')
await page.keyboard.type('Then add a line about weekly limits')
await page.keyboard.press('Enter')
await page.waitForSelector('.mine.queued', { timeout: 5000 })
await page.waitForTimeout(400)
await page.screenshot({ path: out + '1-queued.png' })
await page.keyboard.type('and keep it short')
await page.click('.mine.queued .qback')
await page.waitForTimeout(400)
await page.screenshot({ path: out + '2-edit.png' })
console.log('box:', JSON.stringify(await page.inputValue('.composer textarea')))
console.log('queued left:', await page.locator('.mine.queued').count(), 'errors:', errors)
clearTimeout(kill)
await app.close()
