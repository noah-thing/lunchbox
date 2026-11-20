import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every button on the Workshop page and in a Workshop room's header, clicked, with what each one
// should leave behind checked. Copies this repository's committed HEAD, so commit before running.
// node test/workshop-buttons.mjs
const root = new URL('..', import.meta.url).pathname
const out = root + 'test/shots/wsbuttons-'
mkdirSync(root + 'test/shots', { recursive: true })
const temp = (name) => mkdtempSync(join(tmpdir(), `lunchbox-${name}-`))
const bin = temp('bin')
chmodSync(root + 'test/fake-agent.mjs', 0o755)
for (const name of ['claude', 'codex']) symlinkSync(root + 'test/fake-agent.mjs', `${bin}/${name}`)
const tools = execFileSync('/bin/sh', ['-lc', 'dirname "$(command -v git)"; dirname "$(command -v npm)"']).toString().trim().split('\n')
const PATH = [bin, ...tools, '/usr/bin', '/bin'].join(':')
const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim()
const before = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD~1']).toString().trim()
const failures = []
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what) }
const saved = (profile) => JSON.parse(readFileSync(join(profile, 'workshop.json'), 'utf8'))

// A copy the way setup leaves it, with a change in it, so the page shows what a built version shows.
function copy(profile, extra = {}) {
  const ws = join(temp('ws'), 'copy')
  execFileSync('git', ['clone', '-q', root, ws])
  execFileSync('git', ['-C', ws, 'checkout', '-q', '-b', 'mine', head])
  symlinkSync(join(root, 'node_modules'), join(ws, 'node_modules'))
  writeFileSync(join(profile, 'workshop.json'), JSON.stringify({ base: head, ...extra }))
  writeFileSync(join(ws, 'src', 'views', 'Hello.tsx'), 'export const Hello = () => <p>Hello</p>\n')
  return ws
}

async function open(profile, ws, extra = {}) {
  const app = await electron.launch({
    executablePath: createRequire(import.meta.url)('electron'), args: ['.', `--user-data-dir=${profile}`], cwd: root,
    env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_WORKSPACE: temp('work'), LUNCHBOX_PATH: PATH, LUNCHBOX_PATH_ONLY: '1', FAKE_DELAY: '20', LB_WORKSHOP_REPO: root, LB_WORKSHOP_REF: head, LB_WORKSHOP_DIR: ws, LB_REPORT_ENDPOINT: 'http://127.0.0.1:9/report', ...extra },
    timeout: 30000,
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => failures.push(`page error: ${e}`))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await page.waitForSelector('.onboard, .newroom, .page, .room')
  if (await page.$('.onboard')) {
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(i ? 900 : 2600) }
    await page.waitForSelector('.newroom')
  }
  await page.click('.sbitem:has-text("Workshop")')
  await page.waitForSelector('.pagehead h1:has-text("Workshop")')
  return { app, page }
}
const toast = async (page, re) => { try { await page.waitForSelector(`.toast >> text=${re}`, { timeout: 8000 }); return true } catch { return false } }

// 1. A built copy: the note from a failed start, the crew menu and Build it, the ideas list, the
// room's header, the details and undoing everything.
{
  const profile = temp('profile')
  const ws = copy(profile, { use: true, failed: 'Your version did not open last time, so the standard Lunchbox opened instead.' })
  const { app, page } = await open(profile, ws)
  await page.waitForSelector('.ws-built')

  await page.click('.ws-note button:has-text("Dismiss")')
  await page.waitForSelector('.ws-note', { state: 'detached', timeout: 5000 }).catch(() => {})
  check(!(await page.$('.ws-note')) && !saved(profile).failed, 'Dismiss takes the note away for good')

  await page.click('.ws-built button:has-text("Details")')
  await page.click('button:has-text("Open the standard one instead")')
  await page.waitForTimeout(500)
  check(!(await page.isVisible('button:has-text("Open the standard one instead")')) && saved(profile).use === false, 'Open the standard one instead stops using the copy at start')

  await page.click('[aria-label="Who builds it"]')
  await page.waitForSelector('.menu .crewrow')
  await page.click('.menu .crewrow:has-text("Codex") .item')
  await page.keyboard.press('Escape')
  check(/^Claude Code builds it/.test(await page.textContent('.ws-by')), `the crew menu changes who builds (${await page.textContent('.ws-by')})`)
  await page.fill('.ws-field textarea', 'A sound when an agent finishes')
  await page.click('.ws-field button:has-text("Build it")')
  await page.waitForSelector('.room .ws-bar', { timeout: 15000 })
  const rooms = await page.evaluate(() => window.lb.call('rooms'))
  const room = rooms.find((r) => r.pack === 'workshop')
  check(room && room.crew.join() === 'claude', `Build it starts a room with the crew picked (${room?.crew})`)
  await page.screenshot({ path: out + '01-room.png' })

  await page.waitForFunction(() => !document.querySelector('.ws-bar button[disabled]'), null, { timeout: 30000 }).catch(() => {})
  await page.click('.ws-bar button:has-text("Send to Lunchbox too")')
  await page.waitForTimeout(2500)
  const outbox = join(profile, 'data', 'outbox.jsonl')
  check(existsSync(outbox) && /Workshop suggestion/.test(readFileSync(outbox, 'utf8')), 'Send to Lunchbox too in the room sends the change')

  await page.click('.sbitem:has-text("Workshop")')
  await page.waitForSelector('.ws-idea')
  await page.click('.ws-idea >> nth=0')
  await page.waitForSelector('.room .ws-bar', { timeout: 10000 })
  check(true, 'an idea in the list opens its room')

  await page.click('.sbitem:has-text("Workshop")')
  await page.waitForSelector('.ws-built')
  await page.click('.ws-built button:has-text("Details")')
  await page.click('.ws-undo')
  check((await page.textContent('.ws-undo'))?.includes('Undo everything?'), 'Undo asks once before it does anything')
  await page.click('.ws-undo')
  check(await toast(page, 'Back to Lunchbox as it shipped'), 'Undo all changes says it is done')
  await page.waitForSelector('.ws-built', { state: 'detached', timeout: 15000 }).catch(() => {})
  check(!(await page.$('.ws-built')) && !existsSync(join(ws, 'src', 'views', 'Hello.tsx')), 'and the copy is back as it shipped')
  await page.screenshot({ path: out + '02-undone.png' })
  await app.close()
}

// 2. Lunchbox moved on and bringing the changes along fails here: Try again repeats that job, and
// Close puts the failure away.
{
  const profile = temp('profile')
  const ws = copy(profile)
  writeFileSync(join(profile, 'workshop.json'), JSON.stringify({ base: before }))
  const { app, page } = await open(profile, ws)
  await page.waitForSelector('button:has-text("Bring it along")')
  await page.click('button:has-text("Bring it along")')
  await page.waitForSelector('.ws-progress.failed', { timeout: 60000 })
  const first = await page.textContent('.ws-progress')
  await page.screenshot({ path: out + '03-failed.png' })
  await page.click('.ws-progress button:has-text("Try again")')
  await page.waitForTimeout(400)
  await page.waitForSelector('.ws-progress.failed', { timeout: 60000 })
  const again = await page.textContent('.ws-progress')
  check(/Fetching|Moving|changes/i.test(again ?? '') && !/Building your Lunchbox|Opening/i.test(again ?? ''), `Try again repeats bringing the changes along, not opening the copy (${(again ?? '').slice(0, 80)})`)
  check(!!first, 'a failed job says what went wrong')
  await page.click('.ws-progress button:has-text("Close")')
  await page.waitForSelector('.ws-progress', { state: 'detached', timeout: 5000 }).catch(() => {})
  check(!(await page.$('.ws-progress')), 'Close puts the failure away')
  await app.close()
}

// 3. The person's own build, started without the way back: Switch back says what to do instead of
// doing nothing.
{
  const profile = temp('profile')
  const ws = copy(profile, { use: true })
  const { app, page } = await open(profile, ws, { LUNCHBOX_WORKSHOP: '1', LUNCHBOX_STANDARD: '/nonexistent' })
  await page.waitForSelector('.ws-mine')
  await page.click('button:has-text("Switch back")')
  check(await toast(page, 'Quit this one'), 'Switch back explains itself when the standard app is not there')
  check(saved(profile).use === false, 'and the standard one opens next time')
  await page.screenshot({ path: out + '04-mine.png' })
  await app.close()
}

console.log(failures.length ? `\n${failures.length} failed` : '\nall passed')
process.exit(failures.length ? 1 : 0)
