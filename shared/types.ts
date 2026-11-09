// Shapes shared by the main process and the renderer. Rooms are stored as these events, one JSON
// object per line, so anything added here has to stay readable by older builds.

import type { Category, Ratings } from './route'

export type { Category, Ratings }
export type Access = 'plan' | 'ask' | 'workspace' | 'full'
export type Kind = 'read' | 'write' | 'network' | 'outside' | 'danger' | 'blocked'
export type Verdict = { kind: Kind; decision: 'allow' | 'ask' | 'deny'; reason: string }

export type Via = 'cli' | 'api' | 'local'

export type AgentInfo = {
  id: string
  name: string
  short: string
  maker: string
  via: Via
  bin?: string
  version?: string
  found: boolean
  ready: boolean
  tools: boolean
  model?: string
  models?: string[]
  note?: string
  good: string
  alphabet: string
  mark: string
}

export type Usage = { input: number; output: number; cached: number; cost: number }

export type Act =
  | { t: 'cmd'; command: string; exit: number | null; out?: string }
  | { t: 'edit'; path: string; change: string }
  | { t: 'tool'; name: string; detail: string; ok?: boolean }

export type Proof = { claim: string; ok: boolean; text: string; command?: string }

export type DecideAction =
  | { type: 'run'; command: string; claim: string }
  | { type: 'ask'; who: string; text: string }
  | { type: 'retry'; who: string; tools: string[] }
  | { type: 'accept' }

export type Event = { id: string; at: number } & (
  | { kind: 'you'; text: string; to?: string[]; arena?: boolean; cat?: Category; lead?: string }
  | { kind: 'say'; who: string; text: string; acts: Act[]; usage?: Usage; proof?: Proof[]; arena?: string; reply?: string; error?: string; ms?: number }
  | { kind: 'hands'; from: string; to: string; ask: string; answer: string; acts: Act[]; usage?: Usage; error?: string; ms?: number; via?: 'tool' }
  | { kind: 'image'; by: string; for: string; prompt: string; path: string; usage?: Usage }
  | { kind: 'wall'; from: string; to: string; until?: number; reason: string }
  | { kind: 'decide'; text: string; options: { label: string; action: DecideAction }[] }
  | { kind: 'chose'; ref: string; label: string }
  | { kind: 'run'; who: string; command: string; cwd: string; verdict: Verdict; code: number | null; ms: number; out: string; how: string }
  | { kind: 'pick'; arena: string; who: string }
  | { kind: 'note'; text: string; tone?: 'bad' | 'warn' }
  | { kind: 'crew'; crew: string[] }
)

export type Block = { id: string; title: string; text: string; v: number; at: number; by?: string }

export type RoomMeta = {
  id: string
  name: string
  created: number
  updated: number
  crew: string[]
  workspace: string
  pack?: string
  sessions: Record<string, string>
  seen: Record<string, Record<string, number>>
  heard: Record<string, number>
  blocks: Block[]
  saved: { full: number; sent: number }
  forkedFrom?: { room: string; event: string }
}

export type RoomSummary = Pick<RoomMeta, 'id' | 'name' | 'created' | 'updated' | 'crew' | 'workspace' | 'pack'> & { busy: boolean; waiting: boolean }

export type LiveTurn = {
  id: string
  who: string
  kind: 'say' | 'hands'
  from?: string
  ask?: string
  arena?: string
  text: string
  acts: Act[]
  started: number
}

export type LiveRun = {
  id: string
  who: string
  command: string
  cwd: string
  state: 'checking' | 'asking' | 'running'
  verdict?: Verdict
  out: string
  started: number
}

export type Live = {
  turns: LiveTurn[]
  runs: LiveRun[]
  doing: string
  active: string | null
  waiting: boolean
  cable?: { from: string; to: string; at: number }
}

export type Spent = { until: number; reason: string }

export type Pack = {
  id: string
  name: string
  line: string
  brief: string
  ideas: string[]
  crew?: string[]
  checks?: { label: string; command: string }[]
  source?: 'builtin' | 'user'
}

export type Skill = {
  id: string
  name: string
  brief: string
  steps: string[]
  crew: string[]
  pack?: string
  from: string
  created: number
}

export type Settings = {
  models: Record<string, string>
  budgets: Record<string, number>
  disabled: string[]
  notify: boolean
  defaultCrew: string[]
  imageModel?: string
  route?: 'best' | 'order'
}

export type Ledger = { today: Record<string, Usage>; week: Record<string, Usage>; arena: Record<string, number>; ratings: Ratings; days: { day: string; cost: number; tokens: number }[] }

export type Hit = { room: string; roomName: string; event?: string; text: string }

export type Env = { home: string; platform: string; version: string; cwd: string; data: string }
