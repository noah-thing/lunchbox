import { randomUUID } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, nativeImage, nativeTheme, Notification, safeStorage, shell } from 'electron'
import type { Access, Connector, Flow, Report, Settings, Skill } from '../shared/types'
import { Count } from './count'
import { installed, modelsFor, testConnector, useConnectors } from './agents'
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

app.setName('Lunchbox')

const mac = process.platform === 'darwin'
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
let win: BrowserWindow | null = null
const emit = (channel: string, value: unknown) => win?.webContents.send(channel, value)

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
const packs = () => loadPacks(store.packFiles())
const name = (id: string) => engine.agents.find((a) => a.id === id)?.short ?? id
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'room'

async function saveAs(title: string, file: string, ext: string, contents: string | Buffer) {
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

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: dark ? '#080807' : '#f4f3ef',
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
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => { if (!process.env.VITE_URL) e.preventDefault() })
  if (process.env.VITE_URL) win.loadURL(process.env.VITE_URL)
  else win.loadFile(join(__dirname, 'renderer/index.html'))
  win.on('closed', () => { win = null })
}

function notify(title: string, body: string, room: string) {
  const fromPhone = store.events(room).findLast((e) => e.kind === 'you')
  if (!win?.isFocused() || (fromPhone?.kind === 'you' && fromPhone.from === 'phone')) remote?.forward(room, body)
  if (!store.settings.notify || !Notification.isSupported() || win?.isFocused()) return
  const n = new Notification({ title, body, silent: body === 'Done' })
  n.on('click', () => {
    if (!win) createWindow()
    win?.show()
    win?.focus()
    emit('open-room', room)
  })
  n.show()
}

function wire() {
  const h = (channel: string, fn: (...args: any[]) => unknown) => ipcMain.handle(channel, (_e, ...args) => fn(...args))

  h('env', () => ({ home: homedir(), platform: process.platform, version: app.getVersion(), cwd: workspace(), data: store.dir }))
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
  h('rooms', () => engine.summaries())
  h('room', (id: string) => ({ meta: store.room(id), events: store.events(id), live: engine.live(id) }))
  h('room:create', (opts: { crew: string[]; workspace: string; pack?: string; name?: string; about?: string; studio?: boolean }) => {
    const folder = opts.workspace || roomFolder(opts.about ?? opts.name ?? '')
    mkdirSync(folder, { recursive: true })
    return engine.create({ ...opts, workspace: folder })
  })
  h('room:rename', (id: string, name: string) => engine.rename(id, name))
  h('room:mark', (id: string, patch: { pinned?: boolean; archived?: boolean }) => engine.mark(id, patch))
  h('inbox', () => engine.inbox())
  h('room:remove', (id: string) => engine.remove(id))
  h('room:fork', (id: string, at: string) => engine.fork(id, at))
  h('room:crew', (id: string, crew: string[]) => engine.setCrew(id, crew))
  h('room:workspace', (id: string, path: string) => engine.setWorkspace(id, path))
  h('room:send', (id: string, text: string, access: Access, arena: boolean, files?: string[]) => { engine.send(id, text, access, { arena, files: files?.length ? into(id, files) : files }) })
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
  h('save:png', (dataUrl: string, file: string) => {
    const m = dataUrl.match(/^data:image\/png;base64,(.+)$/)
    if (!m || !win) return null
    return dialog.showSaveDialog(win, { title: 'Save image', defaultPath: join(app.getPath('downloads'), file), filters: [{ name: 'PNG', extensions: ['png'] }] }).then((r) => {
      if (r.canceled || !r.filePath) return null
      writeFileSync(r.filePath, Buffer.from(m[1], 'base64'))
      return r.filePath
    })
  })
  h('attach', async () => {
    if (!win) return []
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
  h('browser:place', (b: { x: number; y: number; width: number; height: number } | null) => browser.place(b))
  h('browser:open', (url: string) => browser.open(url))
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
    if (patch.autoUpdate !== undefined) updates?.setAuto(patch.autoUpdate)
    if (patch.models || patch.disabled || patch.connectors) await engine.refresh()
    if (patch.budgets) emit('ledger', engine.ledger())
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
  h('connector:test', (c: Connector, key: string) => testConnector(c, key ?? ''))
  // An installer may have just added its folder to the shell profile, so the PATH is read again.
  h('connector:installed', (bins: string[]) => { resetPath(); return installed(Array.isArray(bins) ? bins : []) })
  h('packs', () => packs())
  h('packs:import', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { title: 'Import a pack', filters: [{ name: 'Lunchbox pack', extensions: ['json'] }], properties: ['openFile'] })
    if (r.canceled) return null
    return importPack(r.filePaths[0], join(store.dir, 'packs'))
  })
  h('packs:link', (url: string) => fetchPack(url, join(store.dir, 'packs')))
  h('packs:remove', (id: string) => removePack(id, join(store.dir, 'packs')))
  h('packs:export', (id: string) => {
    const p = packs().find((x) => x.id === id)
    return p ? saveAs('Share a pack', `${p.id}.json`, 'json', packJson(p)) : null
  })
  h('skills:export', (id: string) => {
    const s = store.skills.find((x) => x.id === id)
    return s ? saveAs('Share a skill', `${slug(s.name)}.skill.json`, 'json', JSON.stringify({ kind: 'lunchbox-skill', ...s, from: undefined }, null, 2)) : null
  })
  h('skills:import', async () => {
    if (!win) return null
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
  h('pick', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { title: 'Choose a folder', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  h('reveal', (path: string) => (existsSync(path) ? shell.openPath(path) : 'missing'))
  h('file:image', (path: string) => {
    const type = IMAGE_TYPES[extname(path).toLowerCase()]
    if (!type || !existsSync(path) || statSync(path).size > 12e6) return null
    return `data:${type};base64,${readFileSync(path).toString('base64')}`
  })
  h('theme', (dark: boolean) => {
    if (process.platform === 'win32' && win) win.setTitleBarOverlay({ color: '#00000000', symbolColor: dark ? '#f2f0ea' : '#0d0d0c', height: 52 })
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

app.whenReady().then(async () => {
  // The Lunchbox folder exists from the first launch, so the first room has somewhere to go.
  try { mkdirSync(workspace(), { recursive: true }) } catch {}
  store = new Store(join(app.getPath('userData'), 'data'), cipher)
  const hands = new Hands()
  await hands.start().catch(() => {})
  browser = new Browser(() => win, emit)
  toolbox = new Toolbox(store, emit)
  const tools = (who: string, folder: string, access: Access) => [
    // The browser reaches the internet and signed in pages, so it waits for Auto or Full; Plan
    // only reads, and a connected tool can write anywhere.
    ...(store.settings.browser !== false && (access === 'workspace' || access === 'full') ? browser.tools(who, folder) : []),
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
  createWindow()
  updates = new Updates(store, emit)
  updates.start()
  flush(store.dir).catch(() => {})
  await engine.refresh()
  limits.start()
  flows.start()
  remote.start()
  toolbox.startAll()
})
app.on('before-quit', () => { engine?.stopAll(); limits?.stop(); flows?.stop(); remote?.stop(); toolbox?.stopAll(); store?.flush() })
app.on('will-quit', finishStops)
app.on('window-all-closed', () => { if (!mac) app.quit() })
app.on('activate', () => { if (!win) createWindow() })
