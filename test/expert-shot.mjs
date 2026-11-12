import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The same open design request in a normal room and in an Expert room, on the real Claude Code
// with its smallest model, so the difference Expert makes can be seen. This one spends a little
// of the plan on this computer, so it is run by hand: node test/expert-shot.mjs
const root = new URL('..', import.meta.url).pathname
const out = root + 'test/shots/expert-run-'
mkdirSync(root + 'test/shots', { recursive: true })
const temp = (name) => mkdtempSync(join(tmpdir(), `lunchbox-${name}-`))
const ask = 'Make a one page website for Lera, a small ceramics studio in Gustavsberg that sells one kiln load of stoneware each month. A single index.html with inline CSS, no build step and no external images.'

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${temp('profile')}`], cwd: root,
  env: { ...process.env, LB_PLAN_LIMITS: 'off', LB_WORKSPACE: temp('work') },
  timeout: 30000,
})
const page = await app.firstWindow()
await page.waitForSelector('.onboard')
for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(i ? 900 : 2600) }
await page.waitForSelector('.newroom')
const ready = await page.evaluate(() => window.lb.call('agents').then((a) => a.find((x) => x.id === 'claude')?.ready))
if (!ready) { console.log('Claude Code is not installed here, so there is nothing to compare.'); await app.close(); process.exit(0) }
await page.evaluate((model) => window.lb.call('settings:set', { models: { claude: model }, browser: true }), process.env.EXPERT_MODEL || 'haiku')

const rooms = {}
for (const kind of ['normal', 'expert']) {
  const dir = temp(kind)
  const id = await page.evaluate(({ dir, studio }) => window.lb.call('room:create', { crew: ['claude'], workspace: dir, studio, name: studio ? 'Lera, Expert' : 'Lera' }).then((r) => r.id), { dir, studio: kind === 'expert' })
  await page.evaluate(({ id, ask }) => window.lb.call('room:send', id, ask, 'workspace', false), { id, ask })
  rooms[kind] = { id, dir, t0: Date.now() }
}
const state = (id) => page.evaluate((id) => window.lb.call('room', id).then((r) => ({ busy: r.live.turns.length > 0 || r.live.runs.length > 0, says: r.events.filter((e) => e.kind === 'say'), decide: r.events.some((e) => e.kind === 'decide') })), id)
const limit = Date.now() + 14 * 60000
for (const kind of Object.keys(rooms)) {
  for (;;) {
    const s = await state(rooms[kind].id)
    if ((!s.busy && s.says.length) || Date.now() > limit) { rooms[kind].says = s.says; rooms[kind].ms = Date.now() - rooms[kind].t0; break }
    await page.waitForTimeout(3000)
  }
}
for (const [kind, r] of Object.entries(rooms)) {
  // The page may be at the top of the folder or in one the agent made for it.
  const file = [r.dir, ...readdirSync(r.dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'looks').map((e) => join(r.dir, e.name))].map((d) => join(d, 'index.html')).find((f) => existsSync(f)) ?? join(r.dir, 'index.html')
  const usage = r.says.reduce((u, e) => ({ input: u.input + (e.usage?.input ?? 0) + (e.usage?.cached ?? 0), output: u.output + (e.usage?.output ?? 0), cost: u.cost + (e.usage?.cost ?? 0) }), { input: 0, output: 0, cost: 0 })
  const tools = r.says.flatMap((e) => e.acts ?? []).filter((a) => a.t === 'tool').map((a) => a.name.replace('mcp__lunchbox__', ''))
  console.log(`\n== ${kind}: ${Math.round(r.ms / 1000)} s, ${usage.input} tokens in, ${usage.output} out, $${usage.cost.toFixed(3)} at API prices`)
  console.log('expert tools used:', tools.filter((t) => t.startsWith('expert_')).join(', ') || 'none')
  console.log('said:', (r.says.at(-1)?.text ?? '').slice(0, 900))
  if (existsSync(join(r.dir, 'looks/direction.md'))) { copyFileSync(join(r.dir, 'looks/direction.md'), `${out}${kind}-direction.md`); console.log('direction:\n' + readFileSync(join(r.dir, 'looks/direction.md'), 'utf8')) }
  if (!existsSync(file)) { console.log('no index.html was written'); continue }
  copyFileSync(file, `${out}${kind}.html`)
  for (const [label, w, h] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
    const png = await app.evaluate(async ({ BrowserWindow }, { file, w, h }) => {
      const win = new BrowserWindow({ show: false, width: w, height: h, useContentSize: true, webPreferences: { sandbox: true } })
      await win.loadFile(file)
      await new Promise((r) => setTimeout(r, 1200))
      const img = await win.webContents.capturePage()
      win.destroy()
      return (img.getSize().width > w ? img.resize({ width: w }) : img).toPNG().toString('base64')
    }, { file, w, h })
    writeFileSync(`${out}${kind}-${label}.png`, Buffer.from(png, 'base64'))
  }
}
await app.close()
