import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, safeStorage, shell } from 'electron'
import type { Access, Settings } from '../shared/types'
import { modelsFor } from './agents'
import { importPack, loadPacks } from './packs'
import { Hands } from './hands'
import { Engine } from './room/engine'
import { answer, kill, type Answer } from './shell'
import { Store, type Cipher } from './store'

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
const packs = () => loadPacks(store.packFiles())
const workspace = () => process.env.LB_WORKSPACE || join(app.getPath('documents'), 'Lunchbox')

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
  h('agents:models', (id: string) => modelsFor(id, store.keys()).catch((e: Error) => ({ error: e.message })))
  h('rooms', () => engine.summaries())
  h('room', (id: string) => ({ meta: store.room(id), events: store.events(id), live: engine.live(id) }))
  h('room:create', (opts: { crew: string[]; workspace: string; pack?: string; name?: string }) => {
    mkdirSync(opts.workspace, { recursive: true })
    return engine.create(opts)
  })
  h('room:rename', (id: string, name: string) => engine.rename(id, name))
  h('room:remove', (id: string) => engine.remove(id))
  h('room:fork', (id: string, at: string) => engine.fork(id, at))
  h('room:crew', (id: string, crew: string[]) => engine.setCrew(id, crew))
  h('room:workspace', (id: string, path: string) => engine.setWorkspace(id, path))
  h('room:send', (id: string, text: string, access: Access, arena: boolean) => { engine.send(id, text, access, arena) })
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
  engine = new Engine(store, { emit, notify, packs }, hands)
  wire()
  const icon = join(__dirname, '../build/icon-1024.png')
  if (mac && existsSync(icon)) app.dock?.setIcon(icon)
  createWindow()
  engine.refresh()
})
app.on('before-quit', () => store?.flush())
app.on('window-all-closed', () => { if (!mac) app.quit() })
app.on('activate', () => { if (!win) createWindow() })
