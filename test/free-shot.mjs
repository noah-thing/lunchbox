import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The Free models page, wide and narrow, and one real connection with no key. node test/free-shot.mjs
const root = new URL('..', import.meta.url).pathname
const out = root + 'test/shots/free-'
mkdirSync(root + 'test/shots', { recursive: true })
const temp = (name) => mkdtempSync(join(tmpdir(), `lunchbox-${name}-`))
const bin = temp('bin')
chmodSync(root + 'test/fake-agent.mjs', 0o755)
for (const name of ['claude', 'codex']) symlinkSync(root + 'test/fake-agent.mjs', `${bin}/${name}`)
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${temp('profile')}`], cwd: root,
  env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_WORKSPACE: temp('work'), LUNCHBOX_PATH: `${bin}:${process.execPath.replace(/\/[^/]+$/, '')}:/usr/bin:/bin`, LUNCHBOX_PATH_ONLY: '1' },
  timeout: 30000,
})
const kill = setTimeout(() => { console.log('timed out'); app.close().finally(() => process.exit(1)) }, 150000)
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h])
await size(1440, 900)
await page.waitForSelector('.onboard')
for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(i ? 900 : 2600) }
await page.waitForSelector('.newroom')
// From the agent menu in the message box, the way people will find it.
await page.click('[aria-label="Agents in this room"]')
await page.waitForTimeout(400)
await page.screenshot({ path: out + '0-menu.png' })
console.log('menu items:', await page.locator('.menu .item b').allTextContents())
await page.click('.menu .item:has(b:text-is("Free models"))')
await page.waitForTimeout(1500)
if (!(await page.locator('.freegrid').count())) { await page.screenshot({ path: out + 'x-fail.png' }); console.log('no page; errors:', errors); }
await page.waitForSelector('.freegrid')
await page.waitForTimeout(900)
await page.screenshot({ path: out + '1-wide.png' })
const overflow = () => page.evaluate(() => [...document.querySelectorAll('.freecard')].filter((c) => c.scrollWidth > c.clientWidth + 1 || [...c.querySelectorAll('*')].some((e) => e.getBoundingClientRect().right > c.getBoundingClientRect().right + 1)).length)
console.log('cards', await page.locator('.freecard').count(), 'overflowing', await overflow())
await page.click('.freecard:has-text("Groq") >> text=Get a free key').catch((e) => console.log('groq click', e.message))
await page.waitForTimeout(500)
await page.screenshot({ path: out + '2-key.png' })
await page.click('.freecard:has-text("Kilo Free") >> text=Add')
await page.waitForSelector('.freecard:has-text("Kilo Free") .freeon', { timeout: 60000 }).then(() => console.log('kilo: in your agents')).catch(async () => console.log('kilo failed:', await page.locator('.freecard:has-text("Kilo Free") .freeerr').textContent().catch(() => '?')))
await size(960, 760); await page.waitForTimeout(500)
await page.screenshot({ path: out + '3-narrow.png' })
console.log('narrow overflowing', await overflow())
console.log('errors:', errors.filter((e) => !/Failed to load resource/.test(e)))
clearTimeout(kill)
await app.close()
