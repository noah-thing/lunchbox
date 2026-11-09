import { createReadStream, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { claudeValue, codexCredits } from '../shared/prices'

// Every token a CLI used on this machine, from its own logs, bucketed by hour. Together with the
// percentage a provider reports for a window, this gives the size of the window: tokens used in
// it divided by the share used. Logs are read once and then only from where the last read ended.

// units is what the provider spends a plan in: dollars at list price for Claude, credits for Codex.
export type Bucket = { all: number; fresh: number; units: number }
// Codex also records the plan's own percentages with each call, so past windows can be measured.
export type Snap = { at: number; id: string; used: number; start: number }
type FileState = { size: number; hours: Record<string, Bucket>; keys: string[]; snaps?: Snap[]; model?: string }
export type Tally = { v?: number; files: Record<string, FileState> }

const HOUR = 3600e3
const hourOf = (t: number) => String(Math.floor(t / HOUR) * HOUR)

function files(root: string, since: number) {
  const out: string[] = []
  const walk = (dir: string) => {
    let names: string[] = []
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      const p = join(dir, name)
      let s
      try { s = statSync(p) } catch { continue }
      if (s.isDirectory()) walk(p)
      else if (name.endsWith('.jsonl') && s.mtimeMs >= since) out.push(p)
    }
  }
  walk(root)
  return out
}

type Row = { at: number; key?: string; all: number; fresh: number; units: number; snaps?: Snap[] }
type Reader = { root: () => string; match: RegExp; read: (o: any, ctx: { model?: string }) => Row | null }

const READERS: Record<string, Reader> = {
  // Claude Code writes one line per assistant message, sometimes more than once while it streams.
  claude: {
    root: () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects'),
    match: /"usage"/,
    read(o) {
      const u = o?.message?.usage
      if (o?.type !== 'assistant' || !u || !o.timestamp) return null
      const fresh = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
      const hour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
      const units = claudeValue(String(o.message.model ?? ''), { input: u.input_tokens ?? 0, read: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0, short: Math.max(0, (u.cache_creation_input_tokens ?? 0) - hour), hour })
      return { at: Date.parse(o.timestamp), key: `${o.message.id}:${o.requestId ?? ''}`, fresh, all: fresh + (u.cache_read_input_tokens ?? 0), units }
    },
  },
  // Codex writes a token_count event after every model call with what that call used.
  codex: {
    root: () => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'),
    match: /"token_count"|"turn_context"/,
    read(o, ctx) {
      if (o?.type === 'turn_context') { ctx.model = o.payload?.model ?? ctx.model; return null }
      const u = o?.payload?.info?.last_token_usage
      if (!u || !o.timestamp) return null
      const all = (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
      const at = Date.parse(o.timestamp)
      const r = o.payload?.rate_limits
      const snap = (w: { used_percent?: number; window_minutes?: number; resets_at?: number } | undefined, id: string) =>
        w?.resets_at && w.window_minutes ? { at, id, used: (w.used_percent ?? 0) / 100, start: w.resets_at * 1000 - w.window_minutes * 60e3 } : null
      const snaps = r ? [snap(r.primary, r.primary?.window_minutes >= 6 * 1440 ? 'week' : '5h'), snap(r.secondary, 'week')].filter((x): x is Snap => !!x) : []
      const cached = u.cached_input_tokens ?? 0
      const units = codexCredits(ctx.model ?? '', { fresh: (u.input_tokens ?? 0) - cached, cached, output: u.output_tokens ?? 0 })
      return { at, all, fresh: all - cached, units, snaps }
    },
  },
}

export const tallied = (agent: string) => !!READERS[agent]

export async function update(agent: string, state: Tally, since: number) {
  const r = READERS[agent]
  if (!r) return state
  for (const path of files(r.root(), since)) {
    let size = 0
    try { size = statSync(path).size } catch { continue }
    const prev = state.files[path] ?? { size: 0, hours: {}, keys: [] }
    if (size === prev.size) continue
    const start = size < prev.size ? 0 : prev.size
    const hours = start ? prev.hours : {}
    const keys = new Set(start ? prev.keys : [])
    const snaps = start ? [...(prev.snaps ?? [])] : []
    const ctx = { model: start ? prev.model : undefined }
    let read = start
    const lines = createInterface({ input: createReadStream(path, { start }), crlfDelay: Infinity })
    for await (const line of lines) {
      read += Buffer.byteLength(line) + 1
      if (!r.match.test(line)) continue
      let row
      try { row = r.read(JSON.parse(line), ctx) } catch { continue }
      if (!row || !Number.isFinite(row.at)) continue
      if (row.key) {
        if (keys.has(row.key)) continue
        keys.add(row.key)
      }
      if (row.snaps?.length) snaps.push(...row.snaps)
      const b = (hours[hourOf(row.at)] ??= { all: 0, fresh: 0, units: 0 })
      b.all += row.all
      b.fresh += row.fresh
      b.units = (b.units ?? 0) + row.units
    }
    // A half written last line is read again next time rather than lost.
    state.files[path] = { size: Math.min(read, size), hours, keys: [...keys].slice(-200), snaps: thin(snaps), model: ctx.model }
  }
  for (const [path, f] of Object.entries(state.files)) {
    if (!Object.keys(f.hours).some((h) => Number(h) >= since - HOUR)) delete state.files[path]
  }
  return state
}

// The last reading of each window in a file is the one that holds the most of it.
function thin(snaps: Snap[]) {
  const last = new Map<string, Snap>()
  for (const s of snaps) last.set(`${s.id}:${s.start}`, s)
  return [...last.values()].slice(-40)
}

export const snapshots = (state: Tally) => Object.values(state.files).flatMap((f) => f.snaps ?? [])

// Tokens used from `from` until `to`. Window edges rarely fall on an hour, so edge hours count
// in proportion.
export function used(state: Tally, from: number, to = Date.now()): Bucket {
  const out = { all: 0, fresh: 0, units: 0 }
  for (const f of Object.values(state.files)) {
    for (const [h, b] of Object.entries(f.hours)) {
      const start = Number(h)
      if (start + HOUR <= from || start >= to) continue
      // Until now means everything logged so far, including this hour; a past reading cuts its hour.
      const end = to >= Date.now() - 1000 ? start + HOUR : Math.min(start + HOUR, to)
      const share = (end - Math.max(start, from)) / HOUR
      out.all += b.all * share
      out.fresh += b.fresh * share
      out.units += (b.units ?? 0) * share
    }
  }
  return out
}
