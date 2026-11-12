import { createInterface } from 'node:readline'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Access, AgentInfo, Act, Connector, Meter, Usage } from '../../shared/types'
import { capture, env, launch, stop, version, which } from '../system'
import { claudeLike, codex, gemini, limitOf, reason, textOut, type Turn, type Update } from './parse'
import { chat, listModels, parseHeaders, PROVIDERS } from './http'
import { logoOf } from '../../shared/logos'
import { localSetup } from '../local'

export type Input = {
  prompt: string
  system: string
  // For HTTP agents: the conversation as cacheable blocks, with prompt then holding only the rest.
  history?: string[]
  cacheKey?: string
  cwd: string
  access: Access
  model?: string
  session?: string
  // What that session had reported in total before this turn.
  meter?: Meter
  allow?: string[]
  hands?: string
  fresh?: boolean
}

export type Result = {
  text: string
  acts: Act[]
  usage: Usage
  meter?: Meter
  session?: string
  error?: string
  limit?: { until: number }
  denied: string[]
  ms: number
}

export type Running = { done: Promise<Result>; stop(): void }

type Spec = {
  args: string[]
  stdin?: string
  file?: string
  env?: Record<string, string>
  extra?: { path: string; text: string }[]
  parser: { turn: Turn; line: (o: any) => Update | null; raw?: (s: string) => Update | null }
}

type Def = Omit<AgentInfo, 'found' | 'ready' | 'version' | 'note' | 'models' | 'model'> & { spawn?: (i: Input, file: string) => Spec; key?: string; provider?: string }

// The provider an HTTP agent talks to: its own local server, or the key it is billed to.
export const providerOf = (d: Def) => d.provider ?? d.key!

// A resumed session already has the protocol; it is sent again only when it changed.
const prompt = (i: Input) => (i.fresh === false ? i.prompt : `${i.system}\n\n${i.prompt}`)

// Calls to a crewmate can take minutes, far past the CLIs' default tool timeouts.
const HANDS_TIMEOUT = 15 * 60
// Long enough for any real turn; past it the CLI is stuck, and the room's queue with it.
const TURN_LIMIT = 60 * 60 * 1000

// The hands URL carries a per-turn token, so it goes in a private file rather than the command
// line, where any other program on the computer could read it.
function claudeHands(i: Input, file: string): Pick<Spec, 'extra'> & { args: string[] } {
  if (!i.hands) return { args: [] }
  const path = file.replace(/\.txt$/, '.mcp.json')
  return { args: ['--mcp-config', path], extra: [{ path, text: JSON.stringify({ mcpServers: { lunchbox: { type: 'http', url: i.hands } } }) }] }
}

// Codex takes servers on the command line only, so the token travels in the environment, which
// other accounts on the computer cannot read, and the URL on the command line carries none.
const HANDS_ENV = 'LUNCHBOX_HANDS_TOKEN'
const codexHands = (i: Input) =>
  i.hands
    ? [
        '-c', `mcp_servers.lunchbox.url=${JSON.stringify(i.hands.replace(/\/[\w-]+$/, ''))}`,
        '-c', `mcp_servers.lunchbox.bearer_token_env_var="${HANDS_ENV}"`,
        '-c', `mcp_servers.lunchbox.tool_timeout_sec=${HANDS_TIMEOUT}`,
        '-c', 'mcp_servers.lunchbox.default_tools_approval_mode="approve"',
      ]
    : []

function geminiHands(i: Input, file: string): Pick<Spec, 'env' | 'extra'> {
  if (!i.hands) return {}
  const path = file.replace(/\.txt$/, '.gemini.json')
  const settings = { mcpServers: { lunchbox: { httpUrl: i.hands, timeout: HANDS_TIMEOUT * 1000, trust: true } } }
  return { env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path }, extra: [{ path, text: JSON.stringify(settings) }] }
}

export const CATALOG: Def[] = [
  {
    id: 'claude', name: 'Claude Code', short: 'Claude', maker: 'Anthropic', via: 'cli', bin: 'claude', tools: true, mark: 'claude',
    good: 'Design, careful edits, long reasoning', alphabet: '.:-=+*#%@',
    spawn: (i, file) => {
      const allowed = ['Task', 'Agent', ...(i.access === 'workspace' ? ['Bash'] : []), ...(i.hands ? ['mcp__lunchbox'] : []), ...(i.allow ?? [])]
      const hands = claudeHands(i, file)
      return {
        extra: hands.extra,
        args: [
          '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
          ...{ plan: ['--permission-mode', 'plan'], ask: ['--permission-mode', 'default'], workspace: ['--permission-mode', 'acceptEdits'], full: ['--dangerously-skip-permissions'] }[i.access],
          ...(allowed.length && i.access !== 'full' ? ['--allowedTools', allowed.join(',')] : []),
          ...hands.args,
          ...(i.model ? ['--model', i.model] : []),
          ...(i.session ? ['--resume', i.session] : []),
        ],
        env: i.hands ? { MCP_TOOL_TIMEOUT: String(HANDS_TIMEOUT * 1000) } : undefined,
        stdin: prompt(i),
        parser: claudeLike(i.meter, !!i.session),
      }
    },
  },
  {
    id: 'codex', name: 'Codex', short: 'Codex', maker: 'OpenAI', via: 'cli', bin: 'codex', tools: true, mark: 'codex',
    good: 'Building, running and fixing tests', alphabet: '.-01',
    spawn: (i) => {
      const sandbox = { plan: ['-s', 'read-only'], ask: ['-s', 'read-only'], workspace: ['-s', 'workspace-write'], full: ['--dangerously-bypass-approvals-and-sandbox'] }[i.access]
      const tail = [...codexHands(i), ...(i.model ? ['-m', i.model] : [])]
      // `exec resume` takes neither -C nor -s: the folder comes from the working directory and the
      // sandbox from config, or every resumed turn fails and silently starts a new session.
      const resumeSandbox = i.access === 'full' ? ['--dangerously-bypass-approvals-and-sandbox'] : ['-c', `sandbox_mode="${i.access === 'workspace' ? 'workspace-write' : 'read-only'}"`]
      return {
        args: i.session
          ? ['exec', 'resume', '--json', '--skip-git-repo-check', ...resumeSandbox, ...tail, i.session, '-']
          : ['exec', '--json', '--skip-git-repo-check', '-C', i.cwd, ...sandbox, ...tail, '-'],
        env: i.hands ? { [HANDS_ENV]: i.hands.split('/').pop()! } : undefined,
        stdin: prompt(i),
        parser: codex(i.model, i.meter, !!i.session),
      }
    },
  },
  {
    id: 'grok', name: 'Grok Build', short: 'Grok', maker: 'xAI', via: 'cli', bin: 'grok', tools: true, mark: 'grok',
    good: 'Live X and web search, fast answers', alphabet: '.:/\\|X#',
    spawn: (i, file) => ({
      args: [
        '--prompt-file', file, '--output-format', 'streaming-messages-json',
        ...{ plan: ['--permission-mode', 'plan'], ask: ['--permission-mode', 'default'], workspace: ['--permission-mode', 'acceptEdits'], full: ['--always-approve'] }[i.access],
        ...(i.model ? ['-m', i.model] : []),
        ...(i.session ? ['-r', i.session] : []),
      ],
      file: prompt(i),
      parser: claudeLike(i.meter, !!i.session),
    }),
  },
  {
    id: 'gemini', name: 'Gemini CLI', short: 'Gemini', maker: 'Google', via: 'cli', bin: 'gemini', tools: true, mark: 'gemini',
    good: 'Long files, review, second opinions', alphabet: '.,oO0@',
    spawn: (i, file) => ({
      args: [
        '-o', 'stream-json', '--skip-trust', '-p', 'Respond to the request above.',
        '--approval-mode', { plan: 'plan', ask: 'default', workspace: 'auto_edit', full: 'yolo' }[i.access],
        ...(i.model ? ['-m', i.model] : []),
      ],
      ...geminiHands(i, file),
      stdin: prompt(i),
      parser: gemini(),
    }),
  },
  { id: 'ollama', name: 'Ollama', short: 'Ollama', maker: 'On this computer', via: 'local', bin: 'ollama', provider: 'ollama', tools: false, mark: 'local', good: 'Private and free, never leaves the machine', alphabet: '.:;il!IH#' },
  { id: 'lmstudio', name: 'LM Studio', short: 'LM Studio', maker: 'On this computer', via: 'local', bin: 'lms', provider: 'lmstudio', tools: false, mark: 'lmstudio', good: 'Any model you load in LM Studio, served locally', alphabet: '.-=≡#' },
  { id: 'llamacpp', name: 'llama.cpp', short: 'llama.cpp', maker: 'On this computer', via: 'local', bin: 'llama-server', provider: 'llamacpp', tools: false, mark: 'llamacpp', good: 'A llama-server on port 8080, or any server that speaks the OpenAI API there', alphabet: '.,:;+*' },
  { id: 'claude-api', name: 'Claude API', short: 'Claude API', maker: 'Anthropic', via: 'api', key: 'anthropic', tools: false, mark: 'claude', good: 'Pay per token, with prompt caching', alphabet: '.:-=+*#%@' },
  { id: 'openai-api', name: 'OpenAI API', short: 'GPT', maker: 'OpenAI', via: 'api', key: 'openai', tools: false, mark: 'openai', good: 'Pay per token', alphabet: '.-01' },
  { id: 'grok-api', name: 'xAI API', short: 'Grok API', maker: 'xAI', via: 'api', key: 'xai', tools: false, mark: 'grok', good: 'Pay per token', alphabet: '.:/\\|X#' },
  { id: 'gemini-api', name: 'Gemini API', short: 'Gemini API', maker: 'Google', via: 'api', key: 'google', tools: false, mark: 'gemini', good: 'Pay per token, generous free tier', alphabet: '.,oO0@' },
  { id: 'openrouter', name: 'OpenRouter', short: 'Router', maker: 'Any model', via: 'api', key: 'openrouter', tools: false, mark: 'openrouter', good: 'Hundreds of models behind one key', alphabet: '.:+*#' },
]

// Connectors the person added, rebuilt whenever settings change.
let custom: Def[] = []

// A command line split like a shell would, keeping quoted parts together.
export function words(s: string) {
  const out: string[] = []
  // Inside double quotes only \" and \\ are escapes, so C:\Program Files\tool.exe survives.
  for (const m of s.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(m[1] !== undefined ? m[1].replace(/\\(["\\])/g, '$1') : (m[2] ?? m[3]))
  return out
}

function fromConnector(c: Connector): Def {
  const base = { id: c.id, name: c.name, short: c.name, maker: 'Your connector', tools: c.kind === 'cli', mark: logoOf(c), good: c.good || 'Added by you', alphabet: '.:+*#' }
  if (c.kind !== 'cli') {
    PROVIDERS[`conn:${c.id}`] = { base: (c.base ?? '').replace(/\/+$/, ''), style: c.kind, prefer: c.model ? new RegExp(`^${c.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : /./ }
    return { ...base, via: 'api', key: `conn:${c.id}`, provider: `conn:${c.id}` }
  }
  const [bin = '', ...fixed] = words(c.command ?? '')
  return {
    ...base, via: 'cli', bin,
    // {prompt} is the whole request, {file} a temporary file holding it, {model} and {cwd} as named.
    // Without {prompt} or {file} the request goes to the agent on standard input.
    spawn: (i, file) => {
      const full = prompt(i)
      const template = [...fixed, ...words(c.args ?? '')]
      const inline = template.some((a) => a.includes('{prompt}') || a.includes('{file}'))
      // A command line can't carry a whole room on Windows, or a newline through a .cmd shim, so
      // a long or multi-line request goes in the file and the argument points at it.
      const viaFile = template.some((a) => a.includes('{prompt}')) && (full.length > 7000 || (process.platform === 'win32' && /\n/.test(full)))
      const text = viaFile ? `Read the full request in ${file} and do what it asks.` : full
      const model = i.model ?? c.model ?? ''
      const vals: Record<string, string> = { prompt: text, file, model, cwd: i.cwd }
      const args: string[] = []
      for (const [n, a] of template.entries()) {
        // A flag whose value would be an empty {model} goes too, rather than eat the next flag.
        if (a === '{model}' && !model) { if (args.length && /^-/.test(template[n - 1] ?? '')) args.pop(); continue }
        const v = a.replace(/\{(prompt|file|model|cwd)\}/g, (_m, k: string) => vals[k])
        if (v !== '' && !/^-[\w-]+=$/.test(v)) args.push(v)
      }
      return { args, stdin: inline ? '' : full, file: viaFile || template.some((a) => a.includes('{file}')) ? full : undefined, parser: c.output === 'stream-json' ? claudeLike() : textOut() }
    },
  }
}

// A connector's extra headers live in the keychain beside its key, since they often hold one.
function wear(d: Def, keys: Record<string, string>) {
  if (!d.key?.startsWith('conn:') || !PROVIDERS[d.key]) return
  PROVIDERS[d.key].extra = parseHeaders(keys[`${d.key}:headers`])
}

export function useConnectors(list: Connector[] = []) {
  for (const k of Object.keys(PROVIDERS)) if (k.startsWith('conn:')) delete PROVIDERS[k]
  custom = list.filter((c) => c.id && c.name).map(fromConnector)
}

const all = () => [...CATALOG, ...custom]

export const def = (id: string) => all().find((d) => d.id === id)

async function locate(bin: string) {
  const path = bin.replace(/^~(?=[\\/]|$)/, homedir())
  if (isAbsolute(path)) return existsSync(path) ? path : ''
  // The app's own working folder means nothing to the person, so ./tools/agent starts from home.
  if (/[\\/]/.test(path)) return existsSync(resolve(homedir(), path)) ? resolve(homedir(), path) : ''
  return /^[\w.@+-]+$/.test(path) ? which(path) : ''
}

const paths = new Map<string, string>()

export async function detect(keys: Record<string, string>, models: Record<string, string>, health: Record<string, string>): Promise<AgentInfo[]> {
  return Promise.all(
    all().map(async (d): Promise<AgentInfo> => {
      const base = { ...d, spawn: undefined, key: undefined, model: models[d.id], note: health[d.id] }
      if (d.via === 'cli') {
        // One broken install shows as not found rather than hiding every other agent with it.
        const path = await locate(d.bin!).catch(() => '')
        if (path) paths.set(d.id, path)
        return { ...base, found: !!path, ready: !!path, version: path ? await version(path).catch(() => '') : undefined }
      }
      if (d.via === 'local') {
        const [list, setup] = await Promise.all([listModels(providerOf(d), '').catch(() => null), localSetup(d.id, d.bin!)])
        const chatty = (list ?? []).filter((m) => !/embed/i.test(m))
        setup.running = !!list
        return { ...base, found: setup.installed || !!list, ready: chatty.length > 0, models: chatty, model: models[d.id] || chatty[0], setup }
      }
      // A connector may point at a server that needs no key, such as vLLM on this computer.
      const key = keys[d.key!]
      const mine = d.key!.startsWith('conn:')
      return { ...base, found: mine || !!key, ready: mine || !!key }
    }),
  )
}

// What Claude Code's --model takes: its short names follow the newest of each line, the full ids
// pin a version. Anything else typed in the field is passed through as is.
const CLAUDE_MODELS = ['fable', 'opus', 'sonnet', 'haiku', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']

// Gemini CLI has no command that lists models; these are the ones it accepts by name, newest first.
const GEMINI_MODELS = ['auto-gemini-3', 'gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.1-flash-lite']

// Codex keeps the models this account may pick in its own cache, in the order its picker shows them.
function codexModels() {
  try {
    const file = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json')
    const list: { slug?: string; visibility?: string; priority?: number }[] = JSON.parse(readFileSync(file, 'utf8')).models ?? []
    return list.filter((m) => m.slug && m.visibility !== 'hide').sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)).map((m) => m.slug!)
  } catch {
    return []
  }
}

// Grok prints its models with `grok models`: the default marked with *, the rest with -.
async function grokModels() {
  const path = paths.get('grok') ?? (await locate('grok'))
  if (!path) return []
  const out = await capture(path, ['models'], 8000, await env())
  return [...out.matchAll(/^\s*[*-]\s+([\w.:/-]+)/gm)].map((m) => m[1])
}

export async function modelsFor(id: string, keys: Record<string, string>) {
  const d = def(id)
  if (d?.id === 'claude') return CLAUDE_MODELS
  if (d?.id === 'codex') return codexModels()
  if (d?.id === 'grok') return grokModels()
  if (d?.id === 'gemini') return GEMINI_MODELS
  if (!d || d.via === 'cli') return []
  wear(d, keys)
  const all = await listModels(providerOf(d), keys[d.key!] ?? '')
  return d.via === 'local' ? all.filter((m) => !/embed/i.test(m)) : all
}

export function run(id: string, input: Input, keys: Record<string, string>, onUpdate: (u: Update) => void): Running {
  const d = def(id)
  if (!d) return { done: Promise.resolve(failed(`Unknown agent ${id}`)), stop() {} }
  if (d.via !== 'cli') {
    const provider = providerOf(d)
    const ctl = new AbortController()
    const t0 = Date.now()
    wear(d, keys)
    const done = chat(provider, keys[d.key ?? ''] ?? '', input.model ?? '', input.system, input.prompt, ctl.signal, (delta) => onUpdate({ delta }), input.history, input.cacheKey)
      .then((r) => ({ text: r.text, acts: [], usage: r.usage, denied: [], ms: Date.now() - t0 }))
      .catch((e: Error) => {
        const error = ctl.signal.aborted ? 'Stopped' : e.message
        return { ...failed(error), limit: limitOf(error) ?? undefined, ms: Date.now() - t0 }
      })
    return { done, stop: () => ctl.abort() }
  }
  // Lunchbox can't hold a command line connector to Plan or Ask; it says so instead of running it.
  if (d.maker === 'Your connector' && d.via === 'cli' && (input.access === 'plan' || input.access === 'ask')) {
    return { done: Promise.resolve(failed(`${d.name} runs with full permissions, so it does not run in ${input.access === 'plan' ? 'Plan' : 'Ask'} mode. Switch the room to Auto to use it.`)), stop() {} }
  }
  const { name } = d
  let child: ReturnType<typeof launch> | null = null
  let stopped = false
  let timedOut = false
  const done = (async (): Promise<Result> => {
    const t0 = Date.now()
    const path = paths.get(id) || (await locate(d.bin!))
    if (!path) return failed(`${d.name} is not installed on this computer`)
    const file = join(tmpdir(), `lunchbox-${process.pid}-${t0}-${Math.random().toString(36).slice(2, 8)}.txt`)
    const spec = d.spawn!(input, file)
    // The prompt and the hands token are in these files, so they go however the turn ends.
    try {
      if (spec.file) writeFileSync(file, spec.file, { mode: 0o600 })
      for (const x of spec.extra ?? []) writeFileSync(x.path, x.text, { mode: 0o600 })
      // Stop pressed while the tool was still being found: it never starts.
      if (stopped) return failed('Stopped')
      return await cli(path, spec, t0)
    } finally {
      if (spec.file) rmSync(file, { force: true })
      for (const x of spec.extra ?? []) rmSync(x.path, { force: true })
    }
  })()
  async function cli(path: string, spec: Spec, t0: number): Promise<Result> {
    let proc: ReturnType<typeof launch>
    try {
      proc = child = launch(path, spec.args, { cwd: input.cwd, env: { ...(await env()), ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      return failed(`${name} could not start: ${(err as Error).message}`)
    }
    let stderr = ''
    let over = false
    proc.stderr?.on('data', (b: Buffer) => { if (stderr.length < 65536) stderr += b.toString() })
    proc.stdin?.on('error', () => {})
    proc.stdin?.end(spec.stdin ?? '')
    const lines = createInterface({ input: proc.stdout! })
    lines.on('line', (raw) => {
      if (over) return
      if (spec.parser.raw) {
        const u = spec.parser.raw(raw)
        if (u) onUpdate(u)
        return
      }
      if (!raw.startsWith('{')) return
      try {
        const u = spec.parser.line(JSON.parse(raw))
        if (u) onUpdate(u)
      } catch {}
    })
    const cap = setTimeout(() => { timedOut = true; stop(proc) }, TURN_LIMIT)
    const code = await new Promise<number | null>((ok) => {
      proc.on('close', ok)
      // A background process the CLI started can hold its output open long after the CLI is done.
      proc.on('exit', (c) => setTimeout(() => ok(c), 2000))
      proc.on('error', (e) => { stderr += String(e); ok(-1) })
    })
    over = true
    clearTimeout(cap)
    const turn = spec.parser.turn
    // The CLI's final answer is only its last message. When the turn wrote before that too, keep it all.
    const text = (turn.final && turn.text.trim().endsWith(turn.final.trim()) ? turn.text : turn.final || turn.text).trim()
    let error = turn.error
    if (timedOut) error = `${name} was still working after ${TURN_LIMIT / 60000} minutes, so Lunchbox stopped it`
    else if (stopped) error = 'Stopped'
    // A crash partway through keeps what was written, but it is not a finished answer.
    else if (code !== 0 && !error) error = reason(stderr) || `${name} exited with code ${code}`
    const limit = (error && limitOf(error)) || (code !== 0 && !text ? limitOf(stderr) : null)
    return { text, acts: turn.acts, usage: turn.usage, meter: turn.meter, session: turn.session, error, limit: limit ?? undefined, denied: turn.denied, ms: Date.now() - t0 }
  }
  return { done, stop: () => { stopped = true; if (child) stop(child) } }
}

function failed(error: string): Result {
  return { text: '', acts: [], usage: { input: 0, output: 0, cached: 0, cost: 0 }, error, denied: [], ms: 0 }
}

export { PROVIDERS }

// Checks a connector before it is saved: the command is on this computer, or the API answers
// with its list of models.
export async function testConnector(c: Connector, key: string, extra = ''): Promise<{ ok: boolean; note: string; models?: string[] }> {
  if (c.kind === 'cli') {
    const [bin] = words(c.command ?? '')
    const path = bin ? await locate(bin) : ''
    if (!path) return { ok: false, note: `${bin || 'The command'} was not found on this computer` }
    const v = await version(path).catch(() => '')
    return { ok: true, note: `Found at ${path}${v ? `, version ${v}` : ''}` }
  }
  if (!/^https?:\/\//.test(c.base ?? '')) return { ok: false, note: 'The address should start with https:// or http://' }
  const id = `test:${Date.now()}`
  PROVIDERS[id] = { base: c.base!.replace(/\/+$/, ''), style: c.kind, prefer: /./, extra: parseHeaders(extra) }
  try {
    const models = await listModels(id, key)
    return { ok: true, note: models.length ? `Connected, ${models.length} model${models.length > 1 ? 's' : ''}` : 'Connected', models }
  } catch (e) {
    return { ok: false, note: (e as Error).message || 'No answer from that address' }
  } finally {
    delete PROVIDERS[id]
  }
}

// Which of these commands are installed, for offering the ones already on this computer.
export async function installed(bins: string[]) {
  const out: Record<string, boolean> = {}
  await Promise.all(bins.slice(0, 20).map(async (b) => { out[b] = !!(await locate(b)) }))
  return out
}
