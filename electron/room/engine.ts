import { randomUUID } from 'node:crypto'
import { sentence } from '../../shared/steps'
import { existsSync } from 'node:fs'
import { relative } from 'node:path'
import type { Access, AgentInfo, Block, Event, Hit, Live, LiveRun, LiveTurn, Pack, RoomMeta, RoomSummary, Skill, Usage, Waiting } from '../../shared/types'
import { asks, plan } from '../../shared/plan'
import { classify, route, type Category } from '../../shared/route'
import { detect, run } from '../agents'
import { plain } from '../agents/parse'
import type { Hands, Tool } from '../hands'
import { openaiImage, target } from '../images'
import { kit, type Host } from './kit'
import { clearMemory, writeMemory } from './project'
import { execute, kill, type Ran } from '../shell'
import type { Snapshots } from '../snap'
import type { Store } from '../store'
import { prompt, protocol } from './context'
import { check, suggest } from './proof'

type Hooks = {
  emit(channel: string, payload: unknown): void
  turned?(agent: string, usage: Usage): void
  notify(title: string, body: string, room: string): void
  packs(): Pack[]
  // Tools from outside the room: the built-in browser and any MCP servers the person connected.
  tools?(who: string, workspace: string, access: Access): Tool[]
}

type Task =
  | { kind: 'reply' }
  | { kind: 'answer'; from: string; ask: string; via?: 'tool'; quiet?: boolean; label?: string; size?: string }
  | { kind: 'continue' }
  | { kind: 'retry'; tools: string[] }

type Ctx = { gen: number; hops: { n: number }; arena?: string; allow?: string[]; depth?: number; models?: Record<string, string> }
type Said = { who: string; text: string; asks: { to: string; ask: string }[] }

// Failures of one command in one turn before the loop guard stops it.
const LOOP = 3
const MAX_HOPS = 8
const IMAGE_MODEL = 'gpt-6-astra'
// Grok Build only loads MCP servers from config files, which the room does not touch.
const BORROWS = new Set(['claude', 'codex', 'gemini'])
const uid = () => randomUUID().replace(/-/g, '').slice(0, 14)
type Draft<E = Event> = E extends Event ? Omit<E, 'id' | 'at'> : never

export class Engine {
  agents: AgentInfo[] = []
  private lives = new Map<string, Live>()
  private procs = new Map<string, Set<{ stop(): void }>>()
  private queues = new Map<string, Promise<unknown>>()
  private gens = new Map<string, number>()
  private flushed = new Set<string>()
  private allowed = new Map<string, Set<string>>()
  private liveTimers = new Map<string, NodeJS.Timeout>()
  private listTimer: NodeJS.Timeout | null = null
  private projectTimers = new Map<string, NodeJS.Timeout>()

  constructor(private store: Store, private hooks: Hooks, private hands?: Hands, private snaps?: Snapshots) {}

  async refresh() {
    this.agents = await detect(this.store.keys(), this.store.settings.models, this.store.health)
    this.hooks.emit('agents', this.agents)
    return this.agents
  }

  private agent = (id: string) => this.agents.find((a) => a.id === id)
  private name = (id: string) => this.agent(id)?.short ?? id

  why(id: string): string | null {
    const a = this.agent(id)
    if (!a) return 'is not set up'
    if (this.store.settings.disabled.includes(id)) return 'is turned off'
    if (!a.ready) return a.note ?? 'is not ready'
    const spent = this.store.spent[id]
    if (spent && spent.until > Date.now()) return 'is out until it resets'
    const budget = this.store.settings.budgets[id]
    if (budget > 0 && (this.store.totals().today[id]?.cost ?? 0) >= budget) return 'is over today\'s budget'
    return null
  }

  // The next crewmate who can take the work, in crew order, preferring one with the same hands.
  // The next one in the crew who can take the work. When the whole crew is out, anyone else that
  // is set up and ready takes it, so a wall never ends the task. The asker never answers itself.
  private fallback(meta: RoomMeta, from: string, asker?: string) {
    const needTools = this.agent(from)?.tools
    const order = [...meta.crew.slice(meta.crew.indexOf(from) + 1), ...meta.crew.slice(0, Math.max(0, meta.crew.indexOf(from)))]
    const outside = this.agents.filter((a) => !meta.crew.includes(a.id) && a.ready).map((a) => a.id)
    const ok = [...order, ...outside].filter((id) => id !== from && id !== asker && !this.why(id))
    return ok.find((id) => !needTools || this.agent(id)?.tools) ?? ok[0] ?? null
  }

  live(room: string): Live {
    let l = this.lives.get(room)
    if (!l) this.lives.set(room, (l = { turns: [], runs: [], doing: '', active: null, waiting: false }))
    return l
  }

  private changed(room: string) {
    if (this.liveTimers.has(room)) return
    this.liveTimers.set(room, setTimeout(() => {
      this.liveTimers.delete(room)
      const live = this.live(room)
      live.waiting = this.waiting(room)
      this.hooks.emit('room:live', { room, live })
    }, 40))
    this.list()
  }

  private list() {
    this.listTimer ??= setTimeout(() => {
      this.listTimer = null
      this.hooks.emit('rooms', this.summaries())
    }, 120)
  }

  private waiting(room: string) {
    if (this.live(room).runs.some((r) => r.state === 'asking')) return true
    const events = this.store.events(room)
    const chosen = new Set(events.filter((e) => e.kind === 'chose').map((e) => (e as { ref: string }).ref))
    return events.some((e) => e.kind === 'decide' && !chosen.has(e.id))
  }

  summaries(): RoomSummary[] {
    return this.store.list().map((m) => {
      const l = this.live(m.id)
      return { id: m.id, name: m.name, created: m.created, updated: m.updated, crew: m.crew, workspace: m.workspace, pack: m.pack, flow: m.flow, pinned: m.pinned, archived: m.archived, busy: l.turns.length + l.runs.length > 0, waiting: this.waiting(m.id) }
    })
  }

  private add(room: string, draft: Draft): Event {
    const event = { ...draft, id: uid(), at: Date.now() } as Event
    this.store.append(room, event)
    this.hooks.emit('room:event', { room, event })
    this.list()
    return event
  }

  private block(room: string, id: string, title: string, text: string, by?: string) {
    this.store.update(room, (m) => {
      const b = m.blocks.find((x) => x.id === id)
      if (b) {
        if (b.text === text && b.title === title) return
        Object.assign(b, { title, text, v: b.v + 1, at: Date.now(), by })
      } else m.blocks.push({ id, title, text, v: 1, at: Date.now(), by } satisfies Block)
    })
    this.hooks.emit('room:meta', this.store.room(room))
    this.syncProject(room)
  }

  // The room's memory, mirrored into AGENTS.md (and CLAUDE.md / GEMINI.md when the project has
  // them) so the same agents opened outside Lunchbox know what the room decided.
  private syncProject(room: string) {
    if (!this.store.room(room)?.project) return
    clearTimeout(this.projectTimers.get(room))
    this.projectTimers.set(room, setTimeout(() => {
      this.projectTimers.delete(room)
      const meta = this.store.room(room)
      if (meta?.project) try { writeMemory(meta) } catch (e) { this.add(room, { kind: 'note', text: `Could not update AGENTS.md: ${(e as Error).message}`, tone: 'warn' }) }
    }, 600))
  }

  setProject(room: string, on: boolean) {
    const meta = this.store.room(room)
    if (!meta || !!meta.project === on) return []
    this.store.update(room, (m) => { m.project = on || undefined })
    this.hooks.emit('room:meta', this.store.room(room))
    if (!on) { clearMemory(meta.workspace); return [] }
    return writeMemory(meta)
  }

  private async checkpoint(room: string, event: string, access: Access) {
    const meta = this.store.room(room)
    if (!meta || !this.snaps || access === 'plan' || this.store.settings.snapshots === false) return
    const live = this.live(room)
    live.doing = 'Saving a checkpoint of the folder'
    this.changed(room)
    const text = this.store.events(room).find((e) => e.id === event)
    const snap = await this.snaps.take(meta.workspace, `Before: ${text?.kind === 'you' ? text.text.slice(0, 120) : event}`)
    if (!snap) return
    this.store.update(room, (m) => { m.checkpoints = [...(m.checkpoints ?? []), { ref: snap.ref, event, at: Date.now() }].slice(-60) })
    this.hooks.emit('room:meta', this.store.room(room))
  }

  async changedSince(room: string, event: string) {
    const meta = this.store.room(room)
    const cp = meta?.checkpoints?.find((c) => c.event === event)
    if (!meta || !cp || !this.snaps) return []
    return this.snaps.changed(meta.workspace, cp.ref)
  }

  // What the crew changed in answer to one message: from its checkpoint to the next message's,
  // or to the folder as it is now when it is the latest.
  async changesFor(room: string, event: string) {
    const meta = this.store.room(room)
    const list = meta?.checkpoints ?? []
    const i = list.findIndex((c) => c.event === event)
    if (!meta || i < 0 || !this.snaps) return []
    return this.snaps.diff(meta.workspace, list[i].ref, list[i + 1]?.ref)
  }

  async rewind(room: string, target: { event?: string; ref?: string }) {
    const meta = this.store.room(room)
    if (!meta || !this.snaps) throw new Error('Checkpoints are not available')
    const ref = target.ref ?? meta.checkpoints?.find((c) => c.event === target.event)?.ref
    if (!ref) throw new Error('There is no checkpoint for that message')
    this.stop(room)
    const r = await this.snaps.restore(meta.workspace, ref)
    const said = this.store.events(room).find((e) => e.id === target.event)
    const what = said?.kind === 'you' ? `before “${title(said.text)}”` : 'where it was before the rewind'
    this.add(room, { kind: 'note', text: `Put the folder back ${what}.${r.removed ? ` ${r.removed} new file${r.removed > 1 ? 's were' : ' was'} removed.` : ''}`, undo: r.undo })
    return r
  }

  private enqueue(room: string, job: (gen: number) => Promise<unknown>) {
    const gen = this.gens.get(room) ?? 0
    const next = (this.queues.get(room) ?? Promise.resolve()).then(() => ((this.gens.get(room) ?? 0) === gen ? job(gen) : null)).catch((e) => {
      this.add(room, { kind: 'note', text: `Something broke: ${e instanceof Error ? e.message : String(e)}`, tone: 'bad' })
    })
    this.queues.set(room, next)
    return next
  }

  idle(room: string) {
    return this.queues.get(room) ?? Promise.resolve()
  }

  create(opts: { crew: string[]; workspace: string; pack?: string; name?: string; flow?: string }): RoomMeta {
    const meta: RoomMeta = {
      id: uid(), name: opts.name || 'New room', created: Date.now(), updated: Date.now(), crew: opts.crew, workspace: opts.workspace, pack: opts.pack, flow: opts.flow,
      sessions: {}, seen: {}, heard: {}, blocks: [], saved: { full: 0, sent: 0 },
    }
    this.store.create(meta)
    this.list()
    return meta
  }

  mark(room: string, patch: { pinned?: boolean; archived?: boolean }) {
    this.store.update(room, (m) => {
      if (patch.pinned !== undefined) m.pinned = patch.pinned || undefined
      // An archived room leaves the list; pinning it again would only hide it twice.
      if (patch.archived !== undefined) { m.archived = patch.archived || undefined; if (patch.archived) m.pinned = undefined }
    })
    this.list()
  }

  // Every decision and command waiting for a person, across all rooms, newest room first.
  inbox(): Waiting[] {
    return this.store.list().flatMap((m) => {
      const events = this.store.events(m.id)
      const chosen = new Set(events.filter((e) => e.kind === 'chose').map((e) => (e as { ref: string }).ref))
      const items: Waiting['items'] = [
        ...events.flatMap((e) => (e.kind === 'decide' && !chosen.has(e.id) ? [{ kind: 'decide' as const, ref: e.id, text: e.text, options: e.options.map((o) => o.label) }] : [])),
        ...this.live(m.id).runs.filter((r) => r.state === 'asking').map((r) => ({ kind: 'run' as const, id: r.id, command: r.command, reason: r.verdict?.reason ?? '' })),
      ]
      return items.length ? [{ room: m.id, name: m.name, items }] : []
    })
  }

  rename(room: string, name: string) {
    this.store.update(room, (m) => { m.name = name.trim() || m.name })
    this.list()
  }

  remove(room: string) {
    this.stop(room)
    this.store.remove(room)
    this.lives.delete(room)
    this.list()
  }

  setCrew(room: string, crew: string[]) {
    const meta = this.store.room(room)
    if (!meta || !crew.length || crew.join() === meta.crew.join()) return
    this.store.update(room, (m) => { m.crew = crew })
    this.add(room, { kind: 'crew', crew })
    this.hooks.emit('room:meta', this.store.room(room))
  }

  setWorkspace(room: string, workspace: string) {
    this.store.update(room, (m) => { m.workspace = workspace; m.sessions = {} })
    this.hooks.emit('room:meta', this.store.room(room))
    this.list()
  }

  fork(room: string, at: string) {
    const meta = this.store.room(room)
    if (!meta) return null
    const events = this.store.events(room)
    const cut = events.findIndex((e) => e.id === at)
    const copy: RoomMeta = {
      ...structuredClone(meta), id: uid(), name: `${meta.name}, fork`, created: Date.now(), updated: Date.now(),
      sessions: {}, seen: {}, heard: {}, forkedFrom: { room, event: at }, project: undefined, flow: undefined,
    }
    this.store.create(copy, events.slice(0, cut < 0 ? events.length : cut + 1))
    this.list()
    return copy
  }

  // Stopping is instant from the user's side: what each agent wrote so far lands in the room now
  // and the live turns clear, while the processes are killed and exit in their own time.
  stop(room: string) {
    this.gens.set(room, (this.gens.get(room) ?? 0) + 1)
    for (const p of this.procs.get(room) ?? []) p.stop()
    this.procs.get(room)?.clear()
    const live = this.live(room)
    // Commands too: a running one is killed and one waiting for approval is refused, so the
    // room's queue never hangs on a question nobody will answer.
    for (const r of live.runs) kill(r.id)
    for (const lt of live.turns) {
      this.flushed.add(lt.id)
      if (lt.text.trim()) this.add(room, { kind: 'say', who: lt.who, text: lt.text.trim(), acts: lt.acts, error: 'Stopped' })
    }
    live.turns = []
    live.doing = ''
    live.active = null
    this.hooks.emit('room:live', { room, live })
    this.list()
  }

  pin(room: string, eventId: string) {
    const e = this.store.events(room).find((x) => x.id === eventId)
    if (!e) return
    const text = e.kind === 'say' ? e.text : e.kind === 'hands' ? e.answer : e.kind === 'you' ? e.text : e.kind === 'run' ? `${e.command}\n${e.out}` : ''
    const by = e.kind === 'say' ? e.who : e.kind === 'hands' ? e.to : 'you'
    if (text) this.block(room, `pin-${e.id}`, `Pinned from ${by === 'you' ? 'you' : this.name(by)}`, text, by)
  }

  editBlock(room: string, id: string, text: string) {
    const b = this.store.room(room)?.blocks.find((x) => x.id === id)
    if (b) this.block(room, id, b.title, text, 'you')
  }

  dropBlock(room: string, id: string) {
    this.store.update(room, (m) => { m.blocks = m.blocks.filter((b) => b.id !== id) })
    this.hooks.emit('room:meta', this.store.room(room))
  }

  send(room: string, text: string, access: Access, opts: boolean | { arena?: boolean; files?: string[]; from?: 'flow' | 'phone' } = {}) {
    const { arena = false, files, from } = typeof opts === 'boolean' ? { arena: opts } : opts
    const meta = this.store.room(room)
    if (!meta || (!text.trim() && !files?.length)) return
    if (text.startsWith('!')) {
      const command = text.slice(1).trim()
      if (command) this.enqueue(room, () => this.shell(room, 'you', command, access))
      return
    }
    const head = text.match(/^\s*((?:@[\w-]+[\s,]*)+)/)?.[1] ?? ''
    // @ reaches any agent that is set up, by id or by name. One from outside the crew joins it.
    const named = (a: AgentInfo) => [a.id, a.short.toLowerCase().replace(/[^a-z0-9]+/g, '-')]
    const mentioned = this.agents.filter((a) => a.ready && named(a).some((h) => new RegExp(`@${h}(?![\\w-])`, 'i').test(head))).map((a) => a.id)
    const joining = mentioned.filter((id) => !meta.crew.includes(id))
    if (joining.length) this.setCrew(room, [...meta.crew, ...joining])
    const first = !this.store.events(room).some((e) => e.kind === 'you')
    const cat = classify(text)
    const lead = mentioned[0] ?? this.lead(meta, cat)
    const said = this.add(room, { kind: 'you', text, to: mentioned.length ? mentioned : undefined, arena: arena || undefined, cat, lead: arena ? undefined : lead, files: files?.length ? files : undefined, from })
    if (first) {
      this.block(room, 'brief', 'Brief', text, 'you')
      if (meta.name === 'New room') this.rename(room, title(text))
    }
    return this.enqueue(room, async (gen) => {
      await this.checkpoint(room, said.id, access)
      const ctx: Ctx = { gen, hops: { n: 0 } }
      if (arena) {
        const id = uid()
        const crew = meta.crew.filter((c) => !this.why(c))
        await Promise.all(crew.map((who) => this.turn(room, who, { kind: 'reply' }, access, { ...ctx, arena: id })))
      } else {
        await this.conversation(room, lead, { kind: 'reply' }, access, ctx)
        // Everyone else named at the start answers in turn, each seeing what came before.
        for (const who of mentioned.slice(1)) {
          if ((this.gens.get(room) ?? 0) !== gen) break
          await this.conversation(room, who, { kind: 'reply' }, access, ctx)
        }
      }
      this.settle(room)
    })
  }

  private lead(meta: RoomMeta, cat: Category) {
    const free = meta.crew.filter((c) => !this.why(c))
    if (this.store.settings.route === 'order' || free.length < 2) return free[0] ?? meta.crew[0]
    const today = this.store.totals().today
    return route(this.store.ratings, cat, free.map((id) => {
      const budget = this.store.settings.budgets[id]
      return { id, paid: this.agent(id)?.via === 'api', budgetLeft: budget > 0 ? 1 - (today[id]?.cost ?? 0) / budget : undefined }
    })) ?? free[0]
  }

  pick(room: string, arena: string, who: string) {
    const events = this.store.events(room)
    if (events.some((e) => e.kind === 'pick' && e.arena === arena)) return
    const answers = events.filter((e) => e.kind === 'say' && e.arena === arena)
    const first = events.indexOf(answers[0])
    const asked = events.slice(0, first).findLast((e) => e.kind === 'you')
    const cat = (asked?.kind === 'you' && asked.cat) || classify(asked?.kind === 'you' ? asked.text : '')
    this.add(room, { kind: 'pick', arena, who })
    this.store.win(who, cat, answers.map((e) => (e as { who: string }).who))
    this.decision(room, `Picked ${this.name(who)}'s answer in a side by side`)
    this.hooks.emit('ledger', this.ledger())
  }

  private decision(room: string, line: string) {
    const prev = this.store.room(room)?.blocks.find((b) => b.id === 'decisions')?.text
    this.block(room, 'decisions', 'Decisions', [prev, `- ${line}`].filter(Boolean).join('\n'), 'you')
  }

  decide(room: string, ref: string, index: number, access: Access) {
    const events = this.store.events(room)
    const e = events.find((x) => x.id === ref)
    if (!e || e.kind !== 'decide' || events.some((x) => x.kind === 'chose' && x.ref === ref)) return
    const opt = e.options[index]
    if (!opt) return
    this.add(room, { kind: 'chose', ref, label: opt.label })
    this.decision(room, `${e.text} Chose: ${opt.label}`)
    const a = opt.action
    if (a.type === 'run') {
      this.enqueue(room, async () => {
        const ran = await this.shell(room, 'you', a.command, access)
        const ok = ran.code === 0
        this.add(room, { kind: 'note', text: ok ? `Proved: ${a.claim}. \`${a.command}\` exited 0.` : `Still not proved: \`${a.command}\` ${ran.code === null ? ran.how : `exited ${ran.code}`}.`, tone: ok ? undefined : 'bad' })
      })
    } else if (a.type === 'ask') {
      this.add(room, { kind: 'you', text: a.text, to: [a.who] })
      this.enqueue(room, async (gen) => { await this.conversation(room, a.who, { kind: 'reply' }, access, { gen, hops: { n: 0 } }); this.settle(room) })
    } else if (a.type === 'retry') {
      this.enqueue(room, async (gen) => { await this.conversation(room, a.who, { kind: 'retry', tools: a.tools }, access, { gen, hops: { n: 0 }, allow: a.tools }); this.settle(room) })
    }
    this.changed(room)
  }

  private settle(room: string) {
    const live = this.live(room)
    live.active = null
    live.doing = ''
    this.changed(room)
    const meta = this.store.room(room)
    if (!meta) return
    if (this.waiting(room)) this.hooks.notify(meta.name, 'Needs you', room)
    // A flow says once when it is finished, not after every step.
    else if (!meta.flow) this.hooks.notify(meta.name, 'Done', room)
  }

  private async conversation(room: string, who: string, task: Task, access: Access, ctx: Ctx) {
    let res = await this.turn(room, who, task, access, ctx)
    let rounds = 0
    while (res && res.asks.length && ctx.hops.n < MAX_HOPS && rounds++ < 3) {
      const asker = res.who
      let answered = 0
      for (const a of res.asks.slice(0, 2)) {
        if (ctx.hops.n >= MAX_HOPS) break
        ctx.hops.n++
        if (await this.turn(room, a.to, { kind: 'answer', from: asker, ask: a.ask }, access, ctx)) answered++
      }
      if (!answered) break
      ctx.hops.n++
      res = await this.turn(room, asker, { kind: 'continue' }, access, ctx)
    }
  }

  private task(t: Task) {
    switch (t.kind) {
      case 'reply': return 'You are up. Reply to the person\'s latest message, and do the work it asks for.'
      case 'answer': return `${this.name(t.from)} asks you: ${t.ask}\n\nAnswer ${this.name(t.from)} directly and completely. Your answer goes straight back to them, so do not ask anyone else.`
      case 'continue': return 'Your crewmates answered above. Carry on with the work and reply to the person.'
      case 'retry': return `You now have permission for: ${t.tools.join(', ')}. Carry on where you stopped.`
    }
  }

  private host(room: string, me: AgentInfo, crew: AgentInfo[], access: Access, ctx: Ctx): Host {
    return {
      me,
      crew,
      ready: this.agents.filter((a) => !this.why(a.id)),
      nested: (ctx.depth ?? 0) > 0,
      canWrite: access === 'workspace' || access === 'full',
      consult: (to, ask) => this.consult(room, me.id, to, ask, access, ctx),
      image: (prompt, file, size) => this.image(room, me.id, prompt, access, ctx, file, size),
      memory: () => this.store.room(room)?.blocks ?? [],
      remember: (title, text) => this.block(room, `note-${uid()}`, title, text, me.id),
    }
  }

  private async consult(room: string, from: string, to: string, ask: string, access: Access, ctx: Ctx, models?: Record<string, string>, quiet = false, label?: string, size?: string) {
    if (++ctx.hops.n > MAX_HOPS) throw new Error('This message has used all its handoffs. Finish with what you have.')
    const r = await this.turn(room, to, { kind: 'answer', from, ask, via: 'tool', quiet, label, size }, access, { ...ctx, arena: undefined, depth: (ctx.depth ?? 0) + 1, models })
    if (!r?.text) throw new Error(`${this.name(to)} could not answer right now.`)
    return r.text
  }

  private async image(room: string, from: string, prompt: string, access: Access, ctx: Ctx, file?: string, size?: string) {
    const meta = this.store.room(room)
    if (!meta) throw new Error('The room is gone')
    const path = target(meta.workspace, prompt, file)
    const key = this.store.keys().openai
    let by = 'codex'
    let usage: Usage | undefined
    if (key && !this.why('openai-api')) {
      by = 'openai-api'
      const live = this.live(room)
      live.doing = `Making an image for ${this.name(from)}`
      this.changed(room)
      usage = await openaiImage(key, prompt, path, size)
      this.store.record(by, room, usage)
      this.hooks.emit('ledger', this.ledger())
    } else {
      const ask = `Generate this image with your image tool and save it as ${path}${size ? ` at ${size}` : ''}. Reply with the path only.\n\nImage: ${prompt}`
      // Quiet: the image itself is what the room shows, not the instruction that produced it.
      const said = await this.consult(room, from, 'codex', ask, access, ctx, { codex: this.store.settings.imageModel || IMAGE_MODEL }, true, prompt, size).catch((e: Error) => e.message)
      if (!existsSync(path)) throw new Error(`The image was not saved. ${said.slice(0, 300)}`)
    }
    this.add(room, { kind: 'image', by, for: from, prompt, path, size, usage })
    return `Saved ${relative(meta.workspace, path)}`
  }

  private async turn(room: string, who: string, task: Task, access: Access, ctx: Ctx): Promise<Said | null> {
    const meta = this.store.room(room)
    if (!meta || (this.gens.get(room) ?? 0) !== ctx.gen) return null
    const blocked = this.why(who)
    if (blocked) {
      const next = ctx.arena ? null : this.fallback(meta, who)
      this.add(room, { kind: 'wall', from: who, to: next ?? '', arena: ctx.arena, reason: blocked, until: this.store.spent[who]?.until })
      if (!next || ++ctx.hops.n > MAX_HOPS) return null
      return this.turn(room, next, task, access, ctx)
    }
    const me = this.agent(who)!
    const crew = meta.crew.map((id) => this.agent(id)).filter((a): a is AgentInfo => !!a && !this.why(a.id))
    if (!crew.some((a) => a.id === who)) crew.unshift(me)
    const pack = this.hooks.packs().find((p) => p.id === meta.pack)
    const session = meta.sessions[who]
    const resumed = !!session && me.via === 'cli' && who !== 'gemini'
    const events = this.store.events(room)
    const p = prompt(meta, events, who, this.task(task), this.name, resumed)
    this.store.update(room, (m) => {
      m.seen[who] = p.seen
      m.saved.full += p.full
      m.saved.sent += p.sent
    })

    const live = this.live(room)
    const lt: LiveTurn = { id: uid(), who, kind: task.kind === 'answer' ? 'hands' : 'say', from: task.kind === 'answer' ? task.from : undefined, ask: task.kind === 'answer' ? task.ask : undefined, arena: ctx.arena, text: '', acts: [], started: Date.now(), image: task.kind === 'answer' && task.quiet ? true : undefined, label: task.kind === 'answer' ? task.label : undefined, size: task.kind === 'answer' ? task.size : undefined }
    live.turns.push(lt)
    live.active = who
    live.doing = task.kind === 'answer' ? `${me.short} is answering ${this.name(task.from)}` : task.kind === 'continue' ? `${me.short} is reading the answers` : `${me.short} is working`
    if (task.kind === 'answer') live.cable = { from: task.from, to: who, at: Date.now() }
    this.changed(room)

    const tools = this.hands && me.via === 'cli' && BORROWS.has(who)
      ? [...kit(this.host(room, me, crew, access, ctx)), ...(this.hooks.tools?.(who, meta.workspace, access) ?? [])]
      : []
    const grant = tools.length ? this.hands!.grant(tools) : null
    const http = me.via !== 'cli'
    const fails = new Map<string, number>()
    let looped = ''
    const running = run(who, {
      prompt: http ? p.tail : p.text, history: http ? p.history : undefined, cacheKey: `${room}:${who}`, system: protocol(meta, me, crew, access, pack, tools.map((t) => t.name), this.store.settings.habits), cwd: meta.workspace, access,
      model: ctx.models?.[who] || this.store.settings.models[who] || me.model, session: resumed ? session : undefined, allow: ctx.allow, hands: grant?.url,
    }, this.store.keys(), (u) => {
      if (u.delta) lt.text += u.delta
      if (u.acts) {
        lt.acts.push(...u.acts)
        lt.now = undefined
        live.doing = `${me.short} is thinking`
        // The loop guard: the same command failing three times means the agent is going round in
        // circles, spending the plan. Stop the turn and let the person decide.
        for (const a of u.acts) {
          if (a.t !== 'cmd' || a.exit === 0 || a.exit === null) continue
          const n = (fails.get(a.command) ?? 0) + 1
          fails.set(a.command, n)
          if (n >= LOOP && !looped) { looped = a.command; running.stop() }
        }
      }
      if (u.working) { live.doing = sentence(me.short, u.working); lt.now = u.working.slice(0, 120) }
      this.changed(room)
    })
    const procs = this.procs.get(room) ?? new Set()
    this.procs.set(room, procs)
    procs.add(running)
    const r = await running.done
    grant?.revoke()
    procs.delete(running)
    live.turns = live.turns.filter((t) => t !== lt)
    if (live.active === who) live.active = live.turns[live.turns.length - 1]?.who ?? null
    this.changed(room)
    if (looped) {
      this.flushed.add(lt.id)
      this.add(room, { kind: 'say', who, text: lt.text.trim(), acts: r.acts.length ? r.acts : lt.acts, usage: r.usage, ms: r.ms })
      const other = this.fallback(meta, who)
      this.add(room, {
        kind: 'decide',
        text: `${me.short} ran \`${looped}\` ${LOOP} times and it failed each time, so Lunchbox paused it before it spends more of your plan.`,
        options: [
          { label: 'Try another way', action: { type: 'ask', who, text: `@${who} \`${looped}\` failed ${LOOP} times. Step back, find the cause first, and try a different approach. Say what you changed.` } },
          ...(other ? [{ label: `Hand it to ${this.name(other)}`, action: { type: 'ask' as const, who: other, text: `@${other} ${me.short} got stuck: \`${looped}\` failed ${LOOP} times. Look at why and fix it.` } }] : []),
          { label: 'Leave it', action: { type: 'accept' } },
        ],
      })
      return null
    }

    if (r.usage.input + r.usage.output + r.usage.cached > 0) {
      // Memory the agent already had and was not sent again, in tokens at about four characters each.
      const kept = Math.round((p.full - p.sent) / 4)
      this.store.record(who, room, kept > 0 ? { ...r.usage, kept } : r.usage)
      this.hooks.emit('ledger', this.ledger())
      this.hooks.turned?.(who, r.usage)
    }
    if (resumed && r.error && !r.text && !r.limit && /session|resume|conversation|thread|not found|unexpected|no such|invalid/i.test(r.error)) {
      this.store.update(room, (m) => { delete m.sessions[who] })
      return this.turn(room, who, task, access, ctx)
    }
    const stopped = (this.gens.get(room) ?? 0) !== ctx.gen || r.error === 'Stopped'
    if (stopped) {
      const already = this.flushed.delete(lt.id)
      if (lt.text.trim() && !already) this.add(room, { kind: 'say', who, text: lt.text.trim(), acts: r.acts, error: 'Stopped' })
      return null
    }
    if (r.session && me.via === 'cli') this.store.update(room, (m) => { m.sessions[who] = r.session! })

    // A reply that got partway before the limit is kept, and the limit still counts.
    if (r.text && r.limit) {
      this.store.spent[who] = { until: r.limit.until, reason: 'limit' }
      this.store.saveState()
      this.hooks.emit('ledger', this.ledger())
    }
    if (!r.text && (r.limit || r.error)) {
      if (r.error) r.error = plain(r.error)
      if (r.limit) this.store.spent[who] = { until: r.limit.until, reason: r.error ?? 'limit' }
      else this.store.health[who] = r.error!
      this.store.saveState()
      if (r.limit) this.hooks.emit('ledger', this.ledger())
      else this.refresh()
      // In side by side everyone is already answering, so a failed slot stays empty and says why.
      const next = ctx.arena ? null : this.fallback(meta, who, task.kind === 'answer' ? task.from : undefined)
      this.add(room, { kind: 'wall', from: who, to: next ?? '', arena: ctx.arena, until: r.limit?.until, reason: r.limit ? 'hit its limit' : r.error! })
      if (next && ++ctx.hops.n <= MAX_HOPS) return this.turn(room, next, task, access, ctx)
      return null
    }
    if (this.store.health[who]) {
      delete this.store.health[who]
      this.store.saveState()
      this.refresh()
    }

    const handles = crew.filter((a) => a.id !== who).map((a) => a.id)
    const parsed = task.kind === 'answer' || ctx.arena ? { asks: [], text: r.text } : asks(r.text, handles)
    let event: Event
    if (task.kind === 'answer') {
      const hands = { kind: 'hands' as const, from: task.from, to: who, ask: task.ask, answer: r.text, acts: r.acts, usage: r.usage, ms: r.ms, via: task.via }
      if (task.quiet) event = { ...hands, id: uid(), at: Date.now() }
      else {
        event = this.add(room, hands)
        this.block(room, `answer-${event.id}`, `${me.short} for ${this.name(task.from)}: ${task.ask.slice(0, 60)}`, r.text, who)
      }
    } else {
      const draft = { kind: 'say' as const, who, text: parsed.text || (parsed.asks.length ? `Asking ${parsed.asks.map((a) => this.name(a.to)).join(' and ')}.` : r.text), acts: r.acts, usage: r.usage, arena: ctx.arena, ms: r.ms }
      const proof = check(draft.text, [...events, { ...draft, id: '', at: 0 }])
      event = this.add(room, proof.length ? { ...draft, proof } : draft)
      const bad = proof.find((x) => !x.ok)
      if (bad) {
        const cmd = suggest(bad.claim, meta.workspace)
        this.add(room, {
          kind: 'decide',
          text: `${me.short} says ${bad.claim}, but ${bad.text.replace(/`/g, '')}.`,
          options: [
            ...(cmd ? [{ label: `Run ${cmd}`, action: { type: 'run' as const, command: cmd, claim: bad.claim } }] : []),
            { label: `Ask ${me.short} to prove it`, action: { type: 'ask' as const, who, text: `@${who} prove that ${bad.claim}: run the check and show the result.` } },
            { label: 'Accept anyway', action: { type: 'accept' as const } },
          ],
        })
      }
    }
    this.store.update(room, (m) => { m.heard[who] = events.length })

    const edited = r.acts.filter((a) => a.t === 'edit').map((a) => (a as { path: string }).path)
    if (edited.length) {
      const prev = meta.blocks.find((b) => b.id === 'files')?.text.split('\n').filter(Boolean) ?? []
      const all = [...new Set([...prev, ...edited])].sort()
      if (all.length !== prev.length) this.block(room, 'files', 'Changed files', all.join('\n'), who)
    }
    if (access === 'ask' && r.denied.length) {
      this.add(room, {
        kind: 'decide',
        text: `${me.short} was not allowed to use ${r.denied.join(', ')}.`,
        options: [{ label: 'Allow and carry on', action: { type: 'retry', who, tools: r.denied } }, { label: 'Keep it read only', action: { type: 'accept' } }],
      })
    }
    return { who, text: r.text, asks: parsed.asks }
  }

  shell(room: string, who: string, command: string, access: Access): Promise<Ran> {
    const meta = this.store.room(room)!
    const live = this.live(room)
    const lr: LiveRun = { id: uid(), who, command, cwd: meta.workspace, state: 'checking', out: '', started: Date.now() }
    live.runs.push(lr)
    this.changed(room)
    const memory = this.allowed.get(meta.workspace) ?? new Set<string>()
    this.allowed.set(meta.workspace, memory)
    return execute({ id: lr.id, command, cwd: meta.workspace, root: meta.workspace, access, memory }, {
      verdict: (v) => {
        lr.verdict = v
        lr.state = v.decision === 'ask' ? 'asking' : 'running'
        if (v.decision === 'ask') this.hooks.notify(meta.name, `Allow \`${command}\`?`, room)
        this.changed(room)
      },
      start: () => { lr.state = 'running'; this.changed(room) },
      out: (t) => { lr.out = (lr.out + t).slice(-20000); this.changed(room) },
    }).then((ran) => {
      live.runs = live.runs.filter((x) => x !== lr)
      this.add(room, { kind: 'run', who, command, cwd: meta.workspace, verdict: ran.verdict, code: ran.code, ms: ran.ms, out: ran.out.slice(-6000), how: ran.how })
      this.changed(room)
      return ran
    })
  }

  ledger() {
    return { ...this.store.totals(), spent: this.store.spent, budgets: this.store.settings.budgets }
  }

  skill(room: string): Skill | null {
    const meta = this.store.room(room)
    if (!meta) return null
    const events = this.store.events(room)
    const brief = events.find((e) => e.kind === 'you')
    if (!brief || brief.kind !== 'you') return null
    const steps = plan(events).map((s) => s.text)
    if (!steps.length) {
      for (const e of events) {
        if (e.kind === 'hands') steps.push(`Ask ${this.name(e.to)}: ${e.ask}`)
        if (e.kind === 'say') for (const a of e.acts) if (a.t === 'cmd' && a.exit === 0 && /test|build|lint|check|deploy/i.test(a.command)) steps.push(`Run \`${a.command}\``)
      }
    }
    const skill: Skill = { id: uid(), name: meta.name, brief: brief.text, steps: [...new Set(steps)].slice(0, 12), crew: meta.crew, pack: meta.pack, from: room, created: Date.now() }
    this.store.skills = [skill, ...this.store.skills.filter((s) => s.name !== skill.name)]
    this.store.saveSkills()
    this.hooks.emit('skills', this.store.skills)
    return skill
  }

  search(q: string): Hit[] {
    const needle = q.trim().toLowerCase()
    if (needle.length < 2) return []
    const hits: Hit[] = []
    for (const m of this.store.list()) {
      if (m.name.toLowerCase().includes(needle)) hits.push({ room: m.id, roomName: m.name, text: m.name })
      for (const e of this.store.events(m.id)) {
        const text = e.kind === 'you' || e.kind === 'say' ? e.text : e.kind === 'hands' ? `${e.ask} ${e.answer}` : e.kind === 'run' ? e.command : ''
        const at = text.toLowerCase().indexOf(needle)
        if (at < 0) continue
        hits.push({ room: m.id, roomName: m.name, event: e.id, text: (at > 40 ? '…' : '') + text.slice(Math.max(0, at - 40), at + 100).replace(/\s+/g, ' ') })
        if (hits.length >= 40) return hits
      }
    }
    return hits
  }
}

function title(text: string) {
  const first = text.split('\n')[0].replace(/^[!@]\S*\s*/, '').replace(/[.?!:;,]+$/, '').trim()
  if (first.length <= 48) return first || 'New room'
  return first.slice(0, 48).replace(/\s+\S*$/, '') + '…'
}
