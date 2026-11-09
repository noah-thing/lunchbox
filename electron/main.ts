import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, safeStorage, shell } from 'electron'
import type { Access, Flow, Settings, Skill } from '../shared/types'
import { modelsFor } from './agents'
import { markdown, replay } from './export'
import { Flows } from './flows'
import { fetchPack, importPack, loadPacks, packJson, removePack } from './packs'
import { Hands } from './hands'
import { Remote } from './remote'
import { Engine } from './room/engine'
import { answer, kill, type Answer } from './shell'
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
let remote: Remote
let browser: Browser
let toolbox: Toolbox
const packs = () => loadPacks(store.packFiles())
const name = (id: string) => engine.agents.find((a) => a.id === id)?.short ?? id
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'room'

async function saveAs(title: string, file: string, ext: string, contents: string) {
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
    backgroundColor: dark ? '#0d0d0c' : '#f4f3ef',
    ...(mac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 15 } }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: '#00000000', symbolColor: dark ? '#f2f0ea' : '#0d0d0c', height: 44 } }),
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
  h('agents:refresh', () => engine.refresh())
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
  h('room:create', (opts: { crew: string[]; workspace: string; pack?: string; name?: string; about?: string }) => {
    const folder = opts.workspace || roomFolder(opts.about ?? opts.name ?? '')
    mkdirSync(folder, { recursive: true })
    return engine.create({ ...opts, workspace: folder })
  })
  h('room:rename', (id: string, name: string) => engine.rename(id, name))
  h('room:remove', (id: string) => engine.remove(id))
  h('room:fork', (id: string, at: string) => engine.fork(id, at))
  h('room:crew', (id: string, crew: string[]) => engine.setCrew(id, crew))
  h('room:workspace', (id: string, path: string) => engine.setWorkspace(id, path))
  h('room:send', (id: string, text: string, access: Access, arena: boolean, files?: string[]) => { engine.send(id, text, access, { arena, files }) })
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
      : saveAs('Export a replay', `${slug(meta.name)}.html`, 'html', replay(meta, events, name))
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
    if (patch.models || patch.disabled) await engine.refresh()
    if (patch.budgets) emit('ledger', engine.ledger())
    return store.settings
  })
  h('spent:clear', (id: string) => { delete store.spent[id]; store.saveState(); emit('ledger', engine.ledger()) })
  h('keys', () => Object.fromEntries(Object.entries(store.keys()).map(([k, v]) => [k, `${v.slice(0, 4)}…${v.slice(-4)}`])))
  h('keys:set', async (provider: string, key: string) => {
    store.setKey(provider, key.trim())
    return engine.refresh()
  })
  h('keys:secure', () => safeStorage.isEncryptionAvailable())
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
    if (!mac && win) win.setTitleBarOverlay({ color: '#00000000', symbolColor: dark ? '#f2f0ea' : '#0d0d0c', height: 44 })
  })
}

app.whenReady().then(async () => {
  store = new Store(join(app.getPath('userData'), 'data'), cipher)
  const hands = new Hands()
  await hands.start().catch(() => {})
  browser = new Browser(() => win, emit)
  toolbox = new Toolbox(store, emit)
  const tools = (who: string, folder: string, access: Access) => [
    ...(store.settings.browser !== false && access !== 'plan' ? browser.tools(who, folder) : []),
    ...toolbox.tools(),
  ]
  limits = new Limits(store, (l) => { emit('limits', l); emit('ledger', engine.ledger()) }, () => engine.agents.filter((a) => a.found && a.via === 'cli').map((a) => a.id))
  engine = new Engine(store, { emit, notify, packs, tools, turned: (who, u) => limits.turned(who, u) }, hands, new Snapshots(join(app.getPath('userData'), 'checkpoints')))
  flows = new Flows(store, engine, { emit, notify })
  remote = new Remote(store, engine, { emit, defaults })
  wire()
  const icon = join(__dirname, '../build/icon-1024.png')
  if (mac && existsSync(icon)) app.dock?.setIcon(icon)
  createWindow()
  await engine.refresh()
  limits.start()
  flows.start()
  remote.start()
  toolbox.startAll()
})
app.on('before-quit', () => { limits?.stop(); flows?.stop(); remote?.stop(); toolbox?.stopAll(); store?.flush() })
app.on('window-all-closed', () => { if (!mac) app.quit() })
app.on('activate', () => { if (!win) createWindow() })
