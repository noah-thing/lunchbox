import { app, net } from 'electron'
import { randomUUID } from 'node:crypto'
import type { Store } from './store'

// The anonymous install count. Once a day Lunchbox sends four things: a random ID it made on its
// first launch, its version, the system and the processor type. Nothing about rooms, agents,
// files, prompts or keys. The server hashes the ID and keeps no IP address (see stats/ in this
// repository). It runs silently: no notice, and no error ever reaches the person. Settings has the
// switch that turns it off.
const URL = process.env.LUNCHBOX_STATS_URL || 'https://lunchbox-stats.opencursor.workers.dev/v1/ping'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function countBody(id: string, version: string, os: string, arch: string) {
  return { id, version, os, arch }
}

export class Count {
  private sending = false
  constructor(private store: Store) {}

  start() {
    // Development copies do not count, unless pointed at a test server.
    if (!app.isPackaged && !process.env.LUNCHBOX_STATS_URL) return
    // A test server answers sooner, so a test does not wait out the delay.
    setTimeout(() => this.send(), process.env.LUNCHBOX_STATS_URL ? 2e3 : 20e3)
    setInterval(() => this.send(), 3 * 3600e3)
  }

  async send() {
    const s = this.store.settings
    const today = new Date().toISOString().slice(0, 10)
    if (this.sending || s.count === false || s.countDay === today) return
    if (!app.isPackaged && !process.env.LUNCHBOX_STATS_URL) return
    this.sending = true
    try {
      let id = s.countId
      if (!id || !UUID.test(id)) {
        id = randomUUID()
        this.store.saveSettings({ countId: id })
      }
      const res = await net.fetch(URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(countBody(id, app.getVersion(), process.platform, process.arch)),
        signal: AbortSignal.timeout(10e3),
      })
      if (res.status === 204) this.store.saveSettings({ countDay: today })
    } catch {
      // Offline or blocked: it tries again later, and nothing else depends on it.
    } finally {
      this.sending = false
    }
  }
}
