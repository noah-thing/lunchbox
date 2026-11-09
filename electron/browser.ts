import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { WebContentsView, type BrowserWindow, type Rectangle } from 'electron'
import type { Tool } from './hands'

export type BrowserState = { url: string; title: string; loading: boolean; back: boolean; forward: boolean; driver?: string; action?: string; device: Device; shown: boolean }
export type Device = 'desktop' | 'tablet' | 'phone'

const DEVICES: Record<Device, { ua?: string }> = {
  desktop: {},
  tablet: { ua: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  phone: { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
}

const HOME = 'about:blank'
const READ_LIMIT = 24000

// Runs in the page. Numbers every element a person could use, and returns the page as an outline
// an agent can read: headings, text, and [n] before each link, button and field.
const OUTLINE = `(() => {
  const out = []; let n = 0; let size = 0
  document.querySelectorAll('[data-lb-ref]').forEach((e) => e.removeAttribute('data-lb-ref'))
  const usable = (e) => e.matches('a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable=true],[onclick]')
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
  const label = (e) => (e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || e.title || e.alt || e.name || '').replace(/\\s+/g, ' ').trim().slice(0, 120)
  const push = (line) => { if (size < ${READ_LIMIT}) { out.push(line); size += line.length } }
  const walk = (node, depth) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { const t = c.textContent.replace(/\\s+/g, ' ').trim(); if (t && t.length > 1) push(t); continue }
      if (c.nodeType !== 1 || ['SCRIPT','STYLE','NOSCRIPT','SVG','TEMPLATE'].includes(c.tagName)) continue
      if (!visible(c)) continue
      if (usable(c)) {
        const ref = ++n; c.setAttribute('data-lb-ref', ref)
        const kind = c.tagName === 'A' ? 'link' : c.tagName === 'INPUT' ? (c.type || 'text') + ' field' : c.tagName === 'TEXTAREA' ? 'text area' : c.tagName === 'SELECT' ? 'select' : 'button'
        push('[' + ref + '] ' + kind + ': ' + (label(c) || '(no label)') + (c.tagName === 'A' ? ' -> ' + c.getAttribute('href') : '') + (c.value && c.tagName !== 'BUTTON' ? ' = "' + String(c.value).slice(0, 80) + '"' : ''))
        if (c.tagName === 'A' || c.tagName === 'BUTTON') continue
      }
      if (/^H[1-6]$/.test(c.tagName)) { push('#'.repeat(+c.tagName[1]) + ' ' + label(c)); continue }
      walk(c, depth + 1)
    }
  }
  walk(document.body || document.documentElement, 0)
  return { title: document.title, url: location.href, text: out.join('\\n'), refs: n, truncated: size >= ${READ_LIMIT} }
})()`

const pointAt = (ref: number) => `(() => {
  const e = document.querySelector('[data-lb-ref="${ref}"]')
  if (!e) return null
  e.scrollIntoView({ block: 'center', inline: 'center' })
  const r = e.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: e.tagName }
})()`

// A pulse where the agent is about to click, so a person watching can follow along.
const pulse = (x: number, y: number) => `(() => {
  const d = document.createElement('div')
  d.style.cssText = 'position:fixed;left:${x - 14}px;top:${y - 14}px;width:28px;height:28px;border-radius:50%;border:2px solid #f2f0ea;box-shadow:0 0 0 2px #0d0d0c;pointer-events:none;z-index:2147483647;transition:transform .5s cubic-bezier(.23,1,.32,1),opacity .5s'
  document.documentElement.appendChild(d)
  requestAnimationFrame(() => { d.style.transform = 'scale(1.8)'; d.style.opacity = '0' })
  setTimeout(() => d.remove(), 600)
})()`

export class Browser {
  private view: WebContentsView | null = null
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
  private shown = false
  private device: Device = 'desktop'
  private driver?: string
  private action?: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private win: () => BrowserWindow | null, private emit: (channel: string, payload: unknown) => void) {}

  private ensure() {
    const win = this.win()
    if (!win) throw new Error('The window is closed')
    if (this.view && !this.view.webContents.isDestroyed()) return this.view
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'persist:browser', backgroundThrottling: false } })
    view.setBackgroundColor('#00000000')
    const wc = view.webContents
    wc.setWindowOpenHandler(({ url }) => { wc.loadURL(url); return { action: 'deny' } })
    for (const e of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'] as const) wc.on(e as 'did-start-loading', () => this.changed())
    win.contentView.addChildView(view)
    this.view = view
    this.layout()
    wc.loadURL(HOME)
    return view
  }

  state(): BrowserState {
    const wc = this.view?.webContents
    const alive = wc && !wc.isDestroyed()
    return {
      url: alive && wc.getURL() !== HOME ? wc.getURL() : '',
      title: alive ? wc.getTitle() : '',
      loading: alive ? wc.isLoading() : false,
      back: alive ? wc.navigationHistory.canGoBack() : false,
      forward: alive ? wc.navigationHistory.canGoForward() : false,
      driver: this.driver, action: this.action, device: this.device, shown: this.shown,
    }
  }

  private changed() {
    this.emit('browser', this.state())
  }

  // The renderer owns the frame; the page is drawn into the hole it leaves, sized to the device.
  place(bounds: Rectangle | null) {
    this.shown = !!bounds
    if (bounds) this.bounds = bounds
    if (bounds && !this.view) this.ensure()
    this.layout()
    this.changed()
  }

  private layout() {
    if (!this.view) return
    const b = this.bounds
    // Hidden, the page keeps a real size so agents can still read it and take screenshots.
    const size = b.width > 0 ? b : { x: 0, y: 0, width: 1280, height: 800 }
    this.view.setBounds({ x: Math.round(size.x), y: Math.round(size.y), width: Math.round(size.width), height: Math.round(size.height) })
    this.view.setVisible(this.shown)
  }

  // Dev servers already running on this computer, for the start page.
  async local() {
    const ports = [3000, 3001, 4173, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8888]
    const alive = await Promise.all(ports.map(async (p) => {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(700), redirect: 'manual' })
        const html = r.headers.get('content-type')?.includes('html') ? await r.text() : ''
        return { port: p, title: html.match(/<title[^>]*>([^<]{1,80})/i)?.[1]?.trim() ?? '' }
      } catch { return null }
    }))
    return alive.filter((x): x is { port: number; title: string } => !!x)
  }

  setDevice(d: Device) {
    this.device = d
    const wc = this.ensure().webContents
    wc.setUserAgent(DEVICES[d].ua ?? wc.session.getUserAgent())
    this.layout()
    if (wc.getURL() !== HOME) wc.reload()
    this.changed()
  }

  async open(url: string) {
    const wc = this.ensure().webContents
    const target = /^[a-z][\w+.-]*:/i.test(url) ? url : /^localhost|^127\.|^\d+\.\d+\.\d+\.\d+/.test(url) ? `http://${url}` : /\s/.test(url) || !url.includes('.') ? `https://duckduckgo.com/?q=${encodeURIComponent(url)}` : `https://${url}`
    await wc.loadURL(target).catch(() => {})
    this.changed()
    return wc.getURL()
  }

  nav(kind: 'back' | 'forward' | 'reload' | 'stop') {
    const wc = this.view?.webContents
    if (!wc || wc.isDestroyed()) return
    if (kind === 'back') wc.navigationHistory.goBack()
    if (kind === 'forward') wc.navigationHistory.goForward()
    if (kind === 'reload') wc.reload()
    if (kind === 'stop') wc.stop()
  }

  devtools() {
    this.view?.webContents.openDevTools({ mode: 'detach' })
  }

  async screenshot(file: string) {
    const wc = this.ensure().webContents
    let png: Buffer
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
      const r = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png' })
      png = Buffer.from(r.data, 'base64')
    } catch {
      png = (await wc.capturePage()).toPNG()
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, png)
    return file
  }

  // Agents take turns with the browser: one action at a time, each shown in the frame.
  private drive<T>(who: string, action: string, job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      this.driver = who
      this.action = action
      this.changed()
      try { return await job() } finally {
        this.action = undefined
        this.changed()
        setTimeout(() => { if (!this.action) { this.driver = undefined; this.changed() } }, 2500)
      }
    })
    this.queue = next.catch(() => {})
    return next
  }

  private async settle(wc: Electron.WebContents) {
    const t0 = Date.now()
    while (wc.isLoading() && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 120))
    await new Promise((r) => setTimeout(r, 250))
  }

  private async read(wc: Electron.WebContents) {
    await this.settle(wc)
    const o = await wc.executeJavaScript(OUTLINE, true) as { title: string; url: string; text: string; refs: number; truncated: boolean }
    return `${o.title}\n${o.url}\n\n${o.text}${o.truncated ? '\n\n(The page goes on; scroll or search with browser_find.)' : ''}`
  }

  private async click(wc: Electron.WebContents, ref: number) {
    const at = await wc.executeJavaScript(pointAt(ref), true) as { x: number; y: number } | null
    if (!at) throw new Error(`There is no [${ref}] on the page now. Read the page again to get fresh numbers.`)
    await wc.executeJavaScript(pulse(at.x, at.y), true).catch(() => {})
    await new Promise((r) => setTimeout(r, 160))
    wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y })
    wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  }

  // The tools every agent in a room gets. Screenshots are saved inside the room's folder.
  tools(who: string, workspace: string): Tool[] {
    const wc = () => this.ensure().webContents
    const inside = (p: string) => {
      const abs = resolve(workspace, p)
      if (!abs.startsWith(resolve(workspace) + sep)) throw new Error('Screenshots are saved inside the room\'s folder')
      return abs
    }
    return [
      {
        name: 'browser_open',
        description: 'Open a URL in the Lunchbox browser, which the person can watch. Localhost works, so use it to check a site you are building. Returns the page as text with a number before every link, button and field.',
        input: { url: { type: 'string', description: 'A URL, a localhost address or words to search for' } },
        run: (a) => this.drive(who, `Opening ${String(a.url).slice(0, 60)}`, async () => { await this.open(String(a.url)); return this.read(wc()) }),
      },
      {
        name: 'browser_read',
        description: 'Read the page that is open now, as text with numbered links, buttons and fields.',
        input: {},
        run: () => this.drive(who, 'Reading the page', () => this.read(wc())),
      },
      {
        name: 'browser_click',
        description: 'Click a link, button or field by the number browser_read gave it. Returns the page afterwards.',
        input: { ref: { type: 'number', description: 'The number in square brackets' } },
        run: (a) => this.drive(who, `Clicking [${a.ref}]`, async () => { await this.click(wc(), Number(a.ref)); await new Promise((r) => setTimeout(r, 400)); return this.read(wc()) }),
      },
      {
        name: 'browser_type',
        description: 'Type into a field by its number. Set submit to press Enter afterwards.',
        input: { ref: { type: 'number', description: 'The field\'s number' }, text: { type: 'string', description: 'What to type' }, submit: { type: 'boolean', description: 'Press Enter after typing' } },
        required: ['ref', 'text'],
        run: (a) => this.drive(who, `Typing into [${a.ref}]`, async () => {
          const w = wc()
          await this.click(w, Number(a.ref))
          await w.executeJavaScript(`(() => { const e = document.querySelector('[data-lb-ref="${Number(a.ref)}"]'); if (e && 'value' in e) { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })) } })()`, true)
          w.insertText(String(a.text))
          if (a.submit) { w.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); w.sendInputEvent({ type: 'char', keyCode: '\r' }); w.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }) }
          await new Promise((r) => setTimeout(r, 500))
          return this.read(w)
        }),
      },
      {
        name: 'browser_find',
        description: 'Find text on the open page and scroll to it. Returns the lines around each match.',
        input: { text: { type: 'string', description: 'Words to look for' } },
        run: (a) => this.drive(who, `Looking for “${String(a.text).slice(0, 40)}”`, async () => {
          const w = wc()
          w.findInPage(String(a.text))
          const page = await this.read(w)
          const needle = String(a.text).toLowerCase()
          const lines = page.split('\n')
          const hits = lines.flatMap((l, i) => (l.toLowerCase().includes(needle) ? [lines.slice(Math.max(0, i - 1), i + 2).join('\n')] : []))
          setTimeout(() => w.stopFindInPage('keepSelection'), 1500)
          return hits.length ? hits.slice(0, 12).join('\n---\n') : 'Not on this page.'
        }),
      },
      {
        name: 'browser_screenshot',
        description: 'Save a screenshot of the open page as a PNG inside the folder, to check a layout or show the person. Returns the path.',
        input: { file: { type: 'string', description: 'Path inside the folder, for example shots/home.png' } },
        required: [],
        run: (a) => this.drive(who, 'Taking a screenshot', async () => {
          const file = inside(typeof a.file === 'string' && a.file ? a.file : `screenshots/${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
          await this.settle(wc())
          await this.screenshot(file)
          return `Saved ${relative(workspace, file)}`
        }),
      },
      {
        name: 'browser_console',
        description: 'Run a JavaScript expression in the open page and return the result as JSON, for checking state or errors.',
        input: { expression: { type: 'string', description: 'For example document.querySelectorAll("img:not([alt])").length' } },
        run: (a) => this.drive(who, 'Running a check in the page', async () => {
          const r = await wc().executeJavaScript(`(async () => { try { const v = await (${String(a.expression)}); return JSON.stringify(v, null, 2) } catch (e) { return 'Error: ' + e.message } })()`, true)
          return String(r ?? 'undefined').slice(0, 8000)
        }),
      },
    ]
  }

  destroy() {
    this.view?.webContents.close()
    this.view = null
  }
}

export const shotsDir = (workspace: string) => join(workspace, 'screenshots')
