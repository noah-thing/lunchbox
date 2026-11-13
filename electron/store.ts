import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { codexSaving, costSaving } from '../shared/prices'
import { score } from '../shared/route'
import type { Category, Event, Flow, Ledger, Ratings, RoomMeta, Settings, Skill, Spent, Usage } from '../shared/types'

export type Cipher = { seal(text: string): string; open(sealed: string): string }

const DAYS = 14
// The ledger file keeps a little over a year; only the last DAYS are read into memory.
const LEDGER_DAYS = 400
// Logs read only for search are kept for this many rooms, so a search does not hold every log.
const COLD = 30
const RETRY = 5000

const DEFAULTS: Settings = { models: {}, budgets: {}, disabled: [], notify: true, defaultCrew: [] }
const zero = (): Usage => ({ input: 0, output: 0, cached: 0, cost: 0 })

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return fallback }
}

function writeJson(file: string, value: unknown, mode?: number) {
  writeText(file, JSON.stringify(value, null, 1), mode)
}

// mode keeps a file to this account alone, for the keys.
function writeText(file: string, text: string, mode?: number) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text, mode ? { mode } : undefined)
  // On Windows a virus scanner or the indexer can hold the target open for a moment.
  for (let i = 1; ; i++) {
    try {
      renameSync(tmp, file)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        rmSync(tmp, { force: true })
        throw e
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * i)
    }
  }
}

// The room list is the one file whose loss loses everything, so each good write is also kept as
// a backup. A file that does not parse is set aside before anything can overwrite it.
export function readRooms(dir: string): RoomMeta[] {
  const file = join(dir, 'rooms.json')
  if (!existsSync(file)) return readJson<RoomMeta[]>(`${file}.bak`, [])
  try {
    const list = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(list)) return list
  } catch {}
  try { copyFileSync(file, join(dir, `rooms.json.unreadable-${Date.now()}`)) } catch {}
  return readJson<RoomMeta[]>(`${file}.bak`, [])
}

// Before 0.1.6 a resumed Claude Code turn was recorded with its session's running cost and
// savings, and a resumed Codex turn with running totals of everything, so each turn counted the
// ones before it again. Files stay as written; what is read from them is each turn's own share.
// A row continues the one before when nothing in it went down, so a new session that happens to
// look like a continuation is counted low, never high.
export function turnsOnly() {
  const last = new Map<string, Usage>()
  return (agent: string, key: string, u: Usage): Usage => {
    if (u.v === 2 || (agent !== 'claude' && agent !== 'codex')) return u
    const prev = last.get(`${key}:${agent}`)
    last.set(`${key}:${agent}`, u)
    if (!prev || prev.v === 2 || (u.gross ?? 0) < (prev.gross ?? 0)) return u
    const less = (a?: number, b?: number) => (a === undefined ? undefined : a - (b ?? 0))
    const money = { saved: less(u.saved, prev.saved), gross: less(u.gross, prev.gross) }
    if (agent === 'claude') return u.cost < prev.cost ? u : { ...u, cost: u.cost - prev.cost, ...money }
    if (u.input < prev.input || u.output < prev.output || u.cached < prev.cached) return u
    return { ...u, input: u.input - prev.input, output: u.output - prev.output, cached: u.cached - prev.cached, ...money }
  }
}

// One bad line, say from a crash halfway through a write, costs that row and nothing after it.
export function readLedger(file: string, since: number) {
  const rows: { at: number; agent: string; room: string; usage: Usage }[] = []
  const own = turnsOnly()
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return rows }
  const keep = Date.now() - LEDGER_DAYS * 86400e3
  const kept: string[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (!row || typeof row.at !== 'number' || !row.usage) continue
    if (row.at >= keep) kept.push(line)
    row.usage = own(row.agent, row.room, row.usage)
    if (row.at >= since) rows.push(row)
  }
  // Old and unreadable rows are dropped from the file too, once per start.
  if (kept.length < text.split('\n').filter(Boolean).length) {
    try { writeText(file, kept.map((l) => l + '\n').join('')) } catch {}
  }
  return rows
}

export function addUsage(a: Usage, b: Partial<Usage>) {
  a.input += b.input ?? 0
  a.output += b.output ?? 0
  a.cached += b.cached ?? 0
  a.cost += b.cost ?? 0
  if (b.written) a.written = (a.written ?? 0) + b.written
  if (b.saved) a.saved = (a.saved ?? 0) + b.saved
  if (b.gross) a.gross = (a.gross ?? 0) + b.gross
  if (b.kept) a.kept = (a.kept ?? 0) + b.kept
  if (b.premium) a.premium = (a.premium ?? 0) + b.premium
  if (b.cut) a.cut = (a.cut ?? 0) + b.cut
  if (b.held) a.held = (a.held ?? 0) + b.held
  if (b.spared) a.spared = (a.spared ?? 0) + b.spared
  if (b.trimmed) a.trimmed = (a.trimmed ?? 0) + b.trimmed
  if (b.warmed) a.warmed = (a.warmed ?? 0) + b.warmed
  if (b.pings) a.pings = (a.pings ?? 0) + b.pings
  return a
}

export class Store {
  private rooms = new Map<string, RoomMeta>()
  private logs = new Map<string, Event[]>()
  private cold = new Map<string, Event[]>()
  // Lines that could not be written yet, a full disk say, in order, per room or for the ledger.
  private pending = new Map<string, string>()
  private dirty = new Set<string>()
  private flushTimer: NodeJS.Timeout | null = null
  settings: Settings
  spent: Record<string, Spent>
  calib: Record<string, { at: number; pct: number; units: number; start: number }[]>
  health: Record<string, string>
  // How long each agent asks for its cache to be kept when Lunchbox leaves it alone, in seconds.
  lifetimes: Record<string, number>
  skills: Skill[]
  flows: Flow[]
  private ledger: { at: number; agent: string; room: string; usage: Usage }[] = []
  private arena: Record<string, number>
  ratings: Ratings

  constructor(readonly dir: string, private cipher: Cipher) {
    mkdirSync(join(dir, 'rooms'), { recursive: true })
    mkdirSync(join(dir, 'packs'), { recursive: true })
    for (const meta of readRooms(dir)) this.rooms.set(meta.id, meta)
    this.settings = { ...DEFAULTS, ...readJson<Partial<Settings>>(join(dir, 'settings.json'), {}) }
    const state = readJson<{ calib?: Record<string, { at: number; pct: number; units: number; start: number }[]>; spent?: Record<string, Spent>; health?: Record<string, string>; arena?: Record<string, number>; ratings?: Ratings; lifetimes?: Record<string, number> }>(join(dir, 'state.json'), {})
    this.spent = state.spent ?? {}
    // Older builds stored a different shape here; only lists are kept.
    this.calib = Object.fromEntries(Object.entries(state.calib ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.filter((r) => r && 'start' in r) : []]))
    this.health = state.health ?? {}
    this.lifetimes = state.lifetimes ?? {}
    this.arena = state.arena ?? {}
    this.ratings = state.ratings ?? {}
    this.skills = readJson<Skill[]>(join(dir, 'skills.json'), [])
    this.flows = readJson<Flow[]>(join(dir, 'flows.json'), [])
    this.ledger = readLedger(join(dir, 'ledger.jsonl'), Date.now() - DAYS * 86400e3)
  }

  list() {
    return [...this.rooms.values()].sort((a, b) => b.updated - a.updated)
  }

  room(id: string) {
    return this.rooms.get(id)
  }

  events(id: string) {
    let log = this.logs.get(id)
    if (log) return log
    log = this.cold.get(id) ?? this.load(id)
    this.cold.delete(id)
    this.logs.set(id, log)
    return log
  }

  // The log for reading only, as search does: rooms nobody has open are not all kept in memory.
  peek(id: string) {
    const log = this.logs.get(id) ?? this.cold.get(id) ?? this.load(id)
    if (!this.logs.has(id)) {
      this.cold.delete(id)
      this.cold.set(id, log)
      if (this.cold.size > COLD) this.cold.delete(this.cold.keys().next().value!)
    }
    return log
  }

  // A room's file, named by its id. An id is letters and digits; anything else, a path among
  // them, names no room.
  private file(id: string) {
    if (!/^[\w-]{1,64}$/.test(String(id))) throw new Error('No such room')
    return join(this.dir, 'rooms', `${id}.jsonl`)
  }

  private load(id: string) {
    const log: Event[] = []
    const own = turnsOnly()
    try {
      const text = readFileSync(this.file(id), 'utf8')
      // A crash in the middle of a write leaves a last line without its end. The next event
      // would be glued onto it and both lost, so the line is closed first.
      if (text && !text.endsWith('\n')) try { appendFileSync(this.file(id), '\n') } catch {}
      text.split('\n').forEach((line, i) => {
        if (!line) return
        // A line that does not parse keeps its place, since agents' heard marks count lines.
        try {
          const e: Event = JSON.parse(line)
          if (e.kind === 'say' && e.usage) e.usage = own(e.who, '', e.usage)
          if (e.kind === 'hands' && e.usage) e.usage = own(e.to, '', e.usage)
          log.push(e)
        } catch { log.push({ kind: 'note', id: `unreadable-${i}`, at: 0, text: 'A line of this room could not be read.', tone: 'warn' }) }
      })
    } catch {}
    return log
  }

  create(meta: RoomMeta, events: Event[] = []) {
    this.rooms.set(meta.id, meta)
    this.logs.set(meta.id, [...events])
    if (events.length) writeFileSync(join(this.dir, 'rooms', `${meta.id}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
    this.touch(meta.id)
  }

  append(id: string, event: Event) {
    // A turn still finishing in a deleted room must not bring its log back.
    const meta = this.rooms.get(id)
    if (!meta) return
    this.events(id).push(event)
    this.write(this.file(id), JSON.stringify(event) + '\n')
    meta.updated = event.at
    this.touch(id)
  }

  // Appends a line, after any earlier lines for the same file that failed. A failure keeps the
  // line for the next try instead of throwing into whoever was adding an event.
  private write(file: string, line: string) {
    const text = (this.pending.get(file) ?? '') + line
    try {
      appendFileSync(file, text)
      this.pending.delete(file)
    } catch (e) {
      if (!existsSync(dirname(file))) return
      this.pending.set(file, text)
      console.error(`Could not write ${file}: ${(e as Error).message}`)
      this.flushTimer ??= setTimeout(() => this.flush(), RETRY)
    }
  }

  update(id: string, change: (meta: RoomMeta) => void) {
    const meta = this.rooms.get(id)
    if (!meta) return
    change(meta)
    this.touch(id)
  }

  remove(id: string) {
    this.rooms.delete(id)
    this.logs.delete(id)
    this.cold.delete(id)
    const file = this.file(id)
    this.pending.delete(file)
    rmSync(file, { force: true })
    this.touch(id)
  }

  private touch(id: string) {
    this.dirty.add(id)
    this.flushTimer ??= setTimeout(() => this.flush(), 250)
  }

  // Runs from a timer, so it never throws: what could not be written stays marked and is tried
  // again a little later.
  flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    for (const [file, text] of [...this.pending]) {
      this.pending.delete(file)
      this.write(file, text)
    }
    if (!this.dirty.size) return
    const done = [...this.dirty]
    try {
      const text = JSON.stringify([...this.rooms.values()], null, 1)
      writeText(join(this.dir, 'rooms.json'), text)
      for (const id of done) this.dirty.delete(id)
      try { writeText(join(this.dir, 'rooms.json.bak'), text) } catch {}
    } catch (e) {
      console.error(`Could not save the room list: ${(e as Error).message}`)
      this.flushTimer ??= setTimeout(() => this.flush(), RETRY)
    }
  }

  saveSettings(patch: Partial<Settings>) {
    Object.assign(this.settings, patch)
    writeJson(join(this.dir, 'settings.json'), this.settings)
  }

  saveState() {
    writeJson(join(this.dir, 'state.json'), { spent: this.spent, health: this.health, arena: this.arena, ratings: this.ratings, calib: this.calib, lifetimes: this.lifetimes })
  }

  saveSkills() {
    writeJson(join(this.dir, 'skills.json'), this.skills)
  }

  saveFlows() {
    writeJson(join(this.dir, 'flows.json'), this.flows)
  }

  keys(): Record<string, string> {
    const sealed = readJson<Record<string, string>>(join(this.dir, 'keys.json'), {})
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(sealed)) {
      try { out[k] = this.cipher.open(v) } catch {}
    }
    return out
  }

  setKey(provider: string, key: string) {
    const sealed = readJson<Record<string, string>>(join(this.dir, 'keys.json'), {})
    if (key) sealed[provider] = this.cipher.seal(key)
    else delete sealed[provider]
    writeJson(join(this.dir, 'keys.json'), sealed, 0o600)
  }

  record(agent: string, room: string, usage: Usage) {
    const row = { at: Date.now(), agent, room, usage }
    this.ledger.push(row)
    this.write(join(this.dir, 'ledger.jsonl'), JSON.stringify(row) + '\n')
  }

  win(agent: string, cat: Category, losers: string[]) {
    this.arena[agent] = (this.arena[agent] ?? 0) + 1
    this.ratings = score(this.ratings, cat, agent, losers)
    this.saveState()
  }

  totals(): Ledger {
    const day = new Date()
    day.setHours(0, 0, 0, 0)
    const week = Date.now() - 7 * 86400e3
    const days = Array.from({ length: DAYS }, (_, i) => {
      const d = new Date(day.getTime() - (DAYS - 1 - i) * 86400e3)
      return { day: localDay(d), start: d.getTime(), cost: 0, tokens: 0, input: 0, cached: 0, saved: 0, gross: 0, kept: 0, cut: 0, held: 0, spared: 0, trimmed: 0, warmed: 0, pings: 0 }
    })
    const out: Ledger = { today: {}, week: {}, arena: { ...this.arena }, ratings: this.ratings, days: [], rooms: {} }
    for (const raw of this.ledger) {
      // Rows from before Lunchbox priced a saving get one from what the agent reported.
      const priced = raw.usage.gross === undefined ? { ...raw, usage: { ...raw.usage, gross: (raw.agent === 'codex' ? codexSaving('', raw.usage.cached) : costSaving(raw.agent, raw.usage)) ?? undefined } } : raw
      // The cost of storing the cache is the gap between what the reads saved and the net, and is
      // only known where the agent reported both. A saving worked back from a cost has no net.
      const u = priced.usage
      const row = u.gross !== undefined && u.saved !== undefined && u.gross > u.saved ? { ...priced, usage: { ...u, premium: u.gross - u.saved } } : priced
      if (row.at >= week) {
        addUsage((out.week[row.agent] ??= zero()), row.usage)
        addUsage((out.rooms[row.room] ??= zero()), row.usage)
      }
      if (row.at >= day.getTime()) addUsage((out.today[row.agent] ??= zero()), row.usage)
      const slot = days.findLast((d) => row.at >= d.start)
      if (slot) {
        slot.cost += row.usage.cost
        slot.tokens += row.usage.input + row.usage.output + row.usage.cached
        slot.input += row.usage.input
        slot.cached += row.usage.cached
        slot.saved += row.usage.saved ?? 0
        slot.gross += row.usage.gross ?? Math.max(0, row.usage.saved ?? 0)
        slot.kept += row.usage.kept ?? 0
        slot.cut += row.usage.cut ?? 0
        slot.held += row.usage.held ?? 0
        slot.spared += row.usage.spared ?? 0
        slot.trimmed += row.usage.trimmed ?? 0
        slot.warmed += row.usage.warmed ?? 0
        slot.pings += row.usage.pings ?? 0
      }
    }
    out.days = days.map(({ start: _, ...d }) => d)
    return out
  }

  packFiles() {
    const dir = join(this.dir, 'packs')
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f))
  }
}

// The calendar date where the user is, not in UTC: local midnight in Stockholm is the day before in UTC.
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
