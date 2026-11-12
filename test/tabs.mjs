import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

// A browser page per agent, in a real Electron: two agents work at once without meeting, the
// guards hold on every page, hidden pages stay hidden, and pages are closed and capped.
// node test/tabs.mjs
const out = mkdtempSync(join(tmpdir(), 'lunchbox-tabs-'))
const work = join(out, 'work')
mkdirSync(work)
symlinkSync(tmpdir(), join(work, 'away'))
await build({ entryPoints: ['electron/browser.ts'], outfile: join(out, 'browser.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'warning' })
writeFileSync(join(out, 'main.cjs'), `
const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const { Browser } = require('./browser.cjs')
const MAX_AGENT_TABS = 6, YOU = 'you'
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const lines = []
  const check = (name, ok, more = '') => { lines.push((ok ? 'ok   ' : 'FAIL ') + name + (more ? ' ' + more : '')); console.log(lines[lines.length - 1]) }
  // Every page answers slowly, so two agents are certain to be mid-load at the same moment.
  const server = http.createServer((req, res) => setTimeout(() => res.writeHead(200, { 'content-type': 'text/html' }).end('<title>' + req.url.slice(1) + '</title><h1>Page ' + req.url.slice(1) + '</h1>' + (req.url === '/form' ? '<input name="q">' : '<a href="/next-' + req.url.slice(1) + '">go on</a>')), 250))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port
  const win = new BrowserWindow({ show: process.env.SHOW !== '0', width: 1000, height: 700 })
  const states = []
  const b = new Browser(() => win, (_c, s) => states.push(s))
  const tool = (who, room, name) => b.tools(who, ${JSON.stringify(work)}, room).find((t) => t.name === name)
  try {
    const [a, c] = await Promise.all([tool('claude', 'r1', 'browser_open').run({ url: base + '/claude' }), tool('codex', 'r1', 'browser_open').run({ url: base + '/codex' })])
    check('claude reads its own page', a.startsWith('claude\\n') && a.includes('# Page claude'))
    check('codex reads its own page, laid out at full size though nobody is looking', c.startsWith('codex\\n') && c.includes('# Page codex'))
    // One clicks on while the other reads: neither sees the other's page.
    const [a2, c2] = await Promise.all([tool('claude', 'r1', 'browser_click').run({ ref: 1 }), tool('codex', 'r1', 'browser_read').run({})])
    check('a click moves only the page it was made on', a2.startsWith('next-claude\\n') && c2.startsWith('codex\\n'), JSON.stringify(a2.slice(0, 60)))
    await tool('codex', 'r1', 'browser_open').run({ url: base + '/form' })
    await tool('codex', 'r1', 'browser_type').run({ ref: 1, text: 'hello there' })
    const typed = await tool('codex', 'r1', 'browser_console').run({ expression: 'document.querySelector("input").value' })
    check('typing reaches a page nobody is looking at', typed.includes('hello there'), typed)
    await tool('codex', 'r1', 'browser_open').run({ url: base + '/codex' })
    const same = await tool('claude', 'r2', 'browser_read').run({})
    check('the same agent in another room starts on a blank page', !same.includes('Page'))
    let s = b.state()
    check('one tab per agent per room', s.tabs.map((t) => t.id).join() === 'r1:claude,r1:codex,r2:claude', s.tabs.map((t) => t.id).join())
    check('the first agent page comes to the front', s.active === 'r1:claude', String(s.active))
    check('a tab said what its agent was doing', states.some((x) => x.tabs.some((t) => t.id === 'r1:codex' && t.busy && /^Opening /.test(t.action || ''))))

    const shown = () => win.contentView.children.filter((v) => v.getVisible()).length
    check('nothing is drawn while the Browser page is closed', shown() === 0, String(shown()))
    b.place({ x: 200, y: 100, width: 600, height: 400 })
    check('only the page in front is drawn', shown() === 1 && win.contentView.children.length === 3, shown() + ' of ' + win.contentView.children.length)
    b.select('r1:codex')
    check('switching tabs swaps which page is drawn', shown() === 1 && b.state().active === 'r1:codex')

    await b.open(base + '/mine')
    check('the address bar acts on the page in front', b.state().tabs.find((t) => t.id === 'r1:codex').url.endsWith('/mine'))
    b.select(YOU)
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', '169.254.169.254/latest', 'http://0.0.0.0:1/']) {
      await b.open(bad)
      check('refuses ' + bad, !b.state().tabs.some((t) => /passwd|javascript|169\\.254|0\\.0\\.0\\.0/.test(t.url)))
    }
    const refused = await tool('claude', 'r1', 'browser_open').run({ url: 'file:///etc/passwd' })
    check('an agent cannot open a file either', !refused.includes('root:'))
    let escaped = ''
    try { escaped = await tool('claude', 'r1', 'browser_screenshot').run({ file: 'away/lunchbox-escape.png' }) } catch (e) { escaped = 'refused' }
    check('a screenshot cannot leave the folder through a link', escaped === 'refused', escaped)
    const saved = await tool('claude', 'r1', 'browser_screenshot').run({ file: 'shots/home.png' })
    check('a screenshot of a hidden page is saved', saved.includes('shots/home.png') && require('fs').statSync(${JSON.stringify(work)} + '/shots/home.png').size > 500, saved)

    for (let i = 3; i <= 9; i++) await tool('grok', 'r' + i, 'browser_read').run({})
    s = b.state()
    const agents = s.tabs.filter((t) => t.who !== YOU)
    check('agent pages stop at the limit', agents.length === MAX_AGENT_TABS, String(agents.length))
    check('the pages unused longest went first', !agents.some((t) => t.id === 'r1:codex' || t.id === 'r2:claude') && agents.some((t) => t.id === 'r9:grok'), agents.map((t) => t.id).join())
    check('closed pages left the window', win.contentView.children.length === s.tabs.length, win.contentView.children.length + ' views for ' + s.tabs.length + ' tabs')

    b.closeRoom('r9')
    check('a room that ends takes its pages with it', !b.state().tabs.some((t) => t.room === 'r9'))
    b.close('r8:grok')
    check('closing a tab removes its page', !b.state().tabs.some((t) => t.id === 'r8:grok'))
    const again = await tool('grok', 'r8', 'browser_read').run({})
    check('an agent whose tab was closed gets a fresh page', typeof again === 'string' && b.state().tabs.some((t) => t.id === 'r8:grok'))
    b.destroy()
    check('quitting the window closes every page', b.state().tabs.length === 0 && win.contentView.children.length === 0)
  } catch (e) { check('threw: ' + (e && e.stack || e), false) }
  server.close()
  app.exit(lines.some((l) => l.startsWith('FAIL')) ? 1 : 0)
})
`)
const r = spawnSync(createRequire(import.meta.url)('electron'), [join(out, 'main.cjs')], { encoding: 'utf8', timeout: 60000 })
console.log(r.stdout.trim())
if (r.status !== 0) console.log('status', r.status, r.signal, r.error?.message, r.stderr.split('\n').slice(-8).join('\n'))
process.exit(r.status ?? 1)
