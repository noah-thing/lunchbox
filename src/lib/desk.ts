import { useSyncExternalStore } from 'react'
import type { Access, AgentInfo, Env, Flow, FlowState, Kind, Ledger, Pack, RoomSummary, Settings, Skill, Spent, PlanLimits } from '../../shared/types'

export type { Access, Kind }
export type LedgerView = Ledger & { spent: Record<string, Spent>; budgets: Record<string, number> }

export type RemoteStatus = { on: boolean; token: boolean; paired: boolean; name?: string; bot?: string; code: string; error?: string }

type Bridge = {
  call(channel: string, ...args: unknown[]): Promise<any>
  on(channel: string, fn: (value: any) => void): () => void
  pathOf?(file: File): string
}

declare global { interface Window { lb?: Bridge } }

const EMPTY: Record<string, unknown> = {
  env: { home: '', platform: 'web', version: '0.0.0', cwd: '', data: '' },
  agents: [], 'agents:refresh': [], rooms: [], ledger: null, settings: null, skills: [], packs: [], keys: {}, search: [], flows: { flows: [], running: [] },
}

const browser: Bridge = {
  call: async (channel) => EMPTY[channel] ?? null,
  on: () => () => {},
}

// Unwraps the message Electron puts around errors thrown in the main process.
export const reason = (e: unknown, fallback = 'That did not work') =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback

export const desk: Bridge = window.lb ?? browser
export const isDesktop = !!window.lb

type State = {
  env: Env
  agents: AgentInfo[]
  rooms: RoomSummary[]
  settings: Settings
  ledger: LedgerView | null
  limits: Record<string, PlanLimits>
  skills: Skill[]
  packs: Pack[]
  flows: Flow[]
  running: FlowState[]
  loaded: boolean
}

let state: State = {
  env: EMPTY.env as Env,
  agents: [], rooms: [], ledger: null, limits: {}, skills: [], packs: [], flows: [], running: [], loaded: false,
  settings: { models: {}, budgets: {}, disabled: [], notify: true, defaultCrew: [] },
}
const subs = new Set<() => void>()
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch }
  subs.forEach((f) => f())
}
const subscribe = (f: () => void) => {
  subs.add(f)
  return () => subs.delete(f)
}

export function useApp<T>(pick: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => pick(state))
}
export const now = () => state

let booted: Promise<void> | null = null
export function boot() {
  booted ??= (async () => {
    desk.on('agents', (agents) => set({ agents }))
    desk.on('rooms', (rooms) => set({ rooms }))
    desk.on('ledger', (ledger) => set({ ledger }))
    desk.on('limits', (limits) => set({ limits }))
    desk.call('limits').then((limits) => limits && set({ limits }))
    desk.on('skills', (skills) => set({ skills }))
    desk.on('flows', (f) => set({ flows: f.flows, running: f.running }))
    const [env, agents, rooms, settings, ledger, skills, packs, flows] = await Promise.all(
      ['env', 'agents', 'rooms', 'settings', 'ledger', 'skills', 'packs', 'flows'].map((c) => desk.call(c)),
    )
    set({ env, agents, rooms, settings: settings ?? state.settings, ledger, skills, packs, flows: flows?.flows ?? [], running: flows?.running ?? [], loaded: true })
  })()
  return booted
}

export const reload = {
  packs: async () => set({ packs: await desk.call('packs') }),
  // The change shows at once and the next one builds on it. Saving also looks for agents again,
  // which takes a moment; a second change made in that moment used to be built on the old
  // settings and undo the first.
  settings: async (patch: Partial<Settings>) => {
    set({ settings: { ...state.settings, ...patch } })
    const saved = await desk.call('settings:set', patch)
    if (saved) set({ settings: saved })
  },
  agents: async () => set({ agents: await desk.call('agents:refresh') }),
}

export const isMac = /Mac/.test(navigator.platform)
export const mod = isMac ? '⌘' : 'Ctrl+'
export const machine = () => (state.env.platform === 'darwin' || (!isDesktop && isMac) ? 'this Mac' : 'this computer')

export const ACCESS: { id: Access; name: string; line: string; level: number }[] = [
  { id: 'plan', name: 'Plan', line: 'Read and plan. Nothing on disk changes.', level: 0 },
  { id: 'ask', name: 'Ask', line: 'Reading is free. Edits and commands wait for your OK.', level: 1 },
  { id: 'workspace', name: 'Auto', line: 'Free inside the folder. Anything outside it asks.', level: 2 },
  { id: 'full', name: 'Full access', line: 'Anything on this computer, without asking. Only wiping the disk or your home folder is refused.', level: 3 },
]

export const KIND_LABEL: Record<Kind, string> = {
  read: 'reads', write: 'edits files', network: 'network', outside: 'other folders', danger: 'risky', blocked: 'blocked',
}

export const short = (path: string, home = state.env.home) => (home && path.startsWith(home) ? '~' + path.slice(home.length) : path)

export const agentOf = (id: string, list = state.agents): AgentInfo =>
  list.find((a) => a.id === id) ?? { id, name: id, short: id, maker: '', via: 'cli', found: false, ready: false, tools: false, good: '', alphabet: '.:+*#', mark: id }

export function ago(t: number) {
  const s = (Date.now() - t) / 1000
  if (s < 45) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  if (s < 604800) return `${Math.round(s / 86400)}d`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

// "in 3h", "tomorrow 08:00", "Fri 09:00": when something scheduled happens next.
export function upcoming(t: number) {
  const s = (t - Date.now()) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `in ${Math.round(s / 60)}m`
  const d = new Date(t)
  const today = new Date()
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(today).setHours(0, 0, 0, 0)) / 86400e3)
  if (days === 0) return `today ${clock(t)}`
  if (days === 1) return `tomorrow ${clock(t)}`
  if (days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${clock(t)}`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function tokens(n: number) {
  if (n < 1000) return String(Math.round(n))
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`
  return `${(n / 1e6).toFixed(1)}M`
}

export const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `${Math.max(1, Math.round(n * 100))}¢` : '$0')

// Why an agent cannot take work right now, in the words the panel shows. Mirrors Engine.why.
export function unavailable(a: AgentInfo, s: State = state): string | null {
  if (s.settings.disabled.includes(a.id)) return 'Turned off'
  if (!a.ready && a.setup && a.found) return !a.setup.running ? 'Installed, server is off' : a.setup.suggest ? 'No chat model yet, one click to get one' : 'No model loaded'
  if (!a.ready) return a.found ? a.note ?? 'Not ready' : a.note && a.via === 'cli' ? 'Installed, but it does not start' : 'Not set up'
  const spent = s.ledger?.spent[a.id]
  if (spent && spent.until > Date.now()) return `Out until ${clock(spent.until)}`
  const budget = s.settings.budgets[a.id]
  if (budget > 0 && (s.ledger?.today[a.id]?.cost ?? 0) >= budget) return 'Over today’s budget'
  return null
}
