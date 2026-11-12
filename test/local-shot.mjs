import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A local model working in a room's folder with tools, against a stand-in Ollama server: the live
// status line, the steps on its turn, and an edit waiting for a yes in Ask mode.
// node test/local-shot.mjs
const root = new URL('..', import.meta.url).pathname
const out = root + 'test/shots/local-'
mkdirSync(root + 'test/shots', { recursive: true })
const temp = (name) => mkdtempSync(join(tmpdir(), `lunchbox-${name}-`))
const bin = temp('bin')
const work = temp('work')
writeFileSync(join(work, 'sum.js'), 'console.log(1 + 1)\n')
chmodSync(root + 'test/fake-agent.mjs', 0o755)
// Every command line agent is a stand-in, so nothing real is ever called.
for (const name of ['claude', 'codex', 'grok', 'gemini']) symlinkSync(root + 'test/fake-agent.mjs', `${bin}/${name}`)

const call = (name, args) => ({ message: { content: '', tool_calls: [{ function: { name, arguments: args } }] } })
const say = (content) => ({ message: { content } })
let script = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (b) => (body += b))
  req.on('end', () => {
    if (req.url === '/api/version') return res.end('{"version":"0.32.0"}')
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'coder:27b' }] }))
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion', 'tools'], model_info: { 'llama.context_length': 32768 } }))
    const next = script.shift() ?? say('Nothing more to do.')
    setTimeout(() => { res.write(JSON.stringify(next) + '\n'); res.end(JSON.stringify({ done: true, prompt_eval_count: 900, eval_count: 40 }) + '\n') }, 1300)
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${temp('profile')}`], cwd: root,
  env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_WORKSPACE: work, LUNCHBOX_PATH: `${bin}:${process.env.PATH}`, OLLAMA_HOST: `127.0.0.1:${server.address().port}` },
  timeout: 30000,
})
const kill = setTimeout(() => { console.log('timed out'); app.close().finally(() => process.exit(1)) }, 110000)
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
await page.waitForSelector('.onboard')
for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(i ? 900 : 2600) }
await page.waitForSelector('.newroom')

script = [
  { message: { content: 'I will read it, change it and run it.\n\n- [ ] Read sum.js\n- [ ] Make it print 4\n- [ ] Run it\n', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'sum.js' } } }] } },
  { message: { content: '- [x] Read sum.js\n', tool_calls: [{ function: { name: 'edit_file', arguments: { path: 'sum.js', find: '1 + 1', replace: '2 + 2' } } }] } },
  { message: { content: '- [x] Make it print 4\n', tool_calls: [{ function: { name: 'run_command', arguments: { command: 'node sum.js' } } }] } },
  say('- [x] Run it\n\nsum.js prints 4 now. I ran it to check.'),
]
await page.click('.composer textarea')
await page.keyboard.type('@ollama make sum.js print 4, then run it')
await page.keyboard.press('Enter')
await page.waitForSelector('.room')
await page.waitForTimeout(2300)
await page.screenshot({ path: out + '1-working.png' })
const said = (n) => page.waitForFunction((n) => window.lb.call('rooms').then((r) => window.lb.call('room', r[0].id)).then((r) => !r.live.turns.length && r.events.filter((e) => e.kind === 'say').length >= n), n, { timeout: 30000 })
await page.waitForTimeout(1500)
await said(1)
await page.waitForTimeout(1500)
await page.screenshot({ path: out + '2-done.png' })

// Ask mode: the edit waits for the person.
script = [call('write_file', { path: 'notes.md', content: '# Notes\n' }), say('The notes file is in place.')]
await page.click('.cbar button[aria-label^="Mode"]')
await page.click('.menu .item:has-text("Ask")')
await page.click('.composer textarea')
await page.keyboard.type('@ollama add a notes.md file')
await page.keyboard.press('Enter')
await page.waitForSelector('.evrun', { timeout: 15000 })
await page.waitForTimeout(700)
await page.screenshot({ path: out + '3-ask-edit.png' })
const before = existsSync(join(work, 'notes.md'))
await page.click('.evrun .ask .btn >> nth=0')
await said(2)
await page.waitForTimeout(1200)
await page.screenshot({ path: out + '4-ask-allowed.png' })

const events = await page.evaluate(() => window.lb.call('rooms').then((r) => window.lb.call('room', r[0].id)).then((r) => r.events.filter((e) => e.kind === 'say').map((e) => ({ who: e.who, text: e.text.slice(0, 80), acts: e.acts.map((a) => a.t + ' ' + (a.path ?? a.command ?? a.detail ?? '')), error: e.error }))))
console.log(JSON.stringify(events, null, 1))
const ok = readFileSync(join(work, 'sum.js'), 'utf8').includes('2 + 2') && !before && existsSync(join(work, 'notes.md')) && events.every((e) => e.who === 'ollama' && !e.error) && !errors.length
console.log('errors:', errors, ok ? 'ok' : 'FAIL')
clearTimeout(kill)
await app.close()
server.close()
process.exit(ok ? 0 : 1)
