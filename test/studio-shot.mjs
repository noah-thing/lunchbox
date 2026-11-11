import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The Studio switch on the new room page and in a room, wide and narrow. node test/studio-shot.mjs
const root = new URL('..', import.meta.url).pathname
const out = root + 'test/shots/studio-'
mkdirSync(root + 'test/shots', { recursive: true })
const temp = (name) => mkdtempSync(join(tmpdir(), `lunchbox-${name}-`))
const bin = temp('bin')
chmodSync(root + 'test/fake-agent.mjs', 0o755)
for (const name of ['claude', 'codex', 'grok']) symlinkSync(root + 'test/fake-agent.mjs', `${bin}/${name}`)
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${temp('profile')}`], cwd: root,
  env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_WORKSPACE: temp('work'), LUNCHBOX_PATH: `${bin}:${process.env.PATH}`, FAKE_DELAY: '300' },
  timeout: 30000,
})
const kill = setTimeout(() => { console.log('timed out'); app.close().finally(() => process.exit(1)) }, 110000)
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h])
await size(1440, 900)
await page.waitForSelector('.onboard')
for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(i ? 900 : 2600) }
await page.waitForSelector('.newroom')
const bar = async (name) => { await page.waitForTimeout(500); const c = await page.$('.composer'); await c.screenshot({ path: out + name + '.png' }) }
// Every toolbar item must sit on one row inside the composer, never past its edge.
const fits = () => page.evaluate(() => {
  const barEl = document.querySelector('.cbar'); const box = barEl.getBoundingClientRect()
  const items = [...barEl.children].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0)
  return { rows: new Set(items.map((r) => Math.round(r.top))).size, over: items.some((r) => r.right > box.right + 1 || r.left < box.left - 1) }
})
await bar('1-new-off'); console.log('new wide', JSON.stringify(await fits()))
await page.click('.pill.studio')
await bar('2-new-on'); console.log('new wide on', JSON.stringify(await fits()))
await size(820, 760); await bar('3-new-narrow'); console.log('new narrow', JSON.stringify(await fits()))
await size(1440, 900)
await page.click('.composer textarea')
await page.keyboard.type('Design a landing page for a coffee roaster')
await page.keyboard.press('Enter')
await page.waitForSelector('.room .composer')
await page.waitForTimeout(800)
console.log('room studio pressed:', await page.getAttribute('.room .pill.studio', 'aria-pressed'))
await page.screenshot({ path: out + '4-room.png' })
console.log('room wide', JSON.stringify(await fits()))
await size(700, 760); await page.waitForTimeout(500); await page.screenshot({ path: out + '5-room-narrow.png' }); console.log('room narrow', JSON.stringify(await fits()))
await page.click('.room .pill.studio')
await page.waitForTimeout(400)
console.log('after toggle off:', await page.getAttribute('.room .pill.studio', 'aria-pressed'))
console.log('errors:', errors)
clearTimeout(kill)
await app.close()
