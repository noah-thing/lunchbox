import { useSyncExternalStore } from 'react'
import type { Access, AgentInfo, Env, Kind, Ledger, Pack, RoomSummary, Settings, Skill, Spent } from '../../shared/types'

export type { Access, Kind }
export type LedgerView = Ledger & { spent: Record<string, Spent>; budgets: Record<string, number> }

type Bridge = {
  call(channel: string, ...args: unknown[]): Promise<any>
  on(channel: string, fn: (value: any) => void): () => void
}

declare global { interface Window { lb?: Bridge } }

const EMPTY: Record<string, unknown> = {
  env: { home: '', platform: 'web', version: '0.0.0', cwd: '', data: '' },
  agents: [], 'agents:refresh': [], rooms: [], ledger: null, settings: null, skills: [], packs: [], keys: {}, search: [],
}

const browser: Bridge = {
  call: async (channel) => EMPTY[channel] ?? null,
  on: () => () => {},
}

export const desk: Bridge = window.lb ?? browser
export const isDesktop = !!window.lb

type State = {
  env: Env
  agents: AgentInfo[]
  rooms: RoomSummary[]
  settings: Settings
  ledger: LedgerView | null
  skills: Skill[]
  packs: Pack[]
  loaded: boolean
}

let state: State = {
  env: EMPTY.env as Env,
  agents: [], rooms: [], ledger: null, skills: [], packs: [], loaded: false,
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
    desk.on('skills', (skills) => set({ skills }))
    const [env, agents, rooms, settings, ledger, skills, packs] = await Promise.all(
      ['env', 'agents', 'rooms', 'settings', 'ledger', 'skills', 'packs'].map((c) => desk.call(c)),
    )
    set({ env, agents, rooms, settings: settings ?? state.settings, ledger, skills, packs, loaded: true })
  })()
  return booted
}

export const reload = {
  packs: async () => set({ packs: await desk.call('packs') }),
  settings: async (patch: Partial<Settings>) => set({ settings: await desk.call('settings:set', patch) }),
  agents: async () => set({ agents: await desk.call('agents:refresh') }),
}

export const isMac = /Mac/.test(navigator.platform)
export const mod = isMac ? '⌘' : 'Ctrl '
export const machine = () => (state.env.platform === 'darwin' || (!isDesktop && isMac) ? 'this Mac' : 'this computer')

export const ACCESS: { id: Access; name: string; line: string; level: number }[] = [
  { id: 'plan', name: 'Plan', line: 'Read and plan. Nothing on disk changes.', level: 0 },
  { id: 'ask', name: 'Ask', line: 'Reading is free. Edits and commands wait for your OK.', level: 1 },
  { id: 'workspace', name: 'Auto', line: 'Free inside the folder. Anything outside it asks.', level: 2 },
  { id: 'full', name: 'Full access', line: 'Anything on this computer. Deleting folders, sudo and force pushes still ask.', level: 3 },
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

export function tokens(n: number) {
  if (n < 1000) return String(Math.round(n))
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`
  return `${(n / 1e6).toFixed(1)}M`
}

export const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `${Math.max(1, Math.round(n * 100))}¢` : '$0')

// Why an agent cannot take work right now, in the words the panel shows. Mirrors Engine.why.
export function unavailable(a: AgentInfo, s: State = state): string | null {
  if (s.settings.disabled.includes(a.id)) return 'Turned off'
  if (!a.ready) return a.found ? a.note ?? 'Not ready' : 'Not set up'
  const spent = s.ledger?.spent[a.id]
  if (spent && spent.until > Date.now()) return `Out until ${clock(spent.until)}`
  const budget = s.settings.budgets[a.id]
  if (budget > 0 && (s.ledger?.today[a.id]?.cost ?? 0) >= budget) return 'Over today’s budget'
  return null
}
