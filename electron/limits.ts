import { execFile } from 'node:child_process'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PlanLimits, PlanWindow, Usage } from '../shared/types'
import type { Store } from './store'
import { env, which } from './system'
import { snapshots, tallied, update, used as usedSince, type Tally } from './tally'

// Plan limits as each provider reports them for the login its CLI already has: how much of the
// five hour window and the week is used, and when each resets. Tokens only go to the provider
// that issued them. Providers report percentages, not token totals, so the total per window is
// measured: Lunchbox counts the tokens its own turns use while the percentage climbs.

const HOUR = 3600e3
const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), '.codex')
const grokHome = () => process.env.GROK_HOME ?? join(homedir(), '.grok')
const read = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const json = <T>(p: string): T | null => { try { return JSON.parse(read(p)) as T } catch { return null } }
const sh = (file: string, args: string[]) => new Promise<string>((ok) => execFile(file, args, { timeout: 6000 }, (_e, out) => ok(String(out ?? '').trim())))
const get = async (url: string, headers: Record<string, string>, body?: unknown) => {
  const res = await fetch(url, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw Object.assign(new Error(`${res.status}`), { status: res.status })
  return res.json()
}
const span = (seconds: number) => (seconds >= 6 * 86400 ? 'Week' : seconds >= 86400 ? `${Math.round(seconds / 86400)} days` : `${Math.round(seconds / 3600)} hours`)

async function claude(): Promise<PlanLimits> {
  let raw = ''
  if (process.platform === 'darwin') raw = await sh('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'])
  if (!raw) raw = read(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json'))
  const auth = (() => { try { return JSON.parse(raw).claudeAiOauth } catch { return null } })()
  if (!auth?.accessToken) return { agent: 'claude', windows: [], at: Date.now(), error: 'Not signed in to a Claude plan' }
  const tier = String(auth.rateLimitTier ?? '')
  const plan = /max_20x/.test(tier) ? 'Max 20x' : /max_5x/.test(tier) ? 'Max 5x' : auth.subscriptionType ? String(auth.subscriptionType).replace(/^\w/, (c: string) => c.toUpperCase()) : undefined
  try {
    const u = await get('https://api.anthropic.com/api/oauth/usage', { authorization: `Bearer ${auth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'lunchbox' })
    const windows: PlanWindow[] = []
    const add = (id: string, label: string, w?: { utilization?: number; resets_at?: string } | null) => {
      if (w && typeof w.utilization === 'number') windows.push({ id, label, used: w.utilization / 100, resets: w.resets_at ? Date.parse(w.resets_at) : undefined })
    }
    add('5h', '5 hours', u.five_hour)
    add('week', 'Week', u.seven_day)
    add('week-opus', 'Week, Opus', u.seven_day_opus)
    add('week-sonnet', 'Week, Sonnet', u.seven_day_sonnet)
    return { agent: 'claude', plan, windows, at: Date.now() }
  } catch (e) {
    const status = (e as { status?: number }).status
    return { agent: 'claude', plan, windows: [], at: Date.now(), error: status === 401 ? 'The login expired. It renews the next time Claude Code runs.' : 'Could not reach Anthropic' }
  }
}

async function codex(): Promise<PlanLimits> {
  const auth = json<{ tokens?: { access_token?: string; account_id?: string } }>(join(codexHome(), 'auth.json'))
  const token = auth?.tokens?.access_token
  if (!token) return { agent: 'codex', windows: [], at: Date.now(), error: 'Signed in with an API key, which is billed per token and has no plan window' }
  const windows = (r: { primary_window?: Raw; secondary_window?: Raw } | undefined): PlanWindow[] =>
    [r?.primary_window, r?.secondary_window].filter((w): w is Raw => !!w).map((w) => ({
      id: w.limit_window_seconds >= 6 * 86400 ? 'week' : '5h', label: span(w.limit_window_seconds), used: w.used_percent / 100, resets: w.reset_at * 1000,
    }))
  type Raw = { used_percent: number; limit_window_seconds: number; reset_at: number }
  try {
    const u = await get('https://chatgpt.com/backend-api/wham/usage', { authorization: `Bearer ${token}`, 'chatgpt-account-id': auth?.tokens?.account_id ?? '', 'user-agent': 'codex_cli_rs' })
    return { agent: 'codex', plan: u.plan_type ? String(u.plan_type).replace(/^\w/, (c: string) => c.toUpperCase()) : undefined, windows: windows(u.rate_limit), at: Date.now(), reached: !!u.rate_limit?.limit_reached }
  } catch {
    return fromRollouts()
  }
}

// Codex writes its limits into every session log, so the last run is the fallback when the
// usage endpoint cannot be reached.
function fromRollouts(): PlanLimits {
  const root = join(codexHome(), 'sessions')
  const files: { path: string; at: number }[] = []
  const walk = (dir: string, depth: number) => {
    for (const name of (() => { try { return readdirSync(dir) } catch { return [] } })()) {
      const p = join(dir, name)
      if (depth < 3) walk(p, depth + 1)
      else if (name.endsWith('.jsonl')) files.push({ path: p, at: statSync(p).mtimeMs })
    }
  }
  walk(root, 0)
  for (const f of files.sort((a, b) => b.at - a.at).slice(0, 20)) {
    const line = read(f.path).split('\n').reverse().find((l) => l.includes('"rate_limits"'))
    if (!line) continue
    const r = (() => { try { return JSON.parse(line).payload?.rate_limits } catch { return null } })()
    if (!r) continue
    const w = (x: { used_percent: number; window_minutes: number; resets_at: number } | undefined, id: string): PlanWindow | null =>
      x ? { id, label: span(x.window_minutes * 60), used: x.used_percent / 100, resets: x.resets_at * 1000 } : null
    return {
      agent: 'codex', plan: r.plan_type ? String(r.plan_type).replace(/^\w/, (c: string) => c.toUpperCase()) : undefined,
      windows: [w(r.primary, '5h'), w(r.secondary, 'week')].filter((x): x is PlanWindow => !!x), at: f.at, stale: true,
    }
  }
  return { agent: 'codex', windows: [], at: Date.now(), error: 'Could not reach OpenAI' }
}

// Google publishes Gemini CLI's quota as requests a day: 1,000 with a personal Google login,
// 250 on a free API key. Gemini CLI logs every model reply, so today's count is read from there.
// The day turns over at midnight Pacific time.
async function gemini(): Promise<PlanLimits> {
  const settings = json<{ security?: { auth?: { selectedType?: string } }; selectedAuthType?: string }>(join(homedir(), '.gemini', 'settings.json'))
  const mode = settings?.security?.auth?.selectedType ?? settings?.selectedAuthType ?? ''
  const limit = mode === 'oauth-personal' ? 1000 : mode === 'gemini-api-key' ? 250 : 0
  if (!limit) return { agent: 'gemini', windows: [], at: Date.now(), error: 'Signed in a way Google does not publish a limit for' }
  const start = pacificMidnight()
  const n = geminiRequests(start)
  return {
    agent: 'gemini', plan: mode === 'oauth-personal' ? 'Google account' : 'Free API key', at: Date.now(),
    windows: [{ id: 'day', label: 'Day', used: Math.min(1, n / limit), resets: start + 86400e3, total: limit, unit: 'requests' }],
  }
}

function pacificMidnight() {
  const now = new Date()
  const la = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }))
  const midnight = new Date(la)
  midnight.setHours(0, 0, 0, 0)
  return now.getTime() - (la.getTime() - midnight.getTime())
}

function geminiRequests(since: number) {
  const root = join(homedir(), '.gemini', 'tmp')
  const seen = new Set<string>()
  for (const project of (() => { try { return readdirSync(root) } catch { return [] } })()) {
    const dir = join(root, project, 'chats')
    for (const name of (() => { try { return readdirSync(dir) } catch { return [] } })()) {
      const path = join(dir, name)
      try { if (statSync(path).mtimeMs < since) continue } catch { continue }
      for (const m of read(path).matchAll(/"id":"([0-9a-f]{16,})","timestamp":"([^"]+)","type":"gemini"/g)) {
        if (Date.parse(m[2]) >= since) seen.add(m[1])
      }
    }
  }
  return seen.size
}

// Grok Build bills from one weekly credit pool shared with Grok's other products. Its login
// renews itself whenever Grok runs; `grok models` is the cheapest run, it uses no credits.
async function grok(): Promise<PlanLimits> {
  const path = join(grokHome(), 'auth.json')
  const entry = () => Object.values(json<Record<string, { key?: string; expires_at?: string }>>(path) ?? {})[0]
  let auth = entry()
  if (!auth?.key) return { agent: 'grok', windows: [], at: Date.now(), error: 'Not signed in to Grok' }
  if (!auth.expires_at || Date.parse(auth.expires_at) < Date.now() + 60e3) {
    const bin = await which('grok')
    if (bin) await new Promise((ok) => execFile(bin, ['models'], { timeout: 20000, env: { ...process.env, ...envCache } }, () => ok(null)))
    auth = entry()
  }
  try {
    const b = await get('https://cli-chat-proxy.grok.com/v1/billing?format=credits', { authorization: `Bearer ${auth?.key}`, 'x-grok-client-version': json<{ version?: string }>(join(grokHome(), 'version.json'))?.version ?? '1.0.0', 'user-agent': 'grok-shell' })
    const c = b.config ?? {}
    const build = (c.productUsage ?? []).find((p: { product?: string }) => p.product === 'GrokBuild')
    const period = c.currentPeriod ?? {}
    const label = String(period.type ?? '').includes('MONTH') ? 'Month' : 'Week'
    return {
      agent: 'grok', at: Date.now(),
      windows: [{ id: label.toLowerCase(), label, used: (c.creditUsagePercent ?? 0) / 100, resets: period.end ? Date.parse(period.end) : undefined, share: build ? build.usagePercent / 100 : undefined, start: period.start ? Date.parse(period.start) : undefined }],
    }
  } catch (e) {
    return { agent: 'grok', windows: [], at: Date.now(), error: (e as { status?: number }).status === 401 ? 'Sign in to Grok again with grok login' : 'Could not reach xAI' }
  }
}
let envCache: Record<string, string | undefined> = {}
env().then((e) => { envCache = e })

const READERS: Record<string, () => Promise<PlanLimits>> = { claude, codex, gemini, grok }

const DAY = 86400e3
const LENGTH: Record<string, number> = { '5h': 5 * HOUR, day: DAY, week: 7 * DAY, month: 30 * DAY }

// Fresh tokens are what plan limits are built on: new input, cache writes and output. Cache reads
// cost a tenth of an input token or less and barely move a plan window, so they are left out.
// A window's size is the fresh tokens used in it divided by the share the provider says is used.
// Providers round the share to whole percents, so a reading at 2% can be a quarter off while one
// at 40% is within about one percent. The reading taken at the highest share in the last two weeks
// is the one shown, which also carries last week's precise size into a new, barely used week.
export function size(fresh: number, share: number) {
  return share >= 0.02 && fresh > 0 ? Math.round(fresh / share) : undefined
}

export type Reading = { tokens: number; at: number; share?: number }

export function best(history: Reading[], now = Date.now()) {
  const recent = history.filter((h) => now - h.at < 14 * DAY)
  if (!recent.length) return undefined
  return recent.reduce((a, b) => ((b.share ?? 0) > (a.share ?? 0) || ((b.share ?? 0) === (a.share ?? 0) && b.at > a.at) ? b : a)).tokens
}

// Grok rewrites a small usage file per session rather than appending, so it is summed directly.
function grokFresh(from: number) {
  const root = join(grokHome(), 'sessions')
  let total = 0
  const walk = (dir: string, depth: number) => {
    for (const name of (() => { try { return readdirSync(dir) } catch { return [] } })()) {
      const p = join(dir, name)
      if (depth < 2) { walk(p, depth + 1); continue }
      if (name !== 'usage.json') continue
      try { if (statSync(p).mtimeMs < from) continue } catch { continue }
      for (const t of json<{ turns?: { endedAt?: string; inputTokens?: number; cachedReadTokens?: number; outputTokens?: number }[] }>(p)?.turns ?? []) {
        if (t.endedAt && Date.parse(t.endedAt) >= from) total += Math.max(0, (t.inputTokens ?? 0) - (t.cachedReadTokens ?? 0)) + (t.outputTokens ?? 0)
      }
    }
  }
  walk(root, 0)
  return total
}

export class Limits {
  private now: Record<string, PlanLimits> = {}
  private timer: NodeJS.Timeout | null = null
  private soon = new Map<string, NodeJS.Timeout>()
  private tallies: Record<string, Tally> = {}
  private busy = false

  constructor(private store: Store, private emit: (l: Record<string, PlanLimits>) => void, private present: () => string[]) {
    for (const id of ['claude', 'codex']) this.tallies[id] = json<Tally>(join(store.dir, `tally-${id}.json`)) ?? { files: {} }
  }

  start() {
    this.poll()
    this.timer = setInterval(() => this.poll(), 3 * 60e3)
  }

  stop() { if (this.timer) clearInterval(this.timer) }

  get() { return this.now }

  async poll(only?: string) {
    if (this.store.settings.planLimits === false || this.busy) return
    this.busy = true
    try {
      const ids = (only ? [only] : this.present()).filter((id) => READERS[id])
      await Promise.all(ids.map(async (id) => {
        const l = await READERS[id]().catch(() => null)
        if (!l) return
        await this.measure(id, l)
        this.now[id] = l
        this.gate(id, l)
      }))
      this.store.saveState()
      this.emit(this.now)
    } finally {
      this.busy = false
    }
  }

  private async measure(id: string, l: PlanLimits) {
    const timed = l.windows.filter((w) => w.unit !== 'requests')
    if (!timed.length) return
    const from = (w: PlanWindow) => w.start ?? (w.resets ? w.resets - (LENGTH[w.id] ?? 7 * DAY) : Date.now() - (LENGTH[w.id] ?? 7 * DAY))
    if (tallied(id)) {
      const tally = this.tallies[id]
      await update(id, tally, Math.min(Date.now() - 14 * DAY, ...timed.map(from)))
      writeFileSync(join(this.store.dir, `tally-${id}.json`), JSON.stringify(tally))
      // Readings the CLI logged itself measure past windows too, so a fresh window starts known.
      for (const s of snapshots(tally)) {
        const tokens = size(usedSince(tally, s.start, s.at).fresh, s.used)
        const key = `${id}:${s.id}`
        if (tokens && !(this.store.calib[key] ?? []).some((h) => h.at === s.at)) (this.store.calib[key] ??= []).push({ tokens, at: s.at, share: s.used })
      }
    }
    for (const w of timed) {
      const share = w.share ?? w.used
      const fresh = id === 'grok' ? grokFresh(from(w)) : tallied(id) ? usedSince(this.tallies[id], from(w)).fresh : 0
      const key = `${id}:${w.id}`
      const history = (this.store.calib[key] ?? []).filter((h) => Date.now() - h.at < 14 * DAY)
      const measured = size(fresh, share)
      if (measured) history.push({ tokens: measured, at: Date.now(), share })
      this.store.calib[key] = history.slice(-200)
      w.total = best(history)
      w.unit = 'tokens'
    }
  }

  // After an agent's turn the provider's numbers have moved; look again shortly.
  turned(agent: string, _u: Usage) {
    if (!READERS[agent]) return
    clearTimeout(this.soon.get(agent))
    this.soon.set(agent, setTimeout(() => this.poll(agent), 4000))
  }

  // A full window takes the agent out of rotation until it resets, the same way a hit limit does.
  private gate(id: string, l: PlanLimits) {
    const full = l.windows.filter((w) => w.used >= 0.995 && w.resets)
    const spent = this.store.spent[id]
    if (full.length || l.reached) {
      const until = Math.max(...full.map((w) => w.resets!), Date.now() + HOUR)
      this.store.spent[id] = { until, reason: 'plan limit reached' }
    } else if (spent?.reason === 'plan limit reached') {
      delete this.store.spent[id]
    }
  }
}
