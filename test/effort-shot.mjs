import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Model and effort in the crew menu: the meter lights, previews and saves, the crew row says the
// level, and the menu stays inside a small window. node test/effort-shot.mjs
const root = new URL('..', import.meta.url).pathname
const out = root + 'test/shots/effort-'
mkdirSync(root + 'test/shots', { recursive: true })
const temp = (name) => mkdtempSync(join(tmpdir(), `lunchbox-${name}-`))
const bin = temp('bin')
chmodSync(root + 'test/fake-agent.mjs', 0o755)
for (const name of ['claude', 'codex']) symlinkSync(root + 'test/fake-agent.mjs', `${bin}/${name}`)
const failures = []
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what) }

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${temp('profile')}`], cwd: root,
  env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_WORKSPACE: temp('work'), LB_REPORT_ENDPOINT: 'http://127.0.0.1:9/report', LUNCHBOX_PATH: `${bin}:${process.execPath.replace(/\/[^/]+$/, '')}:/usr/bin:/bin`, LUNCHBOX_PATH_ONLY: '1', FAKE_DELAY: '20' },
  timeout: 30000,
})
const kill = setTimeout(() => { console.log('timed out'); app.close().finally(() => process.exit(1)) }, 110000)
const page = await app.firstWindow()
page.on('pageerror', (e) => failures.push(`page error: ${e}`))
const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h])
await size(1440, 900)
await page.waitForSelector('.onboard')
for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(i ? 900 : 2600) }
await page.waitForSelector('.newroom')
if (process.env.DAY) await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))

const inside = () => page.$eval('.menu', (m) => { const r = m.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth })
const crew = '[aria-label="Agents in this room"]'
await page.click(crew)
await page.waitForSelector('.menu .crewrow')
await page.waitForTimeout(300)
await page.screenshot({ path: out + '01-crew.png' })
await page.click('.crewrow .modelchip >> nth=0')
await page.waitForSelector('.effortsteps')
await page.waitForTimeout(400)
check(await inside(), 'the model menu is inside the window')
await page.screenshot({ path: out + '02-models.png' })
const steps = await page.$$('.effortstep')
check(steps.length >= 3, `the meter has a step per level (${steps.length})`)
check((await page.textContent('.effortname')) === 'Default' && !(await page.$('.effortstep.lit')), 'nothing lit reads as Default')
await steps[1].hover()
await page.waitForTimeout(250)
check((await page.textContent('.effortname')) === 'Medium', 'pointing at a step previews it')
await page.screenshot({ path: out + '03-peek.png' })
await steps[2].click()
await page.mouse.move(5, 5)
await page.waitForTimeout(500)
check((await page.$$('.effortstep.lit')).length === 3 && (await page.textContent('.effortname')) === 'High', 'picking a step lights it and those before it')
await page.screenshot({ path: out + '04-high.png' })
await page.focus('.effortsteps')
await page.keyboard.press('ArrowRight')
await page.waitForTimeout(300)
check((await page.textContent('.effortname')) === 'Extra high', 'the arrow keys step through the levels')
const saved = await page.evaluate(() => window.lb.call('settings'))
check(saved?.effort?.claude === 'xhigh', `the level is saved (${saved?.effort?.claude})`)
await page.click('.modelhead')
await page.waitForTimeout(400)
const chip = await page.textContent('.crewrow .modelchip >> nth=0')
check(/Extra high/.test(chip ?? ''), `the crew row shows the level (${chip})`)
await page.screenshot({ path: out + '05-chip.png' })
await page.keyboard.press('Escape')

for (const [w, h] of [[900, 560], [760, 480]]) {
  await size(w, h)
  await page.waitForTimeout(500)
  await page.click(crew)
  await page.waitForSelector('.menu .crewrow')
  await page.click('.crewrow .modelchip >> nth=0')
  await page.waitForSelector('.effortsteps')
  await page.waitForTimeout(500)
  check(await inside(), `at ${w}x${h} the menu stays in the window`)
  await page.screenshot({ path: out + `06-small-${w}.png` })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
}

clearTimeout(kill)
await app.close()
console.log(failures.length ? `\n${failures.length} failed` : '\nall passed')
process.exit(failures.length ? 1 : 0)
