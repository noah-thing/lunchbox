import { app, net } from 'electron'
import { createPublicKey, verify } from 'node:crypto'
import updater from 'electron-updater'
import type { Notice, UpdateState } from '../shared/types'
import type { Store } from './store'

// Everything public lives in noah-thing/lunchbox-releases: the installers, and notices.json, the
// feed of messages that reach every copy of the app without an update.
const RELEASES = 'https://github.com/noah-thing/lunchbox-releases'
const FEED = 'https://raw.githubusercontent.com/noah-thing/lunchbox-releases/main/notices.json'

// The feed is signed with a key only Noah holds (scripts/notice.mjs). A feed that does not verify
// is ignored, so whoever controls the hosting still cannot put words in the app.
const KEY = createPublicKey('-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAcUzrUWrqBdLZc++0Sq82fE9P9ZTLy2ESPGV722bVjU0=\n-----END PUBLIC KEY-----\n')

const HOUR = 3600e3

// 1.10.0 is newer than 1.9.2; a pre-release tag counts as older than the plain version.
export function newer(a: string, b: string) {
  const [x, xt] = a.replace(/^v/, '').split('-')
  const [y, yt] = b.replace(/^v/, '').split('-')
  const p = x.split('.').map(Number)
  const q = y.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((p[i] ?? 0) !== (q[i] ?? 0)) return (p[i] ?? 0) > (q[i] ?? 0)
  return !xt && !!yt
}

// The signature covers the notices and the time they were issued, so an old feed can't be served
// again to bring back a message that was taken down.
export function verified(body: unknown, last = 0, now = Date.now()): { notices: Notice[]; issued: number } | null {
  const feed = body as { notices?: unknown; issued?: unknown; sig?: unknown }
  if (!Array.isArray(feed?.notices) || typeof feed.sig !== 'string' || typeof feed.issued !== 'number') return null
  if (feed.issued < last || feed.issued > now + 3600e3) return null
  try {
    const signed = Buffer.from(JSON.stringify({ notices: feed.notices, issued: feed.issued }))
    return verify(null, signed, KEY, Buffer.from(feed.sig, 'base64')) ? { notices: feed.notices as Notice[], issued: feed.issued } : null
  } catch {
    return null
  }
}

export function visible(list: Notice[], version: string, platform: string, dismissed: string[], now = Date.now()) {
  return list.filter((n) =>
    n && typeof n.id === 'string' && ['toast', 'card', 'banner'].includes(n.kind) && typeof n.title === 'string' &&
    !dismissed.includes(n.id) &&
    (!n.from || !newer(n.from, version)) && (!n.to || !newer(version, n.to)) &&
    (!n.platforms || n.platforms.includes(platform as never)) &&
    (!n.after || Date.parse(n.after) <= now) && (!n.until || Date.parse(n.until) > now) &&
    (!n.image || n.image.startsWith('https://')) && (!n.action || /^https:\/\//.test(n.action.url)),
  )
}

export class Updates {
  state: UpdateState = { state: 'idle' }
  notices: Notice[] = []

  constructor(private store: Store, private emit: (channel: string, value: unknown) => void) {}

  start() {
    this.feed()
    setInterval(() => this.feed(), HOUR / 2)
    if (!app.isPackaged) return
    const u = updater.autoUpdater
    // On unless the person turned it off; off still checks and says when a version is out.
    const auto = this.store.settings.autoUpdate !== false
    u.autoDownload = auto
    u.autoInstallOnAppQuit = auto
    u.on('checking-for-update', () => this.set({ state: 'checking' }))
    u.on('update-not-available', () => this.set({ state: 'none' }))
    u.on('download-progress', (p) => this.set({ state: 'downloading', version: (this.state as { version?: string }).version ?? '', progress: p.percent / 100 }))
    u.on('update-available', (i) => this.set(this.store.settings.autoUpdate !== false ? { state: 'downloading', version: i.version, progress: 0 } : { state: 'available', version: i.version }))
    u.on('update-downloaded', (i) => this.set({ state: 'ready', version: i.version }))
    // macOS installs only signed apps. Until the app is signed, a new version is offered as a
    // download instead, so nobody is left on an old version without knowing.
    u.on('error', (e) => this.manual(String(e?.message ?? e)))
    this.check()
    setInterval(() => this.check(), 4 * HOUR)
  }

  check() {
    if (!app.isPackaged) return Promise.resolve(this.state)
    return updater.autoUpdater.checkForUpdates().then(() => this.state).catch((e) => this.manual(String(e?.message ?? e)))
  }

  download() {
    if (this.state.state !== 'available') return
    this.set({ state: 'downloading', version: this.state.version, progress: 0 })
    updater.autoUpdater.downloadUpdate().catch((e) => this.manual(String(e?.message ?? e)))
  }

  setAuto(on: boolean) {
    if (!app.isPackaged) return
    updater.autoUpdater.autoDownload = on
    updater.autoUpdater.autoInstallOnAppQuit = on
    if (on && this.state.state === 'available') this.download()
  }

  install() {
    // Silent, and the app opens again: no installer wizard on Windows, no closed app on Linux.
    if (this.state.state === 'ready') updater.autoUpdater.quitAndInstall(true, true)
  }

  private async manual(error: string) {
    try {
      const res = await net.fetch(`https://api.github.com/repos/noah-thing/lunchbox-releases/releases/latest`, { headers: { accept: 'application/vnd.github+json' } })
      const latest = (await res.json()) as { tag_name?: string; html_url?: string }
      if (latest.tag_name && newer(latest.tag_name, app.getVersion())) return this.set({ state: 'manual', version: latest.tag_name.replace(/^v/, ''), url: latest.html_url ?? `${RELEASES}/releases/latest` })
      this.set({ state: 'none' })
    } catch {
      this.set({ state: 'error', error })
    }
    return this.state
  }

  private set(s: UpdateState) {
    this.state = s
    this.emit('update', s)
  }

  async feed() {
    try {
      const res = await net.fetch(`${FEED}?t=${Math.floor(Date.now() / 60e3)}`, { cache: 'no-store' })
      if (!res.ok) return
      const feed = verified(await res.json(), this.store.settings.feedIssued ?? 0)
      if (!feed) return
      if (feed.issued !== this.store.settings.feedIssued) this.store.saveSettings({ feedIssued: feed.issued })
      this.notices = feed.notices
      this.emit('notices', this.shown())
    } catch {}
  }

  shown() {
    return visible(this.notices, app.getVersion(), process.platform, this.store.settings.dismissed ?? [])
  }

  dismiss(id: string) {
    const d = this.store.settings.dismissed ?? []
    // Kept short: ids of notices that have left the feed are dropped over time.
    if (!d.includes(id)) this.store.saveSettings({ dismissed: [...d.filter((x) => this.notices.some((n) => n.id === x)), id].slice(-200) })
    this.emit('notices', this.shown())
  }
}
