import { randomUUID } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFile, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, screen, shell, type Rectangle } from 'electron'
import type { Access, ChatSource, Connector, Flow, Report, Settings, Skill } from '../shared/types'
import { Count } from './count'
import { agyKeyMode, agySettings, effortsFor, installed, modelsFor, testConnector, useConnectors } from './agents'
import { setBase } from './agents/http'
import { markdown, replay } from './export'
import { Flows } from './flows'
import { fetchPack, importPack, loadPacks, packJson, removePack } from './packs'
import { Hands } from './hands'
import { Remote } from './remote'
import { Engine } from './room/engine'
import { answer, kill, type Answer } from './shell'
import { finishStops, resetPath } from './system'
import { Updates } from './updates'
import { catchErrors, diagnostics, flush, logError, send } from './report'
import { Snapshots } from './snap'
import { Browser, type Device } from './browser'
import { Toolbox } from './tools'
import { Store, type Cipher } from './store'
import { cancelPull, pull, start } from './local'
import { Limits } from './limits'
import { allowed, claudeDir, found, read, resumes, room as roomFrom } from './import'
import { Workshop } from './workshop'
import { commands, expand } from './commands'

app.setName('Lunchbox')
// The person's own build from the Workshop shares the standard app's profile: same rooms, same keys.
if (process.env.LUNCHBOX_USER_DATA) app.setPath('userData', process.env.LUNCHBOX_USER_DATA)
// Electron exposes FedCM but has no browser side for it, so "Continue with Google" buttons fail
// without a word. With it off, Google falls back to its sign-in popup, which the browser opens.
app.commandLine.appendSwitch('disable-blink-features', 'FedCm')

const mac = process.platform === 'darwin'
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
// One process holds every room, so one app runs as many windows as the person wants. What the
// main process sends goes to all of them: two windows on the same room show the same thing.
const wins = new Set<BrowserWindow>()
let last: BrowserWindow | null = null
// The window in front, or the one that was.
const front = () => (last && !last.isDestroyed() ? last : [...wins].at(-1) ?? null)
const anyFocused = () => [...wins].some((w) => w.isFocused())
const emit = (channel: string, value: unknown) => { for (const w of wins) if (!w.isDestroyed()) w.webContents.send(channel, value) }
// The room each window has open, so a notification can bring up the window already on it.
const showing = new Map<BrowserWindow, string>()
// The window the browser's pages are drawn in: the last one that opened the Browser page.
let webHost: BrowserWindow | null = null

// Keys are sealed with the OS keychain where there is one. Some Linux desktops have none, and
// there the key is only encoded, which the Settings page says out loud.
const cipher: Cipher = {
  seal: (t) => (safeStorage.isEncryptionAvailable() ? 'v1:' + safeStorage.encryptString(t).toString('base64') : 'v0:' + Buffer.from(t).toString('base64')),
  open: (s) => (s.startsWith('v1:') ? safeStorage.decryptString(Buffer.from(s.slice(3), 'base64')) : Buffer.from(s.slice(3), 'base64').toString()),
}

let store: Store
let engine: Engine
let limits: Limits
let flows: Flows
let count: Count
let remote: Remote
let browser: Browser
let toolbox: Toolbox
let updates: Updates | undefined
let workshop: Workshop
const packs = () => loadPacks(store.packFiles())
const name = (id: string) => engine.agents.find((a) => a.id === id)?.short ?? id
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'room'

async function saveAs(title: string, file: string, ext: string, contents: string | Buffer) {
  const win = front()
  if (!win) return null
  const r = await dialog.showSaveDialog(win, { title, defaultPath: join(app.getPath('downloads'), file), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] })
  if (r.canceled || !r.filePath) return null
  writeFileSync(r.filePath, contents)
  return r.filePath
}

function defaults() {
  const ready = engine.agents.filter((a) => !engine.why(a.id)).map((a) => a.id)
  const preferred = store.settings.defaultCrew.filter((id) => ready.includes(id))
  return { crew: preferred.length ? preferred : ready.slice(0, 3), workspace: workspace() }
}
// Where the agents keep their own chats. Tests point this at a folder of made-up sessions.
const chatHome = () => process.env.LB_IMPORT_HOME || homedir()
const workspace = () => process.env.LB_WORKSPACE || join(app.getPath('documents'), 'Lunchbox')

// A room without a chosen folder gets its own, named after what it is for:
// ~/Documents/Lunchbox/fix-the-signup-form. Tests set LB_FOLDER=shared to stage files in one place.
function roomFolder(about: string) {
  if (process.env.LB_FOLDER === 'shared') return workspace()
  const slug = about.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, '').trim().split(/\s+/).filter(Boolean).slice(0, 5).join('-').slice(0, 48) || 'room'
  let dir = join(workspace(), slug)
  for (let n = 2; existsSync(dir); n++) dir = join(workspace(), `${slug}-${n}`)
  return dir
}

// Local servers answer at their usual address unless the person, or Ollama's own OLLAMA_HOST,
// says otherwise.
function useEndpoints() {
  const typed = store.settings.endpoints ?? {}
  for (const id of ['ollama', 'lmstudio', 'llamacpp']) setBase(id, typed[id] || (id === 'ollama' ? process.env.OLLAMA_HOST : '') || '')
}

// Where the last window was, so the next launch opens in the same place. Only where a screen
// still is: a display that was unplugged would leave the window out of reach.
const boundsFile = () => join(app.getPath('userData'), 'window.json')
function remembered(): { bounds?: Rectangle; maximized?: boolean } {
  try {
    const b = JSON.parse(readFileSync(boundsFile(), 'utf8'))
    if (![b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n)) || b.width < 400 || b.height < 300) return {}
    const area = screen.getDisplayMatching(b).workArea
    const seen = Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x) >= 120 && b.y >= area.y - 10 && b.y < area.y + area.height - 60
    return seen ? { bounds: { x: b.x, y: b.y, width: b.width, height: b.height }, maximized: !!b.maximized } : {}
  } catch {
    return {}
  }
}
let boundsTimer: NodeJS.Timeout | null = null
function remember(w: BrowserWindow) {
  if (boundsTimer) clearTimeout(boundsTimer)
  boundsTimer = setTimeout(() => {
    boundsTimer = null
    if (w.isDestroyed() || w.isMinimized() || w.isFullScreen()) return
    writeFile(boundsFile(), JSON.stringify({ ...w.getNormalBounds(), maximized: w.isMaximized() }), () => {})
  }, 400)
}

// The first window opens where the last one was. One more opens a step down and to the right of
// the window in front, at its size, so it never lands exactly on top of it.
function spot(): { bounds: Partial<Rectangle>; maximized?: boolean } {
  const near = front()
  if (!near) {
    const r = remembered()
    return { bounds: r.bounds ?? { width: 1440, height: 900 }, maximized: r.maximized }
  }
  const b = near.getNormalBounds()
  const area = screen.getDisplayMatching(b).workArea
  const fits = b.x + 28 + b.width <= area.x + area.width && b.y + 28 + b.height <= area.y + area.height
  return { bounds: { x: fits ? b.x + 28 : area.x + 28, y: fits ? b.y + 28 : area.y + 28, width: b.width, height: b.height } }
}

function createWindow(room?: string) {
  const dark = nativeTheme.shouldUseDarkColors
  const at = spot()
  const win = new BrowserWindow({
    ...at.bounds,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: dark ? '#080807' : '#efeee9',
    // Windows draws its own buttons into the header, as tall as the room header so they sit level
    // with it. Linux keeps the desktop's own title bar: each desktop draws overlay buttons in its
    // own size and style, and they never line up.
    ...(mac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 15 } }
      : process.platform === 'win32' ? { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: '#00000000', symbolColor: dark ? '#f2f0ea' : '#0d0d0c', height: 52 } } : {}),
    // Windows and Linux take the window and taskbar icon from here; macOS from the app bundle.
    ...(mac ? {} : { icon: join(__dirname, '../build/icon-1024.png') }),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  wins.add(win)
  last = win
  if (at.maximized) win.maximize()
  win.once('ready-to-show', () => { win.show(); workshop?.started() })
  win.on('focus', () => { last = win })
  for (const e of ['resize', 'move', 'maximize', 'unmaximize'] as const) win.on(e as 'resize', () => remember(win))
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => { if (!process.env.VITE_URL) e.preventDefault() })
  // A window opened on a room starts in it; any other starts at home.
  if (process.env.VITE_URL) win.loadURL(room ? `${process.env.VITE_URL}?room=${encodeURIComponent(room)}` : process.env.VITE_URL)
  else win.loadFile(join(__dirname, 'renderer/index.html'), room ? { query: { room } } : undefined)
  win.on('closed', () => {
    wins.delete(win)
    showing.delete(win)
    if (last === win) last = null
    if (webHost === win) webHost = null
    // The browser's pages move to a window that is still open. With none left they close, as
    // there is nothing to draw them in.
    if (wins.size) browser?.rehome(win)
    else browser?.destroy()
  })
  return win
}

function raise(w: BrowserWindow) {
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

// The menu's shortcut and the window's own key handler can both ask for the same new window.
let opened = 0
function newWindow(room?: string) {
  if (Date.now() - opened < 400) return
  opened = Date.now()
  createWindow(room)
}

function menus() {
  const fresh = { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => newWindow() }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    { label: 'File', submenu: [fresh, { type: 'separator' as const }, { role: mac ? 'close' as const : 'quit' as const }] },
    { role: 'editMenu' as const },
    { role: 'viewMenu' as const },
    { role: 'windowMenu' as const },
  ]))
  if (mac) app.dock?.setMenu(Menu.buildFromTemplate([{ label: 'New Window', click: () => newWindow() }]))
}

function notify(title: string, body: string, room: string) {
  const fromPhone = store.events(room).findLast((e) => e.kind === 'you')
  if (!anyFocused() || (fromPhone?.kind === 'you' && fromPhone.from === 'phone')) remote?.forward(room, body)
  if (!store.settings.notify || !Notification.isSupported() || anyFocused()) return
  const n = new Notification({ title, body, silent: body === 'Done' })
  n.on('click', () => {
    // The window already on that room comes forward. Otherwise the one in front goes to it.
    const on = [...showing].find(([w, r]) => r === room && !w.isDestroyed())?.[0]
    const w = on ?? front() ?? createWindow(room)
    raise(w)
    if (!on) w.webContents.send('open-room', room)
  })
  n.show()
}

// Two windows on one room each have a message box. The same text for the same room, from two
// windows in the same moment, is one message.
let lately: { room: string; text: string; from: BrowserWindow; at: number } | null = null
function twice(room: string, text: string, from: BrowserWindow) {
  const same = !!lately && lately.room === room && lately.text === text && lately.from !== from && Date.now() - lately.at < 1500
  if (!same) lately = { room, text, from, at: Date.now() }
  return same
}

function wire() {
  // Only the app's own windows may call in, never a page inside the agent browser, a sign in
  // window it opened, or a frame. hw hands the handler the window that asked.
  const hw = (channel: string, fn: (from: BrowserWindow, ...args: any[]) => unknown) => ipcMain.handle(channel, (e, ...args) => {
    const from = [...wins].find((w) => !w.isDestroyed() && w.webContents === e.sender)
    if (!from || e.senderFrame !== e.sender.mainFrame) throw new Error('Not allowed')
    return fn(from, ...args)
  })
  const h = (channel: string, fn: (...args: any[]) => unknown) => hw(channel, (_from, ...args) => fn(...args))

  hw('env', (from) => ({ home: homedir(), platform: process.platform, version: app.getVersion(), cwd: workspace(), data: store.dir, window: from.webContents.id, workshop: !!process.env.LUNCHBOX_WORKSHOP }))
  hw('window:new', (_from, room?: string) => { newWindow(typeof room === 'string' && store.room(room) ? room : undefined) })
  hw('window:view', (from, room: string | null) => { if (typeof room === 'string') showing.set(from, room); else showing.delete(from) })
  h('agents', () => engine.agents)
  h('agents:refresh', () => { resetPath(); return engine.refresh() })
  h('limits', () => limits.get())
  h('limits:refresh', () => limits.poll().then(() => limits.get()))
  h('local:start', async (id: string) => {
    const r = await start(id)
    await engine.refresh()
    return r
  })
  h('local:pull', (model: string) => {
    pull(model, (p) => {
      emit('local:pull', p)
      if (p.finished) engine.refresh()
    })
  })
  h('local:cancel', (model: string) => cancelPull(model))
  h('agents:models', (id: string) => modelsFor(id, store.keys()).catch((e: Error) => ({ error: e.message })))
  h('agents:agy-mode', () => ({ keyMode: agyKeyMode(), hasKey: !!store.keys().google }))
  // Only on the person's click: their agy settings get the gemini provider, the rest is kept,
  // and the file as it was is saved beside it.
  h('agents:agy-key', async () => {
    if (!store.keys().google) throw new Error('Save a Gemini API key first')
    const file = agySettings()
    let current: Record<string, unknown> = {}
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8')
      writeFileSync(file + '.before-lunchbox', text, { mode: 0o600 })
      try { current = JSON.parse(text) } catch { throw new Error(`${file} is not valid JSON, so Lunchbox left it alone`) }
    } else mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ ...current, modelProvider: 'gemini' }, null, 2), { mode: 0o600 })
    await engine.refresh()
    return { keyMode: agyKeyMode(), hasKey: true }
  })
  h('agents:efforts', (id: string, model?: string) => effortsFor(id, typeof model === 'string' && model ? model : undefined).catch(() => []))
  h('rooms', () => engine.summaries())
  h('room', (id: string) => ({ meta: store.room(id), events: store.events(id), live: engine.live(id) }))
  h('room:create', (opts: { crew: string[]; workspace: string; pack?: string; name?: string; about?: string; studio?: boolean }) => {
    const folder = opts.workspace || roomFolder(opts.about ?? opts.name ?? '')
    mkdirSync(folder, { recursive: true })
    return engine.create({ ...opts, workspace: folder })
  })
  h('room:rename', (id: string, name: string) => engine.rename(id, name))
  h('room:mark', (id: string, patch: { pinned?: boolean; archived?: boolean }) => { if (patch.archived) browser.closeRoom(id); return engine.mark(id, patch) })
  h('inbox', () => engine.inbox())
  // Chats from the agents' own apps. A session a room already continues is left off the list.
  h('import:list', () => {
    const taken = new Set(store.list().flatMap((m) => Object.values(m.sessions)))
    return found(chatHome(), 150, (id) => taken.has(id))
  })
  h('import:take', async (agent: ChatSource, file: string) => {
    if (!['claude', 'codex', 'gemini', 'grok'].includes(agent) || typeof file !== 'string' || !allowed(file, agent, chatHome())) throw new Error('That chat is no longer there')
    const chat = await read(agent, file, chatHome())
    if (!chat.turns.some((t) => t.you)) throw new Error('That chat has no messages to bring in')
    const there = !!chat.folder && existsSync(chat.folder) && statSync(chat.folder).isDirectory()
    const ready = !engine.why(agent)
    // Claude Code looks a session up under the folder it was started in, so it can only be
    // picked up from there.
    const findable = agent !== 'claude' || basename(dirname(file)) === claudeDir(chat.folder)
    const resumed = there && ready && resumes(agent) && !!chat.id && findable
    const made = roomFrom(chat, { resumed, folderGone: !there, ready })
    const crew = ready ? [agent] : defaults().crew.length ? defaults().crew : [agent]
    const workspace = there ? chat.folder : roomFolder(made.name)
    mkdirSync(workspace, { recursive: true })
    return engine.adopt({ name: made.name, crew, workspace, events: made.events, about: made.about, session: resumed ? { who: agent, id: chat.id } : undefined })
  })
  h('room:remove', (id: string) => { browser.closeRoom(id); return engine.remove(id) })
  h('room:fork', (id: string, at: string) => engine.fork(id, at))
  h('room:crew', (id: string, crew: string[]) => engine.setCrew(id, crew))
  h('room:workspace', (id: string, path: string) => engine.setWorkspace(id, path))
  hw('room:send', (from, id: string, text: string, access: Access, arena: boolean, files?: string[]) => { if (!twice(id, text, from)) engine.send(id, text, access, { arena, files: files?.length ? into(id, files) : files }) })
  h('room:project', (id: string, on: boolean) => engine.setProject(id, on))
  h('room:rewind', (id: string, target: { event?: string; ref?: string }) => engine.rewind(id, target))
  h('room:changed', (id: string, event: string) => engine.changedSince(id, event))
  h('room:changes', (id: string, event: string) => engine.changesFor(id, event))
  h('room:show', (id: string, rel: string) => {
    const ws = store.room(id)?.workspace
    if (!ws) return 'missing'
    const abs = resolve(ws, rel)
    if (!abs.startsWith(resolve(ws) + sep) || !existsSync(abs)) return 'missing'
    shell.showItemInFolder(abs)
    return 'ok'
  })
  h('room:export', async (id: string, kind: 'md' | 'html') => {
    const meta = store.room(id)
    if (!meta) return null
    const events = store.events(id)
    return kind === 'md'
      ? saveAs('Export as Markdown', `${slug(meta.name)}.md`, 'md', markdown(meta, events, name))
      : saveAs('Share as a replay', `${slug(meta.name)}.html`, 'html', replay(meta, events, name)).then((file) => { if (file) shell.showItemInFolder(file); return file })
  })
  hw('save:png', (win, dataUrl: string, file: string) => {
    const m = dataUrl.match(/^data:image\/png;base64,(.+)$/)
    if (!m) return null
    return dialog.showSaveDialog(win, { title: 'Save image', defaultPath: join(app.getPath('downloads'), file), filters: [{ name: 'PNG', extensions: ['png'] }] }).then((r) => {
      if (r.canceled || !r.filePath) return null
      writeFileSync(r.filePath, Buffer.from(m[1], 'base64'))
      return r.filePath
    })
  })
  hw('attach', async (win) => {
    const r = await dialog.showOpenDialog(win, { title: 'Attach files', properties: ['openFile', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths
  })
  h('attach:data', (dataUrl: string, ext = 'png', folder?: string) => {
    const m = dataUrl.match(/^data:[\w/+.-]+;base64,(.+)$/)
    if (!m || m[1].length > 30e6) return null
    const dir = folder && existsSync(folder) ? join(folder, '.lunchbox', 'attachments') : join(store.dir, 'attachments')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}.${ext.replace(/\W/g, '') || 'png'}`)
    writeFileSync(file, Buffer.from(m[1], 'base64'))
    return file
  })
  h('flows', () => ({ flows: flows.list(), running: flows.states() }))
  h('flows:put', (f: Partial<Flow> & Pick<Flow, 'name' | 'steps' | 'crew' | 'workspace' | 'access'>) => flows.put(f))
  h('flows:remove', (id: string) => flows.remove(id))
  h('flows:toggle', (id: string, on: boolean) => flows.toggle(id, on))
  h('flows:run', (id: string) => flows.run(id).room)
  h('browser', () => browser.state())
  // The pages are drawn in the window that asked last. A window that is not showing them cannot
  // take them off the one that is.
  hw('browser:place', (from, b: { x: number; y: number; width: number; height: number } | null) => {
    if (b) webHost = from
    else if (webHost && webHost !== from) return
    browser.place(b)
  })
  h('browser:open', (url: string) => browser.open(String(url)))
  h('browser:select', (id: string) => browser.select(String(id)))
  h('browser:close', (id: string) => browser.close(String(id)))
  h('browser:nav', (kind: 'back' | 'forward' | 'reload' | 'stop') => browser.nav(kind))
  h('browser:device', (d: Device) => browser.setDevice(d))
  h('browser:devtools', () => browser.devtools())
  h('browser:local', () => browser.local())
  h('browser:shot', async () => {
    const file = join(app.getPath('downloads'), `lunchbox-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
    await browser.screenshot(file)
    shell.showItemInFolder(file)
    return file
  })
  h('tools', () => toolbox.list())
  h('tools:set', (id: string, patch: { on?: boolean; input?: string; secrets?: Record<string, string> }) => toolbox.configure(id, patch))
  h('tools:secrets', (id: string) => Object.fromEntries(Object.keys(store.keys()).filter((k) => k.startsWith(`tool:${id}:`)).map((k) => [k.split(':')[2], true])))
  h('remote', () => remote.status())
  h('remote:set', async (patch: { on?: boolean; access?: Access; token?: string }) => {
    if (patch.token !== undefined) store.setKey('telegram', patch.token.trim())
    const cur = store.settings.remote ?? { on: false }
    store.saveSettings({ remote: { ...cur, ...(patch.on !== undefined ? { on: patch.on } : {}), ...(patch.access ? { access: patch.access } : {}) } })
    await remote.start()
    return remote.status()
  })
  h('remote:unpair', () => { remote.unpair(); return remote.status() })
  h('room:stop', (id: string) => engine.stop(id))
  // Share cards: a PNG made in the window, copied as an image or saved where the person chooses.
  const png = (data: string) => {
    if (typeof data !== 'string' || !data.startsWith('data:image/png;base64,')) throw new Error('Not a PNG')
    return nativeImage.createFromDataURL(data)
  }
  // A key the person just copied from a provider's page, offered to the free models page. Only text
  // shaped like a key comes back; anything else stays on the clipboard unread by the page.
  const KEYS: Record<string, RegExp> = { openrouter: /^sk-or-[\w-]{20,200}$/, gemini: /^AIza[\w-]{30,60}$/, groq: /^gsk_\w{20,200}$/, nvidia: /^nvapi-[\w-]{20,200}$/ }
  h('clipboard:key', async (provider: string) => {
    const shape = KEYS[provider]
    if (!shape) return ''
    const t = (await clipboard.readText().catch(() => '')).trim()
    return shape.test(t) ? t : ''
  })
  h('image:copy', async (data: string) => { await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png(data).toPNG())], { type: 'image/png' }) })]); return true })
  h('image:save', (data: string, name: string) => saveAs('Save the image', `${String(name || 'lunchbox').replace(/[^\w.-]+/g, '-')}.png`, 'png', png(data).toPNG()))
  h('room:studio', (id: string, on: boolean) => engine.setStudio(id, on))
  h('room:takeback', (id: string, queued: string) => engine.takeBack(id, queued))
  h('room:decide', (id: string, ref: string, index: number, access: Access) => { engine.decide(id, ref, index, access) })
  h('room:pick', (id: string, arena: string, who: string) => engine.pick(id, arena, who))
  h('room:pin', (id: string, event: string) => engine.pin(id, event))
  h('room:block', (id: string, block: string, text: string | null) => (text === null ? engine.dropBlock(id, block) : engine.editBlock(id, block, text)))
  h('room:skill', (id: string) => engine.skill(id))
  h('run:answer', (id: string, a: Answer) => answer(id, a))
  h('run:kill', (id: string) => kill(id))
  h('ledger', () => engine.ledger())
  h('settings', () => store.settings)
  h('settings:set', async (patch: Partial<Settings>) => {
    store.saveSettings(patch)
    // Turning the count back on sends today's count straight away.
    if (patch.count === true) void count?.send()
    if (patch.connectors) useConnectors(store.settings.connectors)
    if (patch.endpoints) useEndpoints()
    if (patch.autoUpdate !== undefined) updates?.setAuto(patch.autoUpdate)
    if (patch.models || patch.disabled || patch.connectors || patch.endpoints) await engine.refresh()
    if (patch.budgets) emit('ledger', engine.ledger())
    emit('settings', store.settings)
    return store.settings
  })
  h('spent:clear', (id: string) => { delete store.spent[id]; store.saveState(); emit('ledger', engine.ledger()) })
  h('keys', () => Object.fromEntries(Object.entries(store.keys()).filter(([k]) => !k.startsWith('tool:')).map(([k, v]) => [k, v.length >= 20 ? `${v.slice(0, 4)}…${v.slice(-4)}` : '••••••••'])))
  h('keys:set', async (provider: string, key: string) => {
    store.setKey(provider, key.trim())
    return engine.refresh()
  })
  h('keys:secure', () => safeStorage.isEncryptionAvailable())
  h('update', () => updates?.state)
  h('update:check', () => updates?.check())
  h('update:install', () => updates?.install())
  h('update:download', () => updates?.download())
  h('notices', () => updates?.shown() ?? [])
  h('notice:dismiss', (id: string) => updates?.dismiss(String(id)))
  h('report:diagnostics', () => diagnostics(engine.agents))
  h('report:send', (r: Report) => send(r, store.dir, Object.values(store.keys())))
  h('error:log', (message: string) => logError('window', String(message).slice(0, 4000)))
  h('connector:test', (c: Connector, key: string, headers?: string) => testConnector(c, key ?? '', typeof headers === 'string' ? headers : ''))
  // An installer may have just added its folder to the shell profile, so the PATH is read again.
  h('connector:installed', (bins: string[]) => { resetPath(); return installed(Array.isArray(bins) ? bins : []) })
  h('packs', () => packs().filter((p) => !p.hidden))
  h('workshop', () => workshop.state())
  h('commands', (folder?: string) => commands(typeof folder === 'string' ? folder : undefined).map(({ body: _body, ...c }) => c))
  h('commands:expand', (folder: string | undefined, agent: string, name: string, args: string, to: string) => {
    const c = commands(typeof folder === 'string' ? folder : undefined).find((x) => x.agent === agent && x.name === name)
    return c ? expand(c, String(args ?? ''), String(to ?? '')) : null
  })
  h('workshop:setup', () => workshop.setup())
  // An idea starts a Workshop room straight away, or, the first time, once the copy is set up.
  h('workshop:idea', async (text: string, chosen?: unknown) => {
    const idea = String(text ?? '').trim()
    if (!idea) throw new Error('Say what Lunchbox should do')
    // The crew picked in the Workshop's own menu, when it names agents Lunchbox knows.
    const known = new Set(engine.agents.filter((a) => !engine.why(a.id)).map((a) => a.id))
    const picked = Array.isArray(chosen) ? chosen.filter((id): id is string => typeof id === 'string' && known.has(id)) : []
    const crew = picked.length ? picked : defaults().crew
    if (!crew.length) throw new Error('Connect an agent first, on the Agents page')
    const start = () => {
      const meta = engine.create({ crew, workspace: workshop.dir, pack: 'workshop', name: idea.split('\n')[0].slice(0, 60) })
      engine.send(meta.id, idea, 'workspace')
      workshop.launched = { room: meta.id, at: Date.now() }
      workshop.waiting = undefined
      return meta.id
    }
    if (workshop.isReady()) return { room: start() }
    workshop.waiting = idea
    void workshop.setup().then(async (s) => {
      if (s.busy?.error) { workshop.waiting = undefined; emit('workshop', await workshop.state()); return }
      start()
      emit('workshop', await workshop.state())
    })
    return { waiting: true }
  })
  // Opening another build quits this one, which would stop agents mid turn.
  h('workshop:open', () => {
    if (engine.summaries().some((r) => r.busy)) throw new Error('Agents are still working. Try it when they finish')
    return workshop.open()
  })
  h('workshop:back', () => workshop.back())
  h('workshop:stop-using', () => workshop.stopUsing())
  h('workshop:dismiss', () => workshop.dismiss())
  h('workshop:reset', () => workshop.reset())
  h('workshop:update', () => workshop.update())
  h('workshop:folder', () => shell.openPath(workshop.dir))
  // A suggestion is the person's note, or what they asked their agents for, with the whole change
  // attached. It goes the way reports go: to the maintainers' Telegram and the reports repo.
  h('workshop:suggest', async (note?: string, contact?: string) => {
    const { stat, diff } = await workshop.patch()
    if (!stat) throw new Error('There are no changes to send yet')
    const asked = engine.summaries().filter((r) => r.pack === 'workshop' && r.workspace === workshop.dir).map((r) => `- ${r.name}`)
    const said = String(note ?? '').trim() || (asked.length ? `What they asked for:\n${asked.join('\n')}` : '(no note)')
    const text = `Workshop suggestion\n\n${said}\n\nFiles:\n${stat}`
    return send({ kind: 'idea', text, contact: contact || undefined, context: diff.slice(0, 4000), patch: diff, diagnostics: diagnostics(engine.agents) }, store.dir, Object.values(store.keys()))
  })
  hw('packs:import', async (win) => {
    const r = await dialog.showOpenDialog(win, { title: 'Import a pack', filters: [{ name: 'Lunchbox pack', extensions: ['json'] }], properties: ['openFile'] })
    if (r.canceled) return null
    const pack = importPack(r.filePaths[0], join(store.dir, 'packs'))
    emit('packs', packs())
    return pack
  })
  h('packs:link', async (url: string) => { const pack = await fetchPack(url, join(store.dir, 'packs')); emit('packs', packs()); return pack })
  h('packs:remove', (id: string) => { const r = removePack(id, join(store.dir, 'packs')); emit('packs', packs()); return r })
  h('packs:export', (id: string) => {
    const p = packs().find((x) => x.id === id)
    return p ? saveAs('Share a pack', `${p.id}.json`, 'json', packJson(p)) : null
  })
  h('skills:export', (id: string) => {
    const s = store.skills.find((x) => x.id === id)
    return s ? saveAs('Share a skill', `${slug(s.name)}.skill.json`, 'json', JSON.stringify({ kind: 'lunchbox-skill', ...s, from: undefined }, null, 2)) : null
  })
  hw('skills:import', async (win) => {
    const r = await dialog.showOpenDialog(win, { title: 'Import a skill', filters: [{ name: 'Lunchbox skill', extensions: ['json'] }], properties: ['openFile'] })
    if (r.canceled) return null
    const s = JSON.parse(readFileSync(r.filePaths[0], 'utf8')) as Partial<Skill>
    if (typeof s.name !== 'string' || typeof s.brief !== 'string' || !Array.isArray(s.steps)) throw new Error('That file is not a Lunchbox skill')
    const skill: Skill = { id: randomUUID().slice(0, 12), name: s.name.slice(0, 80), brief: s.brief, steps: s.steps.filter((x) => typeof x === 'string').slice(0, 20), crew: Array.isArray(s.crew) ? s.crew : [], pack: s.pack, from: '', created: Date.now() }
    store.skills = [skill, ...store.skills]
    store.saveSkills()
    emit('skills', store.skills)
    return skill
  })
  h('skills', () => store.skills)
  h('skills:remove', (id: string) => {
    store.skills = store.skills.filter((s) => s.id !== id)
    store.saveSkills()
    emit('skills', store.skills)
    return store.skills
  })
  h('search', (q: string) => engine.search(q))
  hw('pick', async (win) => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a folder', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  // Opening is for folders and pictures. Anything else is shown in its folder, never started: the
  // path can come from an agent's message, and opening a program or a script would run it.
  h('reveal', (path: string) => {
    if (typeof path !== 'string' || !existsSync(path)) return 'missing'
    // A link is shown, never followed, and an app is a folder that would start if it were opened.
    const s = lstatSync(path)
    const app = /\.(app|appex|bundle|framework|kext|plugin|prefpane|saver|workflow|action|command|tool)$/i.test(path.replace(/[\\/]+$/, ''))
    if (!s.isSymbolicLink() && !app && (s.isDirectory() || IMAGE_TYPES[extname(path).toLowerCase()])) return shell.openPath(path)
    shell.showItemInFolder(path)
    return ''
  })
  h('file:image', (path: string) => {
    const type = IMAGE_TYPES[extname(path).toLowerCase()]
    if (!type || !existsSync(path) || statSync(path).size > 12e6) return null
    return `data:${type};base64,${readFileSync(path).toString('base64')}`
  })
  h('theme', (dark: boolean) => {
    if (process.platform === 'win32') for (const w of wins) w.setTitleBarOverlay({ color: '#00000000', symbolColor: dark ? '#f2f0ea' : '#0d0d0c', height: 52 })
  })
}

catchErrors()

// Attachments go inside the room's folder, where every agent may read them, under a plain name a
// model won't mangle; the folder is kept out of the project's git status.
function into(room: string, files: string[]) {
  const ws = store.room(room)?.workspace
  if (!ws) return files
  const dir = join(ws, '.lunchbox', 'attachments')
  return files.map((f) => {
    try {
      if (!existsSync(f) || statSync(f).isDirectory() || statSync(f).size > 200e6) return f
      if (!relative(ws, f).startsWith('..') && !isAbsolute(relative(ws, f))) return f
      mkdirSync(dir, { recursive: true })
      const exclude = join(ws, '.git', 'info', 'exclude')
      if (existsSync(join(ws, '.git', 'info')) && !(existsSync(exclude) && readFileSync(exclude, 'utf8').includes('.lunchbox/'))) appendFileSync(exclude, '\n.lunchbox/\n')
      const ext = extname(f).replace(/[^.\w]/g, '').slice(0, 10)
      const name = `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${basename(f, extname(f)).normalize('NFKD').replace(/[^\w.-]+/g, '-').slice(0, 40)}-${randomUUID().slice(0, 4)}${ext}`
      const to = join(dir, name)
      copyFileSync(f, to)
      return to
    } catch {
      return f
    }
  })
}

// One Lunchbox per profile: two would write the same rooms and settings over each other. The one
// that is running does the work of a second: on a Mac a second launch can only be asked for on
// purpose (open -n), so it gets a window of its own. Elsewhere a second launch is what clicking
// the icon again does, so it brings the window forward, unless it was started with --new-window.
const first = app.requestSingleInstanceLock()
if (!first) app.quit()
app.on('second-instance', (_e, argv) => {
  if (!store) return
  const w = front()
  if (!w || mac || argv.includes('--new-window')) return void raise(createWindow())
  raise(w)
})

app.whenReady().then(async () => {
  if (!first) return
  workshop = new Workshop(app.getPath('userData'), (s) => emit('workshop', s))
  // The person chose to run their own build: it opens instead, unless it failed last time.
  if (await workshop.takeOver()) return
  // The Lunchbox folder exists from the first launch, so the first room has somewhere to go.
  try { mkdirSync(workspace(), { recursive: true }) } catch {}
  store = new Store(join(app.getPath('userData'), 'data'), cipher)
  const hands = new Hands()
  await hands.start().catch(() => {})
  browser = new Browser(() => (webHost && !webHost.isDestroyed() ? webHost : front()), emit)
  toolbox = new Toolbox(store, emit)
  const tools = (who: string, folder: string, access: Access, room: string) => [
    // The browser reaches the internet and signed in pages, so it waits for Auto or Full; Plan
    // only reads, and a connected tool can write anywhere.
    ...(store.settings.browser !== false && (access === 'workspace' || access === 'full') ? browser.tools(who, folder, room) : []),
    ...(access === 'plan' ? [] : toolbox.tools()),
  ]
  limits = new Limits(store, (l) => { emit('limits', l); emit('ledger', engine.ledger()) }, () => engine.agents.filter((a) => a.found && a.via === 'cli').map((a) => a.id))
  engine = new Engine(store, { emit, notify, packs, tools, turned: (who, u) => limits.turned(who, u), flow: (f) => flows?.put(f) }, hands, new Snapshots(join(app.getPath('userData'), 'checkpoints')))
  flows = new Flows(store, engine, { emit, notify })
  count = new Count(store)
  count.start()
  remote = new Remote(store, engine, { emit, defaults })
  wire()
  const icon = join(__dirname, '../build/icon-1024.png')
  if (mac && existsSync(icon)) app.dock?.setIcon(icon)
  useConnectors(store.settings.connectors)
  useEndpoints()
  menus()
  createWindow()
  updates = new Updates(store, emit)
  updates.start()
  flush(store.dir).catch(() => {})
  engine.sweep()
  await engine.refresh()
  limits.start()
  flows.start()
  remote.start()
  toolbox.startAll()
})
app.on('before-quit', () => { workshop?.stop(); engine?.stopAll(); limits?.stop(); flows?.stop(); remote?.stop(); toolbox?.stopAll(); store?.flush() })
app.on('will-quit', finishStops)
app.on('window-all-closed', () => { if (!mac) app.quit() })
app.on('activate', () => { if (!wins.size && store) createWindow() })
