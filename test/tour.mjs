import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The real app against stand-in agents: onboarding, a new room, a handover, a handoff and a
// proof check, in dark and light. node test/tour.mjs [look]
const look = process.argv[2] ?? 'lunchbox'
const root = new URL('..', import.meta.url).pathname
const out = root + `test/shots/`
mkdirSync(out, { recursive: true })
const temp = (name) => mkdtempSync(join(tmpdir(), `lunchbox-${name}-`))
const bin = temp('bin')
chmodSync(root + 'test/fake-agent.mjs', 0o755)
for (const name of ['claude', 'codex', 'grok']) symlinkSync(root + 'test/fake-agent.mjs', `${bin}/${name}`)

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${temp('profile')}`], cwd: root,
  env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_WORKSPACE: temp('work'), LUNCHBOX_PATH: `${bin}:${process.execPath.replace(/\/[^/]+$/, '')}:/usr/bin:/bin`, LUNCHBOX_PATH_ONLY: '1', FAKE_DELAY: '45' },
  timeout: 30000,
})
const kill = setTimeout(() => { console.log('timed out'); app.close().finally(() => process.exit(1)) }, 110000)
const page = await app.firstWindow()
const errors = []
process.on('exit', (code) => { if (code) console.log('page errors:', errors.join('\n') || 'none') })
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
const shot = async (name, wait = 600) => { await page.waitForTimeout(wait); await page.screenshot({ path: out + name + '.png' }) }

await page.evaluate((l) => localStorage.setItem('lb.look', JSON.stringify(l)), look)
await page.reload()
await page.waitForSelector('.onboard')
await shot('01-welcome', 2600)
await page.keyboard.press('Enter')
await shot('02-agents-scan', 500)
await shot('03-agents', 2600)
await page.keyboard.press('Enter')
await shot('04-look', 900)
await page.keyboard.press('Enter')
await shot('05-folder', 900)
await page.keyboard.press('Enter')
await page.waitForSelector('.newroom')
await shot('06-new', 1500)

await page.click('.composer textarea')
await page.keyboard.type('Find out what people think of agent limits and build a page about it')
await page.click('.newmeta .chip:has-text("Research")')
await shot('07-new-typed', 300)
await page.click('.composer textarea')
await page.keyboard.press('Enter')
await page.waitForSelector('.room')
await shot('08-room-live', 1700)
await shot('09-room-handoff', 2200)
await page.waitForSelector('.decide', { timeout: 30000 })
await shot('10-room-end', 900)

await page.click('.acts .actsum >> nth=0').catch(() => {})
await shot('11-acts-open', 400)
await page.keyboard.press('Meta+k')
await shot('12-palette', 700)
await page.keyboard.type('212')
await shot('13-search', 700)
await page.keyboard.press('Escape')
await page.click('.composer textarea')
await page.keyboard.type('@')
await shot('14-mention', 400)
await page.keyboard.press('Backspace')
await page.click('.decide .btn >> nth=0')
await shot('15-decided', 2500)

await page.click('.sbitem >> text=Agents')
await shot('16-agents', 900)
await page.click('.agenthead >> nth=0')
await shot('17-agent-open', 600)
await page.click('.sbitem >> text=Settings')
await shot('18-settings', 800)
await page.click('.seg button:has-text("Light")')
await shot('19-reveal-mid', 260)
await page.click('.sbroom >> nth=0')
await shot('20-light-room', 1200)
await page.keyboard.press('Meta+n')
await shot('21-light-new', 1200)

// A dialog keeps the keyboard: Tab never leaves it, and closing it puts focus back on its button.
await page.focus('.sbbeta')
await page.keyboard.press('Enter')
await page.waitForSelector('[role=dialog]')
const inside = []
for (let i = 0; i < 14; i++) { await page.keyboard.press(i % 5 === 4 ? 'Shift+Tab' : 'Tab'); inside.push(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))) }
await page.keyboard.press('Escape')
await page.waitForSelector('[role=dialog]', { state: 'detached' })
await page.waitForTimeout(120)
const back = await page.evaluate(() => document.activeElement?.className)
if (!inside.every(Boolean) || back !== 'sbbeta') errors.push(`dialog focus: stayed inside ${inside.filter(Boolean).length}/14, came back to ${back}`)

console.log('errors', errors.length ? errors.join('\n') : 'none')
if (errors.length) process.exitCode = 1
clearTimeout(kill)
await app.close()
