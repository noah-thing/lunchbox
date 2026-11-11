import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, WebContentsView, type Rectangle } from 'electron'
import type { Tool } from './hands'
import { AXE_RUN, MEASURE, report, type Axe, type Measured } from './audit'

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

// Every step inside a page Expert looks at has a limit, so a page that freezes cannot hold up
// every later look.
const within = <T,>(job: Promise<T>, ms: number, what: string) =>
  Promise.race([job, new Promise<never>((_, no) => setTimeout(() => no(new Error(`${what} took longer than ${ms / 1000} seconds`)), ms))])

const web = (u: string) => /^https?:\/\//i.test(u) && !/^https?:\/\/(169\.254\.|0\.0\.0\.0|\[?::\]?)/i.test(u)

// axe-core, read once on first use. It is the accessibility engine most checkers are built on.
let axeSource: string | null = null
const axe = () => (axeSource ??= readFileSync(createRequire(__filename).resolve('axe-core/axe.min.js'), 'utf8'))

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
    // Pages open new windows in the same view, and only on the web: never file:, app or
    // javascript: schemes, whether a person clicks or a page or an agent asks.
    wc.setWindowOpenHandler(({ url }) => { if (web(url)) wc.loadURL(url); return { action: 'deny' } })
    wc.on('will-navigate', (e, url) => { if (!web(url)) e.preventDefault() })
    wc.on('will-redirect', (e, url) => { if (!web(url)) e.preventDefault() })
    // Camera, microphone, location, notifications: no page in the agent browser gets them.
    wc.session.setPermissionRequestHandler((_w, _p, done) => done(false))
    wc.session.setPermissionCheckHandler(() => false)
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
    const u = url.trim()
    // localhost:3000 looks like a scheme to a naive test, so a host and port is checked first.
    const target = /^(localhost|127\.\d+\.\d+\.\d+|\d+\.\d+\.\d+\.\d+)(:\d+)?(\/|$)/i.test(u) ? `http://${u}`
      : /^https?:\/\//i.test(u) ? u
      : /^[a-z][\w+.-]*:/i.test(u) && !/^[\w.-]+:\d+/.test(u) ? null
      : /\s/.test(u) || !u.includes('.') ? `https://duckduckgo.com/?q=${encodeURIComponent(u)}` : `https://${u}`
    // Only web pages: file:, javascript: and app schemes never load here.
    if (!target) return wc.getURL()
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

  // Studio looks at pages in a window nobody sees, so it never takes over the browser the person
  // is watching. It has the same limits as that browser: the web or a file inside the room's
  // folder, no camera, microphone or location, and nowhere else to navigate to. One at a time.
  private looking: Promise<unknown> = Promise.resolve()
  private queueLook<T>(job: () => Promise<T>) {
    const next = this.looking.then(job)
    this.looking = next.catch(() => {})
    return next
  }

  private target(workspace: string, target: string) {
    if (/^https?:\/\//i.test(target)) {
      if (!web(target)) throw new Error('That address cannot be opened')
      return target
    }
    if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(target)) return `http://${target}`
    const root = realpathSync(resolve(workspace))
    let file: string
    try { file = realpathSync(resolve(root, target)) } catch { throw new Error(`There is no ${target} in the room's folder`) }
    if (!file.startsWith(root + sep)) throw new Error('Local files to look at must be inside the room\'s folder')
    return pathToFileURL(file).href
  }

  private async hidden(url: string, label: string, width: number, height: number) {
    const win = new BrowserWindow({ show: false, width, height, useContentSize: true, enableLargerThanScreen: true, paintWhenInitiallyHidden: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'look', backgroundThrottling: false } })
    const wc = win.webContents
    const errors: string[] = []
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    const stay = (e: Electron.Event, to: string) => { if (to !== url && !web(to) && !to.startsWith(url.split('#')[0])) e.preventDefault() }
    wc.on('will-navigate', stay)
    wc.on('will-redirect', stay)
    wc.session.setPermissionRequestHandler((_w, _p, done) => done(false))
    wc.session.setPermissionCheckHandler(() => false)
    wc.on('console-message', (...args: unknown[]) => {
      // Newer Electron passes one details object, older ones (event, level, message).
      const d = args[0] as { level?: string | number; message?: string }
      const level = typeof args[1] === 'number' ? args[1] : d?.level
      const message = typeof args[2] === 'string' ? args[2] : d?.message
      if ((level === 3 || level === 'error') && message) errors.push(String(message).slice(0, 200))
    })
    // A page that never finishes loading must not hold up every later look.
    const timeout = new Promise<never>((_, no) => setTimeout(() => no(new Error('it did not finish loading within 20 seconds')), 20000))
    try {
      await Promise.race([wc.loadURL(url), timeout])
      await this.settle(wc)
      await Promise.race([wc.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true', true), new Promise((r) => setTimeout(r, 3000))]).catch(() => {})
    } catch (e) {
      win.destroy()
      throw new Error(`Could not open ${label}: ${e instanceof Error ? e.message : e}`)
    }
    return { win, wc, errors }
  }

  look(workspace: string, target: string, full: boolean, name: string) {
    return this.queueLook(async () => {
      const url = this.target(workspace, target)
      const root = realpathSync(resolve(workspace))
      const stem = (name || 'look').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'look'
      const saved: string[] = []
      const { win, wc } = await this.hidden(url, target, 1440, 900)
      // The page as people see it, without the scrollbar drawn into every picture.
      await within(wc.insertCSS('::-webkit-scrollbar { display: none !important }'), 5000, 'Preparing the page').catch(() => {})
      try {
        // One window, resized between the widths, so the page loads once and media queries apply.
        for (const [label, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]] as const) {
          win.setContentSize(width, height)
          await new Promise((r) => setTimeout(r, 400))
          // A whole page is seen the way a person scrolls it, one screen at a time, eight at most.
          // Growing the window instead would stretch anything sized to the screen, like a hero.
          const tall = full ? Number(await within(wc.executeJavaScript('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)', true), 15000, 'Measuring the page').catch(() => height)) || height : height
          const pieces = full ? Math.min(8, Math.ceil(tall / height)) : 1
          mkdirSync(join(root, 'looks'), { recursive: true })
          for (let i = 0; i < pieces; i++) {
            // Scrolled into place and two frames drawn before the capture: a hidden window does not
            // repaint on its own, and the picture would show where the page was before.
            await within(wc.executeJavaScript(`scrollTo({ top: ${i * height}, behavior: 'instant' }); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`, true), 5000, 'Scrolling the page').catch(() => {})
            wc.invalidate()
            // Entrance animations and lazy images get a moment, as a person's eye would.
            await new Promise((r) => setTimeout(r, i ? 350 : 700))
            // Saved at one pixel per CSS pixel: a model shrinks a huge Retina image until the text is unreadable.
            const shot = await within(wc.capturePage(), 15000, 'Capturing the page')
            const img = shot.getSize().width > width ? shot.resize({ width, quality: 'best' }) : shot
            const file = join(root, 'looks', `${stem}-${label}${full ? `-${i + 1}` : ''}.png`)
            writeFileSync(file, img.toPNG())
            saved.push(relative(root, file))
          }
        }
      } finally {
        win.destroy()
      }
      return `Saved ${saved.length > 2 ? `${saved.length} images, top to bottom: ` : ''}${saved.join(saved.length > 2 ? ', ' : ' and ')}.${full ? ' The last image of each width ends at the bottom of the page, so it can repeat part of the one before it.' : ''} Open them now and judge them as the person will see them: hierarchy, spacing, alignment, contrast, overflow and anything cut off or overlapping at phone width.`
    })
  }

  audit(workspace: string, target: string) {
    return this.queueLook(async () => {
      const url = this.target(workspace, target)
      const { win, wc, errors } = await this.hidden(url, target, 1440, 900)
      try {
        const views: Measured[] = []
        let found: Axe[] | null = null
        for (const [width, height] of [[1440, 900], [390, 844]] as const) {
          win.setContentSize(width, height)
          await new Promise((r) => setTimeout(r, 600))
          views.push(await within(wc.executeJavaScript(MEASURE, true), 15000, 'Measuring the page') as Measured)
          if (!found) {
            found = await within(wc.executeJavaScript(`${axe()};\n${AXE_RUN}`, true), 20000, 'The accessibility check').catch(() => null) as Axe[] | null
          }
        }
        return report(target, views, found, errors)
      } finally {
        win.destroy()
      }
    })
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
        name: 'expert_look',
        description: 'Look at your work the way people will see it: opens a URL (localhost works) or an HTML file in the folder in a hidden window, and saves screenshots at desktop (1440px) and phone (390px) width. Set full for the whole page top to bottom. Returns the image paths; open the images to judge the result.',
        input: {
          target: { type: 'string', description: 'A URL, a localhost address such as localhost:3000, or a path to an HTML file inside the folder' },
          full: { type: 'boolean', description: 'Capture the whole page top to bottom instead of the first screen' },
          name: { type: 'string', description: 'A short name for the image files, such as home or pricing' },
        },
        required: ['target'],
        run: (a) => this.look(workspace, String(a.target ?? ''), a.full === true, typeof a.name === 'string' ? a.name : ''),
      },
      {
        name: 'expert_audit',
        description: 'Measure a page instead of judging it by eye, at desktop and phone width: sideways scrolling, overlapping or cut off text, small text and tap targets, long lines, broken or unsized images, the fonts, sizes and colours actually in use, spacing off a 4px grid, console errors, and accessibility through axe-core (WCAG 2.2 AA, including contrast). Returns a numbered list of problems with the elements they are on.',
        input: { target: { type: 'string', description: 'A URL, a localhost address such as localhost:3000, or a path to an HTML file inside the folder' } },
        required: ['target'],
        run: (a) => this.audit(workspace, String(a.target ?? '')),
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
