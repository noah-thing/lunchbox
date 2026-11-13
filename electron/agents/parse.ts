import { cacheSaving, claudeCost, claudePrice, codexSaving, readSaving } from '../../shared/prices'
import type { Act, Meter, Usage } from '../../shared/types'

// Each CLI prints one JSON object per line. A parser folds those lines into a Turn and reports
// what changed so the room can show text and activity while the agent is still working.

export type Turn = {
  text: string
  final: string
  acts: Act[]
  usage: Usage
  // What the session has reported in total so far, when the CLI counts that way.
  meter?: Meter
  session?: string
  error?: string
  denied: string[]
  working?: string
  // The model that answered, as the CLI names it.
  model?: string
  // What the first and the last request of the turn read from cache and wrote to it. The first
  // says whether the session was still cached when the turn began; the last, how big it is now.
  first?: { read: number; written: number }
  last?: { read: number; written: number }
  // What this turn's five minute cache writes would have cost on top at the hour price.
  quick?: number
}

// agents carries subagents as they change; each replaces the one with the same id. working is the
// step in progress, '' once there is none; a step starting with ~ is a phrase rather than a tool.
// tokens counts what the agent has written so far this turn, thinking included, as it streams.
export type Update = { delta?: string; acts?: Act[]; working?: string; agents?: Extract<Act, { t: 'agent' }>[]; tokens?: number }

// Claude Code reports cache reads and writes per model, so the saving is priced per model at API
// rates. A subscription pays nothing per token; this is what the same work would have cost.
// A row is input, output, cache reads, cache writes, the hour long share of those writes, cost.
function claudeSaved(rows: Record<string, number[]>) {
  let net: number | undefined
  let gross: number | undefined
  let quick = 0
  for (const [m, [input, output, read, all, hour, cost]] of Object.entries(rows)) {
    // Claude Code reports writes by lifetime; an hour entry costs twice the input price, not 1.25.
    const u = { input, output, read, short: Math.max(0, all - hour), hour }
    // Haiku 5.5 charges more for a prompt past 100K tokens, and a turn's totals do not say how
    // long each prompt was. The long rate counts only when it explains the reported cost better.
    const long = cost > 0 && Math.abs(cost - (claudeCost(m, u, Infinity) ?? 0)) < Math.abs(cost - (claudeCost(m, u, 0) ?? 0))
    const prompt = long ? Infinity : 0
    const n = cacheSaving(m, read, u, prompt)
    const g = readSaving(m, read, prompt)
    if (n !== null) net = (net ?? 0) + n
    if (g !== null) gross = (gross ?? 0) + g
    // An hour entry costs twice the input price to write, a five minute one 1.25 times.
    const p = claudePrice(m, prompt)
    if (p) quick += (u.short * p.input * 0.75) / 1e6
  }
  return { saved: net, gross, quick }
}

const sum = (rows: Record<string, number[]>, k: number) => Object.values(rows).reduce((n, r) => n + (r[k] ?? 0), 0)

// Claude Code keeps `total_cost_usd` and `modelUsage` as running totals for a session, across
// resumes, while `usage` is the turn alone. A resumed turn's share is the total minus what the
// session had reported before. `own` is the turn's usage, which a true share can never be below;
// when it is, this CLI counts per turn and the rows already are the turn's.
function share(total: Meter, base: Meter | undefined, own: number[]): Meter | null {
  if (!base) return own.every((n, k) => n === sum(total.rows, k)) ? total : null
  const rows: Record<string, number[]> = {}
  for (const [m, r] of Object.entries(total.rows)) rows[m] = r.map((n, k) => n - (base.rows[m]?.[k] ?? 0))
  // Running totals keep every model the session has used, and never go down.
  const went = Object.keys(base.rows).every((m) => total.rows[m]) && Object.values(rows).every((r) => r.every((n) => n > -1e-9)) && own.every((n, k) => sum(rows, k) >= n)
  return went ? { cost: Math.max(0, total.cost - base.cost), rows } : total
}

// A command-line agent with no structured output: everything it prints is the answer.
export function textOut() {
  const turn = newTurn()
  return {
    turn,
    line: () => null,
    raw: (s: string): Update => {
      const delta = (turn.text ? '\n' : '') + s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      turn.text += delta
      return { delta }
    },
  }
}

export const newTurn = (): Turn => ({ text: '', final: '', acts: [], usage: { input: 0, output: 0, cached: 0, cost: 0 }, denied: [] })

const SHELL_TOOLS = new Set(['Bash', 'run_terminal_command', 'run_shell_command', 'shell', 'exec_command'])
const X_SEARCH = /^(x[ _-]?search:?|x_keyword_search|x_semantic_search|search_x)$/i
const WEB_SEARCH = /^(websearch|web_search|google_web_search|search_web)$/i
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'search_replace', 'write_file', 'replace', 'edit_file', 'create_file'])

const clip = (s: string, n = 4000) => (s.length > n ? '…' + s.slice(-n) : s)

function detail(input: Record<string, unknown> = {}) {
  const v = input.command ?? input.file_path ?? input.path ?? input.target_file ?? input.pattern ?? input.query ?? input.url ?? input.prompt ?? input.description
  return typeof v === 'string' ? v.split('\n')[0].slice(0, 160) : ''
}

function toolText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n')
  return ''
}

export function toAct(name: string, input: Record<string, unknown>, raw: string, failed: boolean): Act {
  let output = raw
  let exit: number | undefined
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw)
      if (typeof j.exit_code === 'number') exit = j.exit_code
      if (typeof j.output_for_prompt === 'string') output = j.output_for_prompt.replace(/^exit: -?\d+\n/, '')
    } catch {}
  }
  if (SHELL_TOOLS.has(name)) {
    const code = output.match(/exit(?:ed with)? code:?\s*(-?\d+)/i)
    return { t: 'cmd', command: String(input.command ?? ''), exit: exit ?? (code ? Number(code[1]) : failed ? 1 : 0), out: clip(output, 1500) }
  }
  // Every CLI names its search differently. Grok only says "X search:" when it starts and puts the
  // query in the result, so the act carries the query from wherever it is.
  if (X_SEARCH.test(name) || WEB_SEARCH.test(name)) {
    let query = detail(input)
    let mode = ''
    try {
      const j = JSON.parse(raw)
      const inner = typeof j.input === 'string' ? JSON.parse(j.input) : j.input ?? {}
      query = inner.query ?? query
      mode = inner.mode ? ` --${String(inner.mode).toLowerCase()}` : ''
    } catch {}
    return { t: 'tool', name: X_SEARCH.test(name) ? 'x_search' : 'web_search', detail: `${query}${mode}`.trim(), ok: !failed }
  }
  if (EDIT_TOOLS.has(name)) return { t: 'edit', path: String(input.file_path ?? input.path ?? input.target_file ?? ''), change: name === 'Write' || name === 'write_file' || name === 'create_file' ? 'write' : 'edit' }
  return { t: 'tool', name, detail: detail(input), ok: !failed }
}

// Claude Code and Grok Build share this shape: system/init, stream_event deltas, assistant and
// user messages carrying tool_use and tool_result, then a result line with usage.
const SUBAGENT = /^(Task|Agent)$/

// A tool call streams its input before it runs, and writing a long file can take minutes. The
// field that names what it works on is read out of the JSON as soon as it is complete.
const FIELD = /"(?:file_path|path|target_file|notebook_path|command|pattern|query|url|description|skill)"\s*:\s*"((?:[^"\\]|\\.)*)"/
function early(json: string) {
  const m = json.match(FIELD)
  if (!m) return ''
  try { return (JSON.parse(`"${m[1]}"`) as string).split('\n')[0].slice(0, 160) } catch { return '' }
}

// base is what the resumed session had reported before this turn; resumed without one means the
// session is older than the count, and only the turn's own usage can be trusted.
export function claudeLike(base?: Meter, resumed = false) {
  const turn = newTurn()
  const pending = new Map<string, { name: string; input: Record<string, unknown> }>()
  const subs = new Map<string, Extract<Act, { t: 'agent' }>>()
  let streamed = false
  let model: string | undefined
  // Written tokens, estimated: Claude Code counts thinking for us; text and tool input are about
  // four characters a token.
  let tokens = 0
  let chars = 0
  let call: { name: string; json: string; shown: string } | null = null
  const count = () => tokens + Math.round(chars / 4)

  // A subagent's own messages carry the id of the call that started it. They never reach the
  // answer; they only move its row along.
  function inside(o: any): Update | null {
    const s = subs.get(o.parent_tool_use_id)
    if (!s || o.type !== 'assistant') return null
    for (const c of o.message?.content ?? []) {
      if (c.type !== 'tool_use') continue
      s.tools++
      s.last = `${c.name} ${detail(c.input)}`.trim().slice(0, 140)
    }
    return { agents: [{ ...s }] }
  }

  function line(o: any): Update | null {
    if (o.parent_tool_use_id) return inside(o)
    switch (o.type) {
      case 'system':
        if (o.subtype === 'init' && o.session_id) turn.session = o.session_id
        if (o.subtype === 'init' && typeof o.model === 'string') turn.model = model = o.model
        if (o.subtype === 'thinking_tokens' && typeof o.estimated_tokens_delta === 'number') {
          tokens += o.estimated_tokens_delta
          return { working: '~Thinking', tokens: count() }
        }
        if (o.subtype === 'status' && o.status === 'requesting') return { working: '~Thinking' }
        if (o.subtype === 'status' && o.status === 'compacting') return { working: '~Compacting the conversation to make room' }
        // The API was busy or dropped the request; Claude Code waits and sends it again.
        if (o.subtype === 'api_retry') return { working: `~Reconnecting${o.max_retries ? `, try ${o.attempt + 1} of ${o.max_retries + 1}` : ''}` }
        return null
      case 'stream_event': {
        const e = o.event ?? {}
        const d = e.delta
        const block = e.content_block
        if (e.type === 'content_block_start' && block?.type === 'thinking') return { working: '~Thinking' }
        if (e.type === 'content_block_start' && block?.type === 'tool_use') {
          call = SUBAGENT.test(block.name) ? null : { name: block.name, json: '', shown: '' }
          return call ? { working: block.name } : null
        }
        if (e.type === 'content_block_delta' && d?.type === 'input_json_delta' && d.partial_json) {
          chars += d.partial_json.length
          if (!call) return { tokens: count() }
          call.json += d.partial_json
          if (!call.shown) call.shown = early(call.json)
          return { working: `${call.name} ${call.shown}`.trim(), tokens: count() }
        }
        if (e.type === 'content_block_stop') call = null
        // A turn that writes, uses a tool, then writes again: keep the parts as paragraphs.
        if (e.type === 'content_block_start' && block?.type === 'text') {
          if (turn.text.trim() && !turn.text.endsWith('\n\n')) {
            turn.text += '\n\n'
            return { delta: '\n\n', working: '' }
          }
          return { working: '' }
        }
        if (e.type === 'content_block_delta' && d?.type === 'text_delta' && d.text) {
          streamed = true
          chars += d.text.length
          turn.text += d.text
          return { delta: d.text, tokens: count() }
        }
        return null
      }
      case 'assistant': {
        const used = o.message?.usage
        if (used && typeof used.cache_read_input_tokens === 'number') {
          turn.last = { read: used.cache_read_input_tokens, written: used.cache_creation_input_tokens ?? 0 }
          turn.first ??= turn.last
        }
        let delta = ''
        for (const c of o.message?.content ?? []) {
          if (c.type === 'text' && !streamed && c.text) delta += c.text
          if (c.type === 'tool_use') pending.set(c.id, { name: c.name, input: c.input ?? {} })
          if (c.type === 'tool_use' && SUBAGENT.test(c.name)) {
            const i = c.input ?? {}
            const task = String(i.description || String(i.prompt ?? '').split('\n')[0] || 'Subagent').slice(0, 140)
            subs.set(c.id, { t: 'agent', id: c.id, task, kind: i.subagent_type || undefined, model: i.model || undefined, state: 'running', tools: 0, started: Date.now() })
          }
        }
        streamed = false
        const started = [...subs.values()].filter((s) => s.state === 'running' && s.tools === 0).map((s) => ({ ...s }))
        const tool = [...pending.values()].filter((t) => !SUBAGENT.test(t.name)).pop()
        const working = tool ? `${tool.name} ${detail(tool.input)}`.trim() : undefined
        if (delta) turn.text += delta
        return delta || working || started.length ? { delta: delta || undefined, working, agents: started.length ? started : undefined } : null
      }
      case 'user': {
        const acts: Act[] = []
        const ended: Extract<Act, { t: 'agent' }>[] = []
        for (const c of o.message?.content ?? []) {
          if (c.type !== 'tool_result') continue
          const call = pending.get(c.tool_use_id)
          if (!call) continue
          pending.delete(c.tool_use_id)
          const s = subs.get(c.tool_use_id)
          if (s) {
            s.state = c.is_error ? 'failed' : 'done'
            s.ms = Date.now() - s.started
            s.last = undefined
            s.note = toolText(c.content).replace(/\s+/g, ' ').trim().slice(0, 200) || undefined
            ended.push({ ...s })
            turn.acts.push({ ...s })
            continue
          }
          acts.push(toAct(call.name, call.input, toolText(c.content) || toolText(o.tool_use_result?.stdout), !!c.is_error))
        }
        turn.acts.push(...acts)
        return acts.length || ended.length ? { acts: acts.length ? acts : undefined, agents: ended.length ? ended : undefined } : null
      }
      case 'result': {
        const u = o.usage ?? {}
        const own = [u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0, u.cache_creation?.ephemeral_1h_input_tokens ?? 0]
        const models: [string, any][] = Object.entries(o.modelUsage ?? {})
        const total: Meter = {
          cost: o.total_cost_usd ?? models.reduce((n, [, m]) => n + (m.costUSD ?? 0), 0),
          rows: Object.fromEntries(models.map(([m, r]) => [m, [r.inputTokens ?? 0, r.outputTokens ?? 0, r.cacheReadInputTokens ?? 0, r.cacheCreationInputTokens ?? 0, r.cacheCreationEphemeral1hInputTokens ?? 0, r.costUSD ?? 0]])),
        }
        if (models.length) turn.meter = total
        const counted = !models.length ? null : !resumed ? total : share(total, base, own)
        // Without per model rows, or on a session resumed without a count, the turn's own usage
        // is priced at the model the session started with.
        const mine = counted ?? {
          cost: !resumed && o.total_cost_usd !== undefined ? total.cost : claudeCost(model ?? '', { input: own[0], output: own[1], read: own[2], short: own[3] - own[4], hour: own[4] }) ?? 0,
          rows: { [model ?? '']: own },
        }
        const written = sum(mine.rows, 3)
        const { quick, ...saved } = claudeSaved(mine.rows)
        turn.quick = quick
        turn.usage = { input: sum(mine.rows, 0) + written, output: sum(mine.rows, 1), cached: sum(mine.rows, 2), cost: mine.cost, written, ...saved, v: 2 }
        // Claude Code says how long it asked for what it cached this turn to be kept.
        if (own[3] > 0 && u.cache_creation) turn.usage.ttl = own[3] > own[4] ? 300 : 3600
        if (typeof o.result === 'string') turn.final = o.result
        if (o.session_id) turn.session = o.session_id
        if (o.is_error) turn.error = typeof o.result === 'string' && o.result ? o.result : o.subtype || 'The agent stopped with an error'
        for (const d of o.permission_denials ?? []) turn.denied.push(d.tool_name + (d.tool_input?.command ? `(${String(d.tool_input.command).split(' ').slice(0, 2).join(' ')}:*)` : ''))
        return null
      }
    }
    return null
  }
  return { turn, line }
}

const unwrap = (cmd: string) => cmd.match(/^\S*(?:zsh|bash|sh)\s+-l?c\s+'([\s\S]*)'$/)?.[1]?.replace(/'\\''/g, "'") ?? cmd

// Codex prints thread and item lifecycle events. Warnings arrive as items of type "error", which
// do not end the turn; only turn.failed and top level errors do.
// Codex counts a thread's tokens as running totals, across resumes; base and resumed as above.
export function codex(model = '', base?: Meter, resumed = false) {
  const turn = newTurn()
  function line(o: any): Update | null {
    switch (o.type) {
      case 'thread.started':
        turn.session = o.thread_id
        return null
      case 'item.started':
        if (o.item?.type === 'command_execution') return { working: `$ ${unwrap(o.item.command)}` }
        return null
      case 'item.completed': {
        const it = o.item ?? {}
        if (it.type === 'agent_message' && it.text) {
          const delta = (turn.text ? '\n\n' : '') + it.text
          turn.text += delta
          turn.final = it.text
          return { delta }
        }
        // Codex sums up its reasoning as it goes, headed with a short bold title.
        if (it.type === 'reasoning' && it.text) {
          const head = (String(it.text).match(/\*\*(.+?)\*\*/)?.[1] ?? String(it.text).split('\n')[0]).replace(/[*_`]/g, '').trim().slice(0, 90)
          return head ? { working: `~${head}` } : null
        }
        const acts: Act[] = []
        if (it.type === 'command_execution') acts.push({ t: 'cmd', command: unwrap(it.command ?? ''), exit: it.exit_code ?? null, out: clip(it.aggregated_output ?? '', 1500) })
        if (it.type === 'file_change') for (const c of it.changes ?? []) acts.push({ t: 'edit', path: c.path, change: c.kind ?? 'edit' })
        if (it.type === 'web_search' || it.type === 'mcp_tool_call') acts.push({ t: 'tool', name: it.type === 'web_search' ? 'web_search' : `${it.server}.${it.tool}`, detail: it.query ?? '', ok: it.status !== 'failed' })
        if (acts.length) {
          turn.acts.push(...acts)
          return { acts }
        }
        return null
      }
      case 'turn.completed': {
        const u = o.usage ?? {}
        const total = [u.input_tokens ?? 0, u.cached_input_tokens ?? 0, (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0)]
        turn.meter = { cost: 0, rows: { [model]: total } }
        const before = base && Object.values(base.rows)[0]
        const since = before && total.map((n, k) => n - (before[k] ?? 0))
        // A resumed thread with no count to take away is left out, never counted whole.
        const [all, cached, output] = since?.every((n) => n >= 0) ? since : resumed && !before ? [0, 0, 0] : total
        const saved = codexSaving(model, cached)
        turn.usage = { input: all - cached, output, cached, cost: 0, saved, gross: saved, v: 2 }
        return null
      }
      case 'turn.failed':
        turn.error = o.error?.message ?? 'Codex stopped'
        return null
      case 'error':
        turn.error = o.message ?? 'Codex stopped'
        return null
    }
    return null
  }
  return { turn, line }
}

// Gemini CLI headless stream-json: init, message deltas, tool_use / tool_result pairs, result.
export function gemini() {
  const turn = newTurn()
  const pending = new Map<string, { name: string; input: Record<string, unknown> }>()
  function line(o: any): Update | null {
    switch (o.type) {
      case 'init':
        return null
      case 'message':
        if (o.role === 'assistant' && o.content) {
          turn.text += o.content
          return { delta: o.content }
        }
        return null
      case 'tool_use':
        pending.set(o.tool_id, { name: o.tool_name, input: o.parameters ?? {} })
        return { working: `${o.tool_name} ${detail(o.parameters)}`.trim() }
      case 'tool_result': {
        const call = pending.get(o.tool_id)
        if (!call) return null
        pending.delete(o.tool_id)
        const act = toAct(call.name, call.input, toolText(o.output ?? o.error?.message ?? ''), o.status !== 'success')
        turn.acts.push(act)
        return { acts: [act] }
      }
      case 'error':
        if (o.severity !== 'warning') turn.error = o.message
        return null
      case 'result': {
        const s = o.stats ?? {}
        // input_tokens counts the cached part too; `input` is what was billed in full.
        const cached = s.cached ?? s.cached_tokens ?? 0
        turn.usage = { input: s.input ?? Math.max(0, (s.input_tokens ?? 0) - cached), output: s.output_tokens ?? 0, cached, cost: 0 }
        if (o.status && o.status !== 'success') turn.error ??= o.error?.message ?? 'Gemini stopped'
        return null
      }
    }
    return null
  }
  return { turn, line }
}

// Limits read differently in every CLI. Anything that says the plan or quota is used up counts,
// and a reset time is kept when one is given.
export function limitOf(text: string): { until: number } | null {
  if (!/usage limit|rate.?limit|limit reached|hit your limit|quota|too many requests|\b429\b|credit balance|out of credits|resets? (at|in)/i.test(text)) return null
  const epoch = text.match(/\|(\d{10})\b/)
  if (epoch) return { until: Number(epoch[1]) * 1000 }
  // The unit must end where it ends: "in 349ms" is not 349 minutes, and "in 20s" is not an hour.
  const wait = text.match(/(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)(?![a-z])/i)
  if (wait) {
    const unit = wait[2].toLowerCase()
    return { until: Date.now() + Number(wait[1]) * (/^(ms|mil)/.test(unit) ? 1 : unit[0] === 's' ? 1e3 : unit[0] === 'h' ? 3600e3 : 60e3) }
  }
  const at = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (at) {
    const d = new Date()
    let h = Number(at[1])
    const half = at[3]?.toLowerCase()
    if (half === 'pm' && h < 12) h += 12
    if (half === 'am' && h === 12) h = 0
    d.setHours(h, Number(at[2] ?? 0), 0, 0)
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1)
    return { until: d.getTime() }
  }
  // A request rate limit with no time given clears in about a minute; a used up plan does not.
  if (/rate.?limit|too many requests|\b429\b/i.test(text) && !/usage limit|hit your limit|quota|credit/i.test(text)) return { until: Date.now() + 60e3 }
  return { until: Date.now() + 3600e3 }
}

// Terminal colours, with or without the escape character that some consoles drop.
const uncolor = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\[\d{1,3}(;\d{1,3})*m/g, '')

// Turn a wall of stderr into the one line a person needs.
export function reason(stderr: string) {
  const lines = uncolor(stderr).split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !/^at\s|node:internal|^\s*\^/.test(l))
  const hit = lines.find((l) => /not supported|no longer supported|migrate|sign ?in|log ?in|auth|api key|quota|limit|not found|permission|denied|error/i.test(l))
  return plain((hit ?? lines.pop() ?? '').replace(/^(error|fatal):\s*/i, '')).slice(0, 300)
}

// CLIs often pass the provider's JSON error straight through. Keep the sentence a person needs.
export function plain(text: string) {
  text = uncolor(text)
  const start = text.indexOf('{')
  let message = text
  if (start >= 0) {
    try {
      const o = JSON.parse(text.slice(start))
      message = o.error?.message ?? o.message ?? (typeof o.error === 'string' ? o.error : text)
    } catch {}
  }
  const model = message.match(/['"`]([\w.:-]+)['"`] model is not supported when using Codex with a ChatGPT account/)
  if (model) return `its model ${model[1]} is not available on a ChatGPT plan. Pick another model for Codex in Agents, or change model in ~/.codex/config.toml`
  return message.replace(/\s+/g, ' ').trim()
}
