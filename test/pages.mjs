import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Flows, Pool, Library, Browser and Settings after a short first room. node test/pages.mjs
const root = new URL('..', import.meta.url).pathname
const out = root + 'test/shots/pages-'
mkdirSync(root + 'test/shots', { recursive: true })
const temp = (name) => mkdtempSync(join(tmpdir(), `lunchbox-${name}-`))
const bin = temp('bin')
const work = temp('work')
writeFileSync(join(work, 'notes.md'), '# Agent limits\n\nEvery plan has a cap.\nMost people hit it on Mondays.\n')
writeFileSync(join(work, 'page.html'), '<h1>Limits</h1>\n<p>Draft</p>\n')
chmodSync(root + 'test/fake-agent.mjs', 0o755)
for (const name of ['claude', 'codex', 'grok']) symlinkSync(root + 'test/fake-agent.mjs', `${bin}/${name}`)

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${temp('profile')}`], cwd: root,
  env: { ...process.env, LB_WORKSPACE: work, LUNCHBOX_PATH: `${bin}:${process.env.PATH}`, FAKE_DELAY: '20' },
  timeout: 30000,
})
const kill = setTimeout(() => { console.log('timed out'); app.close().finally(() => process.exit(1)) }, 110000)
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
const shot = async (name, wait = 700) => { await page.waitForTimeout(wait); await page.screenshot({ path: out + name + '.png' }) }

await page.waitForSelector('.onboard')
for (let i = 0; i < 4; i++) {
  await page.keyboard.press('Enter')
  await page.waitForTimeout(i ? 900 : 2600)
  if (i === 0) await shot('00-onboard-agents', 600)
}
await page.waitForSelector('.newroom')
await shot('01-home', 1200)
await page.click('[aria-label^="Mode:"]')
await shot('01b-modes', 400)
await page.keyboard.press('Escape')

await page.click('.composer textarea')
await page.keyboard.type('Write a short note on agent limits')
await page.keyboard.press('Enter')
await page.waitForSelector('.room')
await page.waitForSelector('.decide', { timeout: 30000 }).catch(() => {})
await shot('02-room', 900)
writeFileSync(join(work, 'notes.md'), '# Agent limits\n\nEvery plan has a cap, and it resets on a schedule.\nMost people hit it on Mondays.\nLunchbox moves work to whoever has room left.\n')
writeFileSync(join(work, 'sources.md'), '- Posts on X this week: 212\n- Most mention weekly caps\n')
await page.hover('.mine >> nth=0')
await page.click('.rewind button:has-text("Changes"), .rewind button:has-text("changed since")')
await page.waitForSelector('.changesbody')
await shot('02b-changes', 700)
await page.keyboard.press('Escape')

const visit = async (label, name, after) => {
  await page.click(`.sbitem >> text=${label}`)
  await shot(name, 900)
  if (after) await after()
}
await visit('Flows', '03-flows', async () => {
  await page.click('.tcard >> nth=0')
  await shot('04-flow-edit', 700)
  await page.keyboard.press('Escape')
})
await visit('Pool', '05-pool')
await visit('Savings', '05b-savings', async () => {
  await page.evaluate(() => document.querySelector('.page')?.scrollTo(0, 99999))
  await shot('05c-savings-end', 500)
})
await visit('Library', '06-library', async () => {
  await page.click('.cards .card >> nth=0')
  await shot('06b-playbook', 500)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+k')
  await shot('06c-palette', 500)
  await page.keyboard.press('Escape')
  for (const [i, t] of [[0, 'skills'], [1, 'tools'], [2, 'packs']]) {
    await page.click(`.tabs button >> nth=${i + 1}`).catch(() => {})
    await shot(`07-library-${t}`, 500)
  }
})
await visit('Browser', '08-browser')
await visit('Agents', '08b-agents', async () => {
  for (const name of ['LM Studio', 'Ollama']) {
    await page.click(`.agenthead:has-text("${name}")`).catch(() => {})
    await page.waitForTimeout(300)
  }
  await page.evaluate(() => document.querySelector('.page')?.scrollTo(0, 99999))
  await shot('08c-agents-local', 600)
})
await visit('Settings', '09-settings')
await page.click('.seg button:has-text("Light")')
await visit('Pool', '10-pool-light')
await visit('Savings', '10b-savings-light')
await visit('Flows', '11-flows-light')

console.log('errors', errors.length ? errors.join('\n') : 'none')
clearTimeout(kill)
await app.close()
