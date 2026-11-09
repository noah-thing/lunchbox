import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PlanLimits, PlanWindow, Usage } from '../shared/types'
import type { Store } from './store'
import { which } from './system'

// Plan limits as each provider reports them for the login its CLI already has: how much of the
// five hour window and the week is used, and when each resets. Tokens only go to the provider
// that issued them. Providers report percentages, not token totals, so the total per window is
// measured: Lunchbox counts the tokens its own turns use while the percentage climbs.

const HOUR = 3600e3
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
  if (!raw) raw = read(join(homedir(), '.claude', '.credentials.json'))
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
  const auth = json<{ tokens?: { access_token?: string; account_id?: string } }>(join(homedir(), '.codex', 'auth.json'))
  const token = auth?.tokens?.access_token
  if (!token) return { agent: 'codex', windows: [], at: Date.now(), error: 'Not signed in with ChatGPT' }
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
  const root = join(homedir(), '.codex', 'sessions')
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

// Gemini CLI's login renews with the client it ships, read from the installed package rather
// than copied into Lunchbox. Accounts without a Code Assist plan have no quota to report.
async function gemini(): Promise<PlanLimits> {
  const creds = json<{ refresh_token?: string }>(join(homedir(), '.gemini', 'oauth_creds.json'))
  if (!creds?.refresh_token) return { agent: 'gemini', windows: [], at: Date.now(), error: 'Signed in with an API key, which has no plan window' }
  const client = await geminiClient()
  if (!client) return { agent: 'gemini', windows: [], at: Date.now(), error: 'Gemini CLI does not report its limits' }
  try {
    const body = new URLSearchParams({ client_id: client.id, client_secret: client.secret, refresh_token: creds.refresh_token, grant_type: 'refresh_token' })
    const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body, signal: AbortSignal.timeout(8000) })
    const token = (await res.json()).access_token
    const auth = { authorization: `Bearer ${token}` }
    const load = await get('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', auth, { metadata: { pluginType: 'GEMINI' } })
    const project = load.cloudaicompanionProject
    if (!project) return { agent: 'gemini', windows: [], at: Date.now(), error: 'This Google account has no Gemini Code Assist plan, so Google reports no limits' }
    const q = await get('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', auth, { project })
    const buckets: { remainingFraction?: number; resetTime?: string; modelId?: string }[] = q.buckets ?? []
    const worst = buckets.filter((b) => typeof b.remainingFraction === 'number').sort((a, b) => a.remainingFraction! - b.remainingFraction!)[0]
    return {
      agent: 'gemini', plan: load.currentTier?.name, at: Date.now(),
      windows: worst ? [{ id: 'day', label: 'Day', used: 1 - worst.remainingFraction!, resets: worst.resetTime ? Date.parse(worst.resetTime) : undefined }] : [],
    }
  } catch {
    return { agent: 'gemini', windows: [], at: Date.now(), error: 'Could not reach Google' }
  }
}

let geminiCache: { id: string; secret: string } | null | undefined
async function geminiClient() {
  if (geminiCache !== undefined) return geminiCache
  geminiCache = null
  const bin = await which('gemini')
  if (!bin) return null
  const real = await sh('/bin/sh', ['-c', `readlink -f "${bin}" 2>/dev/null || echo "${bin}"`])
  for (let dir = dirname(real), i = 0; i < 4 && dir !== '/'; i++, dir = dirname(dir)) {
    const bundle = join(dir, 'bundle')
    if (!existsSync(bundle)) continue
    for (const f of readdirSync(bundle).filter((n) => n.endsWith('.js'))) {
      const src = read(join(bundle, f))
      const id = src.match(/OAUTH_CLIENT_ID = "([^"]+)"/)?.[1]
      const secret = src.match(/OAUTH_CLIENT_SECRET = "([^"]+)"/)?.[1]
      if (id && secret) return (geminiCache = { id, secret })
    }
  }
  return null
}

const READERS: Record<string, () => Promise<PlanLimits>> = { claude, codex, gemini }

type Calib = { pct: number; since: number; samples: number[] }

// How many tokens one percent of a window held, measured between whole-percent steps. Use of the
// same plan outside Lunchbox in the same stretch makes a step come sooner, so the estimate errs low.
export function step(c: Calib, pct: number) {
  if (pct < c.pct - 0.5) return { pct, since: 0, samples: c.samples }
  if (pct >= c.pct + 1) {
    const samples = c.since > 0 ? [...c.samples, c.since / (pct - c.pct)].slice(-24) : c.samples
    return { pct, since: 0, samples }
  }
  return c
}

export function estimate(samples: number[]) {
  if (samples.length < 3) return undefined
  const s = [...samples].sort((a, b) => a - b)
  return Math.round(s[Math.floor(s.length / 2)] * 100)
}

export class Limits {
  private now: Record<string, PlanLimits> = {}
  private timer: NodeJS.Timeout | null = null
  private soon = new Map<string, NodeJS.Timeout>()

  constructor(private store: Store, private emit: (l: Record<string, PlanLimits>) => void, private present: () => string[]) {}

  start() {
    this.poll()
    this.timer = setInterval(() => this.poll(), 3 * 60e3)
  }

  stop() { if (this.timer) clearInterval(this.timer) }

  get() { return this.now }

  async poll(only?: string) {
    if (this.store.settings.planLimits === false) return
    const ids = (only ? [only] : this.present()).filter((id) => READERS[id])
    await Promise.all(ids.map(async (id) => {
      const l = await READERS[id]().catch(() => null)
      if (!l) return
      for (const w of l.windows) {
        const key = `${id}:${w.id}`
        const c = step(this.store.calib[key] ?? { pct: w.used * 100, since: 0, samples: [] }, w.used * 100)
        this.store.calib[key] = c
        w.tokens = estimate(c.samples)
        w.samples = c.samples.length
      }
      this.now[id] = l
      this.gate(id, l)
    }))
    this.store.saveState()
    this.emit(this.now)
  }

  // After an agent's turn: count its tokens toward every window it has, and look again shortly.
  turned(agent: string, u: Usage) {
    if (!READERS[agent]) return
    const tokens = u.input + u.cached + u.output
    for (const w of this.now[agent]?.windows ?? []) {
      const key = `${agent}:${w.id}`
      const c = this.store.calib[key] ?? { pct: w.used * 100, since: 0, samples: [] }
      this.store.calib[key] = { ...c, since: c.since + tokens }
    }
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
