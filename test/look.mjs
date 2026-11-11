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
