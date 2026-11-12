import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// expert_look in a real Electron: a local page captured at desktop and phone width, then full
// length, and a path outside the folder refused. node test/look.mjs
// Built under node_modules/.cache: axe-core resolves from there as it does in the app, and
// nothing in it is ever packaged.
const out = new URL('../node_modules/.cache/lunchbox-look-test/', import.meta.url).pathname
mkdirSync(out, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'lunchbox-look-work-'))
writeFileSync(join(work, 'page.html'), `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><style>body{margin:0;font:18px system-ui;background:#f4f1ea;color:#1b1a18}section{min-height:120vh;padding:48px}h1{font-size:clamp(32px,6vw,72px);margin:0}</style><section><h1>Studio look</h1><p>First screen.</p></section><section><p>Below the fold.</p></section>`)
// A page with problems the audit must find: sideways scroll, overlapping text, tiny tap targets,
// low contrast, an image without dimensions and a console error.
writeFileSync(join(work, 'messy.html'), `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Messy</title><style>body{margin:0;font:16px Georgia}.wide{width:1600px;height:20px;background:#eee}.a{position:absolute;top:100px;left:20px;font:24px Arial}.b{position:absolute;top:106px;left:30px;font:13px Verdana}.low{color:#bbb;background:#fff}a.tiny{font-size:10px}</style><div class=wide></div><p class=a>Overlapping heading</p><p class=b>Overlapping caption</p><p class=low style="margin-top:180px">Light grey text on white</p><a class=tiny href="#x">x</a><img src="missing.png" alt="Missing"><p>Read the <a href="#more">notes</a> before you start, they explain everything that follows.</p><script>console.error('boom: something failed')</script>`)
{
  const { symlinkSync } = await import('node:fs')
  symlinkSync('/etc/hosts', join(work, 'link.html'))
}
writeFileSync(join(work, 'states.html'), `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>States</title><style>
body{margin:0;font:16px system-ui;background:#fbfaf7}nav{display:flex;gap:24px;padding:20px 32px;white-space:nowrap;overflow:hidden;width:100%;box-sizing:border-box}
nav a{color:#222;text-decoration:none}
.good{margin:40px 32px;padding:12px 20px;border:0;border-radius:8px;background:#1b1a18;color:#fff;font:15px system-ui}
.good:hover{background:#3a3833}.good:focus-visible{outline:3px solid #2d6cdf;outline-offset:2px}
.flat{margin:0 32px;color:#555;outline:none}</style>
<nav><a href="#a">Pricing</a><a href="#b">Customers</a><a href="#c">Documentation</a><a href="#d">Changelog</a></nav>
<button class="good">Start free</button><a class="flat" href="#x">Read the docs</a>`)
writeFileSync(join(work, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="6" y="6" width="52" height="52" rx="14" fill="#e8553d"/><circle cx="32" cy="32" r="12" fill="#fff"/></svg>')
// A real model when the network allows; the test still runs without it.
try {
  const r = await fetch('https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Duck/glTF-Binary/Duck.glb')
  if (r.ok) writeFileSync(join(work, 'duck.glb'), Buffer.from(await r.arrayBuffer()))
} catch {}
// expert_view loads three.js from vendor/ next to the bundle, as the app does from out/.
await import('node:fs').then(({ cpSync }) => cpSync(new URL('../out/vendor', import.meta.url).pathname, join(out, 'vendor'), { recursive: true }))
await build({ entryPoints: ['electron/browser.ts'], outfile: join(out, 'browser.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'warning' })
writeFileSync(join(out, 'main.cjs'), `
const { app } = require('electron')
const { Browser } = require('./browser.cjs')
// Lunchbox always has its main window; here the hidden look window is the only one.
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const b = new Browser(() => null, () => {})
  const report = []
  try {
    report.push(await b.look(${JSON.stringify(work)}, 'page.html', false, 'Home Page'))
    report.push(await b.look(${JSON.stringify(work)}, 'page.html', true, 'home'))
    report.push(await b.states(${JSON.stringify(work)}, 'states.html', 'states'))
    report.push(await b.inspect(${JSON.stringify(work)}, 'mark.svg', 'mark'))
    if (require('fs').existsSync(${JSON.stringify(work)} + '/duck.glb')) report.push(await b.inspect(${JSON.stringify(work)}, 'duck.glb', 'duck'))
    try { await b.inspect(${JSON.stringify(work)}, 'page.html', 'x'); report.push('HTML NOT REFUSED') } catch (e) { report.push('view refused html: ' + e.message.slice(0, 60)) }
    report.push(await b.audit(${JSON.stringify(work)}, 'messy.html'))
    try { await b.look(${JSON.stringify(work)}, 'link.html', false, 'x'); report.push('SYMLINK NOT REFUSED') } catch (e) { report.push('symlink refused: ' + e.message) }
    try { await b.look(${JSON.stringify(work)}, 'http://169.254.169.254/latest', false, 'x'); report.push('METADATA NOT REFUSED') } catch (e) { report.push('metadata refused: ' + e.message) }
    try { await b.look(${JSON.stringify(work)}, '../outside.html', false, 'x'); report.push('NOT REFUSED') } catch (e) { report.push('refused: ' + e.message) }
  } catch (e) { report.push('FAILED: ' + e.message) }
  console.log(report.join('\\n'))
  app.quit()
})
`)
const r = spawnSync(createRequire(import.meta.url)('electron'), [join(out, 'main.cjs')], { encoding: 'utf8', timeout: 60000 })
console.log('status', r.status, r.signal, r.error?.message); console.log(r.stdout.trim()); console.log(r.stderr.split('\n').slice(-8).join('\n'))
console.log('work:', work)
