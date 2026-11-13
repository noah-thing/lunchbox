import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The Savings page and the Saving settings over a week of made-up turns, to look at the layout
// with every kind of saving present. node test/saving-shot.mjs
const root = new URL('..', import.meta.url).pathname
const out = root + 'test/shots/saving-'
mkdirSync(root + 'test/shots', { recursive: true })
const temp = (name) => mkdtempSync(join(tmpdir(), `lunchbox-${name}-`))
const bin = temp('bin')
chmodSync(root + 'test/fake-agent.mjs', 0o755)
for (const name of ['claude', 'codex']) symlinkSync(root + 'test/fake-agent.mjs', `${bin}/${name}`)

const profile = temp('profile')
mkdirSync(join(profile, 'data', 'rooms'), { recursive: true })
const day = 86400e3
const rows = []
const rooms = ['r1checkout', 'r2nightly', 'r3landing']
for (let d = 6; d >= 0; d--) {
  const at = Date.now() - d * day - 3600e3
  const k = 1 + ((7 - d) % 4) / 3
  rows.push({ at, agent: 'claude', room: rooms[d % 3], usage: { input: Math.round(52000 * k), output: 9000, cached: Math.round(640000 * k), cost: 1.4 * k, written: Math.round(48000 * k), saved: 3.1 * k, gross: 3.6 * k, kept: Math.round(5200 * k), cut: Math.round(3900 * k), spared: 0.042 * k, trimmed: 0.031 * k, held: d % 2 ? 96000 : 0, warmed: d % 2 ? 0.62 : 0.18, v: 2 } })
  rows.push({ at: at + 60e3, agent: 'codex', room: rooms[(d + 1) % 3], usage: { input: Math.round(21000 * k), output: 4000, cached: Math.round(180000 * k), cost: 0, saved: 0.32 * k, gross: 0.32 * k, kept: Math.round(8800 * k), spared: 0.018 * k, v: 2 } })
  if (d % 2) rows.push({ at: at + 120e3, agent: 'claude', room: rooms[d % 3], usage: { input: 0, output: 0, cached: 0, cost: 0.03, pings: 0.03, v: 2 } })
}
writeFileSync(join(profile, 'data', 'ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
const meta = (id, name) => ({ id, name, created: Date.now() - 6 * day, updated: Date.now(), crew: ['claude', 'codex'], workspace: tmpdir(), sessions: {}, seen: {}, heard: {}, blocks: [], saved: { full: 0, sent: 0 } })
writeFileSync(join(profile, 'data', 'rooms.json'), JSON.stringify([meta('r1checkout', 'Checkout rewrite'), meta('r2nightly', 'Nightly dependency check'), meta('r3landing', 'Landing page')]))

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${profile}`], cwd: root,
  env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_WORKSPACE: temp('work'), LUNCHBOX_PATH: `${bin}:${process.execPath.replace(/\/[^/]+$/, '')}:/usr/bin:/bin`, LUNCHBOX_PATH_ONLY: '1' },
  timeout: 30000,
})
const kill = setTimeout(() => { console.log('timed out'); app.close().finally(() => process.exit(1)) }, 120000)
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000))
await page.waitForSelector('.onboard')
for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(i ? 900 : 2600) }
await page.waitForSelector('.newroom')
await page.click('.sbitem:has-text("Savings")')
await page.waitForTimeout(1500)
await page.screenshot({ path: out + '0-top.png', scale: 'css' })
await page.evaluate(() => document.querySelector('.savings .sv-split')?.scrollIntoView({ block: 'start' }))
await page.waitForTimeout(500)
await page.screenshot({ path: out + '1-tables.png', scale: 'css' })
await page.evaluate(() => document.querySelector('.savings .sv-notes')?.scrollIntoView({ block: 'end' }))
await page.waitForTimeout(500)
await page.screenshot({ path: out + '2-notes.png', scale: 'css' })
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 1000))
await page.evaluate(() => document.querySelector('.savings .pagebody, .savings')?.scrollIntoView({ block: 'start' }))
await page.waitForTimeout(600)
await page.screenshot({ path: out + '3-narrow.png', scale: 'css' })
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000))
await page.click('.sbitem:has-text("Settings")')
await page.waitForTimeout(800)
await page.evaluate(() => [...document.querySelectorAll('.group h2')].find((h) => h.textContent.startsWith('Saving'))?.scrollIntoView({ block: 'start' }))
await page.waitForTimeout(500)
await page.screenshot({ path: out + '4-settings.png', scale: 'css' })
console.log('page errors:', errors.length ? errors : 'none')
clearTimeout(kill)
await app.close()
