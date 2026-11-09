import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { score } from '../shared/route'
import type { Category, Event, Flow, Ledger, Ratings, RoomMeta, Settings, Skill, Spent, Usage } from '../shared/types'

export type Cipher = { seal(text: string): string; open(sealed: string): string }

const DAYS = 14

const DEFAULTS: Settings = { models: {}, budgets: {}, disabled: [], notify: true, defaultCrew: [] }
const zero = (): Usage => ({ input: 0, output: 0, cached: 0, cost: 0 })

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return fallback }
}

function writeJson(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 1))
  renameSync(tmp, file)
}

export function addUsage(a: Usage, b: Partial<Usage>) {
  a.input += b.input ?? 0
  a.output += b.output ?? 0
  a.cached += b.cached ?? 0
  a.cost += b.cost ?? 0
  if (b.written) a.written = (a.written ?? 0) + b.written
  if (b.saved) a.saved = (a.saved ?? 0) + b.saved
  if (b.kept) a.kept = (a.kept ?? 0) + b.kept
  return a
}

export class Store {
  private rooms = new Map<string, RoomMeta>()
  private logs = new Map<string, Event[]>()
  private dirty = new Set<string>()
  private flushTimer: NodeJS.Timeout | null = null
  settings: Settings
  spent: Record<string, Spent>
  calib: Record<string, { at: number; pct: number; units: number; start: number }[]>
  health: Record<string, string>
  skills: Skill[]
  flows: Flow[]
  private ledger: { at: number; agent: string; room: string; usage: Usage }[] = []
  private arena: Record<string, number>
  ratings: Ratings

  constructor(readonly dir: string, private cipher: Cipher) {
    mkdirSync(join(dir, 'rooms'), { recursive: true })
    mkdirSync(join(dir, 'packs'), { recursive: true })
    for (const meta of readJson<RoomMeta[]>(join(dir, 'rooms.json'), [])) this.rooms.set(meta.id, meta)
    this.settings = { ...DEFAULTS, ...readJson<Partial<Settings>>(join(dir, 'settings.json'), {}) }
    const state = readJson<{ calib?: Record<string, { at: number; pct: number; units: number; start: number }[]>; spent?: Record<string, Spent>; health?: Record<string, string>; arena?: Record<string, number>; ratings?: Ratings }>(join(dir, 'state.json'), {})
    this.spent = state.spent ?? {}
    // Older builds stored a different shape here; only lists are kept.
    this.calib = Object.fromEntries(Object.entries(state.calib ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.filter((r) => r && 'start' in r) : []]))
    this.health = state.health ?? {}
    this.arena = state.arena ?? {}
    this.ratings = state.ratings ?? {}
    this.skills = readJson<Skill[]>(join(dir, 'skills.json'), [])
    this.flows = readJson<Flow[]>(join(dir, 'flows.json'), [])
    const since = Date.now() - DAYS * 86400e3
    try {
      for (const line of readFileSync(join(dir, 'ledger.jsonl'), 'utf8').split('\n')) {
        if (!line) continue
        const row = JSON.parse(line)
        if (row.at >= since) this.ledger.push(row)
      }
    } catch {}
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
    log = []
    try {
      for (const line of readFileSync(join(this.dir, 'rooms', `${id}.jsonl`), 'utf8').split('\n')) {
        if (!line) continue
        try { log.push(JSON.parse(line)) } catch {}
      }
    } catch {}
    this.logs.set(id, log)
    return log
  }

  create(meta: RoomMeta, events: Event[] = []) {
    this.rooms.set(meta.id, meta)
    this.logs.set(meta.id, [...events])
    if (events.length) writeFileSync(join(this.dir, 'rooms', `${meta.id}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
    this.touch(meta.id)
  }

  append(id: string, event: Event) {
    this.events(id).push(event)
    appendFileSync(join(this.dir, 'rooms', `${id}.jsonl`), JSON.stringify(event) + '\n')
    const meta = this.rooms.get(id)
    if (meta) meta.updated = event.at
    this.touch(id)
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
    rmSync(join(this.dir, 'rooms', `${id}.jsonl`), { force: true })
    this.touch(id)
  }

  private touch(id: string) {
    this.dirty.add(id)
    this.flushTimer ??= setTimeout(() => this.flush(), 250)
  }

  flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (!this.dirty.size) return
    this.dirty.clear()
    writeJson(join(this.dir, 'rooms.json'), [...this.rooms.values()])
  }

  saveSettings(patch: Partial<Settings>) {
    Object.assign(this.settings, patch)
    writeJson(join(this.dir, 'settings.json'), this.settings)
  }

  saveState() {
    writeJson(join(this.dir, 'state.json'), { spent: this.spent, health: this.health, arena: this.arena, ratings: this.ratings, calib: this.calib })
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
    writeJson(join(this.dir, 'keys.json'), sealed)
  }

  record(agent: string, room: string, usage: Usage) {
    const row = { at: Date.now(), agent, room, usage }
    this.ledger.push(row)
    appendFileSync(join(this.dir, 'ledger.jsonl'), JSON.stringify(row) + '\n')
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
      return { day: localDay(d), start: d.getTime(), cost: 0, tokens: 0, input: 0, cached: 0, saved: 0, kept: 0 }
    })
    const out: Ledger = { today: {}, week: {}, arena: { ...this.arena }, ratings: this.ratings, days: [], rooms: {} }
    for (const row of this.ledger) {
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
        slot.kept += row.usage.kept ?? 0
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
