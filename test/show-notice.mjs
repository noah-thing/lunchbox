import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

// Opens a window of this build with a notice from ~/lunchbox/notices.json on screen, to look at it
// the way people will. node test/show-notice.mjs <id>. Close the window to end.
const root = new URL('..', import.meta.url).pathname
const id = process.argv[2]
const notice = JSON.parse(readFileSync(process.env.NOTICES ?? join(homedir(), 'lunchbox/notices.json'), 'utf8')).find((n) => n.id === id)
if (!notice) throw new Error(`No notice ${id}`)
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'lunchbox-notice-'))}`], cwd: root,
  env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_REPORT_ENDPOINT: 'http://127.0.0.1:9/report' },
})
const page = await app.firstWindow()
await page.waitForSelector('.onboard, .newroom')
if (await page.$('.onboard')) {
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(i ? 900 : 2600) }
  await page.waitForSelector('.newroom')
}
await page.waitForTimeout(800)
await app.evaluate(({ BrowserWindow }, n) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('notices', [n]) }, notice)
await page.waitForTimeout(900)
await page.screenshot({ path: join(root, 'test/shots/notice-' + id + '.png') })
console.log('showing')
await new Promise((done) => app.process().once('exit', done))
