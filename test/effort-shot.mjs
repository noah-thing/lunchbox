import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
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
const log = join(temp('log'), 'runs.jsonl')
const runs = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
const failures = []
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what) }

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${temp('profile')}`], cwd: root,
  env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_WORKSPACE: temp('work'), LB_REPORT_ENDPOINT: 'http://127.0.0.1:9/report', LUNCHBOX_PATH: `${bin}:${process.execPath.replace(/\/[^/]+$/, '')}:/usr/bin:/bin`, LUNCHBOX_PATH_ONLY: '1', FAKE_DELAY: '20', FAKE_LOG: log },
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
const rect = () => page.$eval('.menu', (m) => { const r = m.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)] })
const was = await rect()
await page.click('.crewrow .modelchip >> nth=0')
for (const t of [40, 100, 180]) { await page.waitForTimeout(t === 40 ? 40 : 60); await page.screenshot({ path: out + `02-frame-${t}.png` }) }
await page.waitForSelector('.effortsteps')
await page.waitForTimeout(400)
const now = await rect()
check(was.join() === now.join(), `the menu keeps its place and width when it opens the models (${was} then ${now})`)
check(await inside(), 'the model menu is inside the window')
check(await page.$eval('.modellist', (l) => l.offsetWidth === l.clientWidth), 'the model list shows no scrollbar')
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

// The level reaches the command Claude Code is started with, and Default sends none.
const send = async (text) => {
  const before = runs().filter((r) => r.name === 'claude').length
  await page.click('.composer textarea')
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  for (let i = 0; i < 60 && runs().filter((r) => r.name === 'claude').length === before; i++) await page.waitForTimeout(250)
  return runs().filter((r) => r.name === 'claude').at(-1)?.args ?? []
}
let args = await send('First message')
check(args.join(' ').includes('--effort xhigh'), `the picked level is sent to Claude Code (${args.filter((a, i) => a === '--effort' || args[i - 1] === '--effort').join(' ')})`)
await page.waitForFunction(() => !document.querySelector('.composer .stop'), null, { timeout: 20000 }).catch(() => {})
await page.click(crew)
await page.click('.crewrow .modelchip >> nth=0')
await page.waitForSelector('.effortsteps')
await page.click('.effortreset')
await page.waitForTimeout(300)
check((await page.textContent('.effortname')) === 'Default', 'Default puts the level back')
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
args = await send('Second message')
check(args.length > 0 && !args.includes('--effort'), 'with Default no level is sent')

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
