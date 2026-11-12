import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every menu, list and tooltip has to stay inside the window at any size: it flips to the side
// with room and scrolls inside when neither side has enough. node test/float-shot.mjs
const root = new URL('..', import.meta.url).pathname
const out = root + 'test/shots/float-'
mkdirSync(root + 'test/shots', { recursive: true })
const temp = (name) => mkdtempSync(join(tmpdir(), `lunchbox-${name}-`))
const bin = temp('bin')
chmodSync(root + 'test/fake-agent.mjs', 0o755)
for (const name of ['claude', 'codex', 'grok']) symlinkSync(root + 'test/fake-agent.mjs', `${bin}/${name}`)

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${temp('profile')}`], cwd: root,
  env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_WORKSPACE: temp('work'), LUNCHBOX_PATH: `${bin}:${process.env.PATH}` },
  timeout: 30000,
})
const kill = setTimeout(() => { console.log('timed out'); app.close().finally(() => process.exit(1)) }, 170000)
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(400, 300); win.setContentSize(w, h) }, [w, h])
await size(1100, 700)
await page.waitForSelector('.onboard')
for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(i ? 900 : 2600) }
await page.waitForSelector('.newroom')

const failures = []
// The surface has to sit inside the window, and scroll when its content is taller than it is.
const inside = async (name, selector) => {
  await page.waitForTimeout(350)
  const r = await page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].pop()
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { top: b.top, left: b.left, bottom: b.bottom, right: b.right, w: innerWidth, h: innerHeight, cut: el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY === 'visible' }
  }, selector)
  const ok = r && r.top >= 0 && r.left >= 0 && r.bottom <= r.h && r.right <= r.w && !r.cut
  if (!ok) failures.push(`${name}: ${JSON.stringify(r)}`)
  console.log(ok ? 'ok  ' : 'FAIL', name, r ? `${Math.round(r.top)}..${Math.round(r.bottom)} of ${r.h}` : 'not found')
  await page.screenshot({ path: `${out}${name}.png` })
}
const sizes = [[1440, 900], [1100, 700], [900, 620], [900, 420]]
const each = async (label, selector, open, shut = () => page.keyboard.press('Escape')) => {
  for (const [w, h] of sizes) {
    await size(w, h)
    await page.waitForTimeout(250)
    await open()
    await inside(`${label}-${w}x${h}`, selector)
    await shut()
    await page.waitForTimeout(150)
  }
}

await each('new-crew', '.menu', () => page.click('.cbar .menuwrap >> nth=0 >> button >> nth=0'))
await each('new-mode', '.menu', () => page.click('.cbar button[aria-label^="Mode"]'))
await each('new-folder', '.menu', () => page.click('.foldermenu > button'))
await each('new-slash', '.suggest', async () => { await page.click('.composer textarea'); await page.keyboard.type('/') }, () => page.keyboard.press('Backspace'))

await size(1100, 700)
await page.click('.composer textarea')
await page.keyboard.type('Write a short note on agent limits')
await page.keyboard.press('Enter')
await page.waitForSelector('.room')
await page.waitForTimeout(6000)
await each('room-actions', '.menu', () => page.click('button[aria-label="Room actions"]'))
await each('room-crew', '.menu', () => page.click('.cbar .menuwrap >> nth=0 >> button >> nth=0'))
await each('room-mention', '.suggest', async () => { await page.click('.composer textarea'); await page.keyboard.type('@') }, () => page.keyboard.press('Backspace'))
if (await page.locator('button[aria-label="Have another agent review this"]').count()) {
  await each('room-review', '.menu', async () => { const b = page.locator('button[aria-label="Have another agent review this"]').last(); await b.scrollIntoViewIfNeeded(); await b.click({ force: true }) })
}
// Right click near the bottom right corner of a room row; at the smallest size the list has no height left.
await each('sidebar-context', '.menu.ctx', () => page.dispatchEvent('.sbroom >> nth=0', 'contextmenu', { clientX: 120, clientY: 4000, bubbles: true }))

// Light, at the tightest size, for the two that flip.
await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
await size(900, 420)
await page.click('.cbar .menuwrap >> nth=0 >> button >> nth=0')
await inside('light-room-crew-900x420', '.menu')
await page.keyboard.press('Escape')

console.log('failures:', failures.length, failures, 'errors:', errors)
clearTimeout(kill)
await app.close()
process.exit(failures.length || errors.length ? 1 : 0)
