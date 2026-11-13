import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The Savings share card after a short room. node test/share-shot.mjs
const root = new URL('..', import.meta.url).pathname
const out = root + 'test/shots/share-'
mkdirSync(root + 'test/shots', { recursive: true })
const temp = (name) => mkdtempSync(join(tmpdir(), `lunchbox-${name}-`))
const bin = temp('bin')
chmodSync(root + 'test/fake-agent.mjs', 0o755)
for (const name of ['claude', 'codex']) symlinkSync(root + 'test/fake-agent.mjs', `${bin}/${name}`)
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${temp('profile')}`], cwd: root,
  env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_WORKSPACE: temp('work'), LUNCHBOX_PATH: `${bin}:${process.execPath.replace(/\/[^/]+$/, '')}:/usr/bin:/bin`, LUNCHBOX_PATH_ONLY: '1', FAKE_DELAY: '10' },
  timeout: 30000,
})
const kill = setTimeout(() => { console.log('timed out'); app.close().finally(() => process.exit(1)) }, 150000)
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
await page.waitForSelector('.onboard')
for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(i ? 900 : 2600) }
await page.waitForSelector('.newroom')
for (const text of ['Write a short note on agent limits', 'Now add a line about weekly limits']) {
  await page.click('.composer textarea'); await page.keyboard.type(text); await page.keyboard.press('Enter')
  await page.waitForTimeout(4000)
}
await page.click('.sbitem:has-text("Savings")')
await page.waitForTimeout(1200)
// The whole page, with the notes on how each number is counted, before the card covers it.
await page.evaluate(() => document.querySelector('.savings .sv-notes')?.scrollIntoView({ block: 'end' }))
await page.waitForTimeout(500)
await page.screenshot({ path: out + '0-page.png', scale: 'css' })
const share = page.locator('.savings button:has-text("Share")')
console.log('share button:', await share.count())
if (await share.count()) {
  await share.click()
  await page.waitForSelector('.sharecard img', { timeout: 10000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: out + '1-preview.png' })
  const src = await page.getAttribute('.sharecard img', 'src')
  writeFileSync(out + '2-card.png', Buffer.from(src.split(',')[1], 'base64'))
  await page.click('.sharecard button:has-text("Copy image")')
  await page.waitForTimeout(400)
  console.log('after copy:', await page.locator('.sharesaid').textContent())
}
console.log('errors:', errors)
clearTimeout(kill)
await app.close()
