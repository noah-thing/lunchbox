import { createInterface } from 'node:readline'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Access, AgentInfo, Act, Usage } from '../../shared/types'
import { env, launch, stop, version, which } from '../system'
import { claudeLike, codex, gemini, limitOf, reason, type Turn, type Update } from './parse'
import { chat, listModels, PROVIDERS } from './http'
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
  allow?: string[]
  hands?: string
}

export type Result = {
  text: string
  acts: Act[]
  usage: Usage
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
  parser: { turn: Turn; line: (o: any) => Update | null }
}

type Def = Omit<AgentInfo, 'found' | 'ready' | 'version' | 'note' | 'models' | 'model'> & { spawn?: (i: Input, file: string) => Spec; key?: string; provider?: string }

// The provider an HTTP agent talks to: its own local server, or the key it is billed to.
export const providerOf = (d: Def) => d.provider ?? d.key!

const prompt = (i: Input) => `${i.system}\n\n${i.prompt}`

// Calls to a crewmate can take minutes, far past the CLIs' default tool timeouts.
const HANDS_TIMEOUT = 15 * 60

const claudeHands = (i: Input) =>
  i.hands ? ['--mcp-config', JSON.stringify({ mcpServers: { lunchbox: { type: 'http', url: i.hands } } })] : []

const codexHands = (i: Input) =>
  i.hands
    ? [
        '-c', `mcp_servers.lunchbox.url=${JSON.stringify(i.hands)}`,
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
    spawn: (i) => {
      const allowed = [...(i.access === 'workspace' ? ['Bash'] : []), ...(i.hands ? ['mcp__lunchbox'] : []), ...(i.allow ?? [])]
      return {
        args: [
          '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
          ...{ plan: ['--permission-mode', 'plan'], ask: ['--permission-mode', 'default'], workspace: ['--permission-mode', 'acceptEdits'], full: ['--dangerously-skip-permissions'] }[i.access],
          ...(allowed.length && i.access !== 'full' ? ['--allowedTools', allowed.join(',')] : []),
          ...claudeHands(i),
          ...(i.model ? ['--model', i.model] : []),
          ...(i.session ? ['--resume', i.session] : []),
        ],
        env: i.hands ? { MCP_TOOL_TIMEOUT: String(HANDS_TIMEOUT * 1000) } : undefined,
        stdin: prompt(i),
        parser: claudeLike(),
      }
    },
  },
  {
    id: 'codex', name: 'Codex', short: 'Codex', maker: 'OpenAI', via: 'cli', bin: 'codex', tools: true, mark: 'codex',
    good: 'Building, running and fixing tests', alphabet: '.-01',
    spawn: (i) => {
      const sandbox = { plan: ['-s', 'read-only'], ask: ['-s', 'read-only'], workspace: ['-s', 'workspace-write'], full: ['--dangerously-bypass-approvals-and-sandbox'] }[i.access]
      const common = ['--json', '--skip-git-repo-check', '-C', i.cwd, ...sandbox, ...codexHands(i), ...(i.model ? ['-m', i.model] : [])]
      return { args: i.session ? ['exec', 'resume', ...common, i.session, '-'] : ['exec', ...common, '-'], stdin: prompt(i), parser: codex() }
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
      parser: claudeLike(),
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
  { id: 'ollama', name: 'Ollama', short: 'Local', maker: 'On this computer', via: 'local', bin: 'ollama', provider: 'ollama', tools: false, mark: 'local', good: 'Private and free, never leaves the machine', alphabet: '.:;il!IH#' },
  { id: 'lmstudio', name: 'LM Studio', short: 'LM Studio', maker: 'On this computer', via: 'local', bin: 'lms', provider: 'lmstudio', tools: false, mark: 'lmstudio', good: 'Any model you load in LM Studio, served locally', alphabet: '.-=≡#' },
  { id: 'llamacpp', name: 'llama.cpp', short: 'llama.cpp', maker: 'On this computer', via: 'local', bin: 'llama-server', provider: 'llamacpp', tools: false, mark: 'llamacpp', good: 'A llama-server on port 8080, or any server that speaks the OpenAI API there', alphabet: '.,:;+*' },
  { id: 'claude-api', name: 'Claude API', short: 'Claude API', maker: 'Anthropic', via: 'api', key: 'anthropic', tools: false, mark: 'claude', good: 'Pay per token, with prompt caching', alphabet: '.:-=+*#%@' },
  { id: 'openai-api', name: 'OpenAI API', short: 'GPT', maker: 'OpenAI', via: 'api', key: 'openai', tools: false, mark: 'openai', good: 'Pay per token', alphabet: '.-01' },
  { id: 'grok-api', name: 'xAI API', short: 'Grok API', maker: 'xAI', via: 'api', key: 'xai', tools: false, mark: 'grok', good: 'Pay per token', alphabet: '.:/\\|X#' },
  { id: 'gemini-api', name: 'Gemini API', short: 'Gemini API', maker: 'Google', via: 'api', key: 'google', tools: false, mark: 'gemini', good: 'Pay per token, generous free tier', alphabet: '.,oO0@' },
  { id: 'openrouter', name: 'OpenRouter', short: 'Router', maker: 'Any model', via: 'api', key: 'openrouter', tools: false, mark: 'openrouter', good: 'Hundreds of models behind one key', alphabet: '.:+*#' },
]

export const def = (id: string) => CATALOG.find((d) => d.id === id)

const paths = new Map<string, string>()

export async function detect(keys: Record<string, string>, models: Record<string, string>, health: Record<string, string>): Promise<AgentInfo[]> {
  return Promise.all(
    CATALOG.map(async (d): Promise<AgentInfo> => {
      const base = { ...d, spawn: undefined, key: undefined, model: models[d.id], note: health[d.id] }
      if (d.via === 'cli') {
        const path = await which(d.bin!)
        if (path) paths.set(d.id, path)
        return { ...base, found: !!path, ready: !!path, version: path ? await version(path) : undefined }
      }
      if (d.via === 'local') {
        const [list, setup] = await Promise.all([listModels(providerOf(d), '').catch(() => null), localSetup(d.id, d.bin!)])
        const chatty = (list ?? []).filter((m) => !/embed/i.test(m))
        setup.running = !!list
        return { ...base, found: setup.installed || !!list, ready: chatty.length > 0, models: chatty, model: models[d.id] || chatty[0], setup }
      }
      const key = keys[d.key!]
      return { ...base, found: !!key, ready: !!key }
    }),
  )
}

export async function modelsFor(id: string, keys: Record<string, string>) {
  const d = def(id)
  if (!d || d.via === 'cli') return []
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
    const done = chat(provider, keys[d.key ?? ''] ?? '', input.model ?? '', input.system, input.prompt, ctl.signal, (delta) => onUpdate({ delta }), input.history, input.cacheKey)
      .then((r) => ({ text: r.text, acts: [], usage: r.usage, denied: [], ms: Date.now() - t0 }))
      .catch((e: Error) => {
        const error = ctl.signal.aborted ? 'Stopped' : e.message
        return { ...failed(error), limit: limitOf(error) ?? undefined, ms: Date.now() - t0 }
      })
    return { done, stop: () => ctl.abort() }
  }
  let child: ReturnType<typeof launch> | null = null
  let stopped = false
  const done = (async (): Promise<Result> => {
    const t0 = Date.now()
    const path = paths.get(id) || (await which(d.bin!))
    if (!path) return failed(`${d.name} is not installed on this computer`)
    const file = join(tmpdir(), `lunchbox-${process.pid}-${t0}.txt`)
    const spec = d.spawn!(input, file)
    if (spec.file) writeFileSync(file, spec.file)
    for (const x of spec.extra ?? []) writeFileSync(x.path, x.text, { mode: 0o600 })
    child = launch(path, spec.args, { cwd: input.cwd, env: { ...(await env()), ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (b: Buffer) => { if (stderr.length < 65536) stderr += b.toString() })
    child.stdin?.on('error', () => {})
    child.stdin?.end(spec.stdin ?? '')
    const lines = createInterface({ input: child.stdout! })
    lines.on('line', (raw) => {
      if (!raw.startsWith('{')) return
      try {
        const u = spec.parser.line(JSON.parse(raw))
        if (u) onUpdate(u)
      } catch {}
    })
    const code = await new Promise<number | null>((ok) => {
      child!.on('close', ok)
      child!.on('error', (e) => { stderr += String(e); ok(-1) })
    })
    if (spec.file) rmSync(file, { force: true })
    for (const x of spec.extra ?? []) rmSync(x.path, { force: true })
    const turn = spec.parser.turn
    const text = (turn.final || turn.text).trim()
    let error = turn.error
    if (stopped) error = 'Stopped'
    else if (code !== 0 && !error && !text) error = reason(stderr) || `${d.name} exited with code ${code}`
    const limit = (error && limitOf(error)) || (code !== 0 && !text ? limitOf(stderr) : null)
    return { text, acts: turn.acts, usage: turn.usage, session: turn.session, error, limit: limit ?? undefined, denied: turn.denied, ms: Date.now() - t0 }
  })()
  return { done, stop: () => { stopped = true; if (child) stop(child) } }
}

function failed(error: string): Result {
  return { text: '', acts: [], usage: { input: 0, output: 0, cached: 0, cost: 0 }, error, denied: [], ms: 0 }
}

export { PROVIDERS }
