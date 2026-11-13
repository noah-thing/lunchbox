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
  setup?: LocalSetup
  good: string
  alphabet: string
  mark: string
}

// cached: input tokens served from a provider's prompt cache. written: tokens stored into it.
// saved: dollars the cache saved where the price is known. kept: shared memory tokens Lunchbox
// did not need to send again because the agent already had them.
// saved is net of the premium paid to write the cache; gross is what the cached reads alone saved.
// v 2 marks a turn counted on its own. Claude Code and Codex rows without it may hold a resumed
// session's running totals, and are corrected when read.
// ttl: seconds the provider said it keeps what this turn cached, where it says.
// premium: what storing the cache cost on top of the input price, in totals, where both the gross
// and the net saving are known.
export type Usage = {
  input: number; output: number; cached: number; cost: number; written?: number; saved?: number; gross?: number; kept?: number; ttl?: number; premium?: number; v?: 2
  // What Lunchbox itself kept out of the agent's requests, in tokens: kept (above) is memory and
  // conversation the agent did not need sending, cut is command output shortened before it
  // reached the context, held is a session read from a cache Lunchbox kept warm past its lifetime.
  cut?: number
  held?: number
  // Dollars at list price, where the agent has one. spared and trimmed are what the tokens never
  // sent would have cost, kept and cut in that order. warmed is what managing the cache's
  // lifetime saved: writes made at the five minute price where the agent would have paid the
  // hour price, and sessions read from a cache that would otherwise have been written again (held).
  spared?: number
  trimmed?: number
  warmed?: number
  // Dollars spent keeping caches warm. Already part of cost.
  pings?: number
}

// What a CLI session has reported in total so far: its cost, and token counts per model.
export type Meter = { cost: number; rows: Record<string, number[]> }

// What a local model server needs before it can take work. app is set when there is a desktop
// app to open; suggest is the chat model that fits this computer's memory.
export type LocalSetup = { installed: boolean; running: boolean; app?: boolean; download: string; suggest?: { model: string; size: string } }
export type Pull = { agent: string; model: string; status: string; done: number; total: number; error?: string; finished?: boolean }

export type Act =
  | { t: 'cmd'; command: string; exit: number | null; out?: string }
  | { t: 'edit'; path: string; change: string }
  | { t: 'tool'; name: string; detail: string; ok?: boolean }
  // A subagent the agent started for part of its work: what it was asked, which kind and model,
  // how many tools it has used and the last one, and how it ended.
  | { t: 'agent'; id: string; task: string; kind?: string; model?: string; state: 'running' | 'done' | 'failed'; tools: number; last?: string; started: number; ms?: number; note?: string }

export type Proof = { claim: string; ok: boolean; text: string; command?: string }

export type DecideAction =
  | { type: 'run'; command: string; claim: string }
  | { type: 'ask'; who: string; text: string }
  | { type: 'retry'; who: string; tools: string[] }
  | { type: 'accept' }
  | { type: 'flow'; flow: { name: string; steps: FlowStep[]; every?: Every; at?: string; day?: number } }

// inside: written while another agent's turn was running, for that turn, and shown within it at
// the point it was asked for: mark is how much of that turn's text came before.
export type Event = { id: string; at: number; inside?: { turn: string; mark: number } } & (
  | { kind: 'you'; text: string; to?: string[]; arena?: boolean; cat?: Category; lead?: string; files?: string[]; from?: 'flow' | 'phone' }
  | { kind: 'say'; who: string; text: string; acts: Act[]; usage?: Usage; proof?: Proof[]; arena?: string; reply?: string; error?: string; ms?: number; turn?: string }
  | { kind: 'hands'; from: string; to: string; ask: string; answer: string; acts: Act[]; usage?: Usage; error?: string; ms?: number; via?: 'tool' }
  | { kind: 'image'; by: string; for: string; prompt: string; path: string; size?: string; usage?: Usage }
  | { kind: 'wall'; from: string; to: string; until?: number; reason: string; arena?: string }
  | { kind: 'decide'; text: string; options: { label: string; action: DecideAction }[] }
  | { kind: 'chose'; ref: string; label: string }
  | { kind: 'run'; who: string; command: string; cwd: string; verdict: Verdict; code: number | null; ms: number; out: string; how: string }
  | { kind: 'pick'; arena: string; who: string }
  | { kind: 'note'; text: string; tone?: 'bad' | 'warn'; undo?: string }
  | { kind: 'crew'; crew: string[] }
  // A crewmate the main agent brought in for one piece of work, and the moment it stepped out.
  | { kind: 'joined'; who: string; by: string; task: string }
  | { kind: 'left'; who: string }
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
  // Studio: agents decide a direction, look at what they make and refine it before handing over.
  studio?: boolean
  // The project's own design files, found once when Studio is switched on, so the instructions stay
  // the same turn to turn and files an agent creates later are never taken for the person's taste.
  design?: string[]
  sessions: Record<string, string>
  // Each agent's session totals as of its last turn, so the next turn can be counted on its own.
  meters?: Record<string, Meter & { session: string }>
  // A mark of the protocol each agent's session was last sent.
  protos?: Record<string, string>
  // Tokens each agent reads from cache at the start of a brand new session: the part every
  // session shares. A session picked up cold reads this much and writes the rest again.
  bases?: Record<string, number>
  // Sessions that cache for five minutes by the room's choice, by agent.
  quick?: Record<string, string>
  seen: Record<string, Record<string, number>>
  heard: Record<string, number>
  blocks: Block[]
  saved: { full: number; sent: number }
  forkedFrom?: { room: string; event: string }
  checkpoints?: Checkpoint[]
  project?: boolean
  flow?: string
  pinned?: boolean
  archived?: boolean
}

// The folder as it was just before a message was handled, kept in a shadow git repository.
export type Checkpoint = { ref: string; event: string; at: number; files?: number }

export type RoomSummary = Pick<RoomMeta, 'id' | 'name' | 'created' | 'updated' | 'crew' | 'workspace' | 'pack' | 'flow' | 'pinned' | 'archived'> & { busy: boolean; waiting: boolean }

// Everything across the rooms that is waiting for a person: decisions and commands to approve.
export type Waiting = { room: string; name: string; items: ({ kind: 'decide'; ref: string; text: string; options: string[] } | { kind: 'run'; id: string; command: string; reason: string })[] }

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
  // What the agent is doing this moment, such as a command it is running.
  now?: string
  // Tokens written so far this turn, thinking included, for agents that report them as they go.
  tokens?: number
  // Set when the turn is drawing an image for a crewmate; label is the image's description.
  image?: boolean
  label?: string
  size?: string
}

export type LiveRun = {
  id: string
  who: string
  command: string
  cwd: string
  state: 'checking' | 'asking' | 'running'
  // A change to a file waiting for a yes, where command holds what the change is.
  edit?: boolean
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
  // Messages sent while an agent was answering, in the order they will run.
  queued: { id: string; text: string; files?: string[] }[]
  // Queued text handed back to the message box, after a stop or when taken back. n changes each time.
  back?: { text: string; files?: string[]; n: number; merge: true }
  // When the room last read each agent's session to keep its cache from running out.
  warm?: Record<string, number>
}

export type Spent = { until: number; reason: string }

// One limit window of a plan as its provider reports it. used is 0 to 1. tokens is Lunchbox's
// measured estimate of how many tokens the whole window holds, once it has enough samples.
export type PlanWindow = {
  id: string; label: string; used: number; resets?: number; start?: number
  // How big the window is: requests where the provider publishes a count, otherwise fresh tokens
  // measured from this computer's own logs.
  total?: number; unit?: 'tokens' | 'requests'
  // Grok's pool is shared with Grok's other products; this is Grok Build's part of what is used.
  share?: number
  // The size in what the provider actually spends: dollars at list price, or Codex credits.
  allowance?: number; currency?: 'usd' | 'credits'
}
export type PlanLimits = { agent: string; plan?: string; windows: PlanWindow[]; at: number; error?: string; reached?: boolean; stale?: boolean }

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
  // Local models are freed from memory as soon as they answer.
  unload?: boolean
  models: Record<string, string>
  budgets: Record<string, number>
  disabled: string[]
  notify: boolean
  defaultCrew: string[]
  imageModel?: string
  route?: 'best' | 'order'
  snapshots?: boolean
  tools?: Record<string, { on: boolean; input?: string }>
  browser?: boolean
  remote?: { on: boolean; chat?: number; name?: string; access?: Access }
  planLimits?: boolean
  connectors?: Connector[]
  // Where a built in local server answers when it is not the usual address on this computer.
  endpoints?: Record<string, string>
  habits?: string[]
  dismissed?: string[]
  autoUpdate?: boolean
  // Saving, each on unless set to false, except lean which is off unless set: trim shortens long
  // command output, warm keeps a room's cache from running out, lean starts Claude Code with the
  // room's own tools only, leaving out the MCP servers set up outside Lunchbox.
  saving?: { trim?: boolean; warm?: boolean; lean?: boolean }
  // How hard each agent thinks, for the CLIs that take it. Unset leaves the agent's own default.
  effort?: Record<string, string>
  feedIssued?: number
  // The anonymous install count, on unless turned off in Settings. countId is a random ID made on
  // this computer; countDay is the last day it was sent.
  count?: boolean
  countId?: string
  countDay?: string
}

// Anything not built in: an API that speaks the OpenAI or Anthropic format, or a command-line
// agent run with a prompt. Keys live in the keychain under `conn:<id>`, never in settings.
export type Connector = {
  id: string
  name: string
  kind: 'openai' | 'anthropic' | 'cli'
  base?: string
  model?: string
  command?: string
  args?: string
  output?: 'text' | 'stream-json'
  good?: string
}

export type FlowStep = { text: string; to?: string }
export type Every = 'hour' | 'day' | 'weekday' | 'week'

export type Flow = {
  id: string
  name: string
  steps: FlowStep[]
  crew: string[]
  workspace: string
  pack?: string
  access: Access
  every?: Every
  at?: string
  day?: number
  on: boolean
  created: number
  next?: number
  runs: { at: number; room: string; ok: boolean; ms: number }[]
}

export type FlowState = { flow: string; room: string; step: number; of: number }

export type Ledger = { today: Record<string, Usage>; week: Record<string, Usage>; arena: Record<string, number>; ratings: Ratings; days: Day[]; rooms: Record<string, Usage> }
export type Day = { day: string; cost: number; tokens: number; input: number; cached: number; saved: number; gross: number; kept: number; cut?: number; held?: number; spared?: number; trimmed?: number; warmed?: number; pings?: number }

export type Hit = { room: string; roomName: string; event?: string; text: string }

export type Env = { home: string; platform: string; version: string; cwd: string; data: string }

// A message pushed to every copy of the app from the signed feed, no update needed. A toast sits in
// the corner, a card is a designed pop-up for big news, a banner runs across the top of the page.
export type Notice = {
  id: string
  kind: 'toast' | 'card' | 'banner'
  title: string
  body?: string
  image?: string
  action?: { label: string; url: string }
  // Who sees it: versions from and to (inclusive), platforms, and a window in time.
  from?: string
  to?: string
  platforms?: ('darwin' | 'win32' | 'linux')[]
  after?: string
  until?: string
}

export type UpdateState =
  | { state: 'idle' | 'checking' | 'none' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; progress: number }
  | { state: 'ready'; version: string }
  | { state: 'manual'; version: string; url: string }
  | { state: 'error'; error: string }

export type Report = { kind: 'bug' | 'idea' | 'question'; text: string; contact?: string; context?: string; diagnostics?: string }
