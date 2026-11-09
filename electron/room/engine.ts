import { randomUUID } from 'node:crypto'
import type { Access, AgentInfo, Block, Event, Hit, Live, LiveRun, LiveTurn, Pack, RoomMeta, RoomSummary, Skill } from '../../shared/types'
import { asks, plan } from '../../shared/plan'
import { detect, run } from '../agents'
import { execute, type Ran } from '../shell'
import type { Store } from '../store'
import { prompt, protocol } from './context'
import { check, suggest } from './proof'

type Hooks = {
  emit(channel: string, payload: unknown): void
  notify(title: string, body: string, room: string): void
  packs(): Pack[]
}

type Task =
  | { kind: 'reply' }
  | { kind: 'answer'; from: string; ask: string }
  | { kind: 'continue' }
  | { kind: 'retry'; tools: string[] }

type Ctx = { gen: number; hops: { n: number }; arena?: string; allow?: string[] }

const MAX_HOPS = 8
const uid = () => randomUUID().replace(/-/g, '').slice(0, 14)
type Draft<E = Event> = E extends Event ? Omit<E, 'id' | 'at'> : never

export class Engine {
  agents: AgentInfo[] = []
  private lives = new Map<string, Live>()
  private procs = new Map<string, Set<{ stop(): void }>>()
  private queues = new Map<string, Promise<unknown>>()
  private gens = new Map<string, number>()
  private allowed = new Map<string, Set<string>>()
  private liveTimers = new Map<string, NodeJS.Timeout>()
  private listTimer: NodeJS.Timeout | null = null

  constructor(private store: Store, private hooks: Hooks) {}

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
  private fallback(meta: RoomMeta, from: string) {
    const needTools = this.agent(from)?.tools
    const order = [...meta.crew.slice(meta.crew.indexOf(from) + 1), ...meta.crew.slice(0, Math.max(0, meta.crew.indexOf(from)))]
    const ok = order.filter((id) => id !== from && !this.why(id))
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
      return { id: m.id, name: m.name, created: m.created, updated: m.updated, crew: m.crew, workspace: m.workspace, pack: m.pack, busy: l.turns.length + l.runs.length > 0, waiting: this.waiting(m.id) }
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

  create(opts: { crew: string[]; workspace: string; pack?: string; name?: string }): RoomMeta {
    const meta: RoomMeta = {
      id: uid(), name: opts.name || 'New room', created: Date.now(), updated: Date.now(), crew: opts.crew, workspace: opts.workspace, pack: opts.pack,
      sessions: {}, seen: {}, heard: {}, blocks: [], saved: { full: 0, sent: 0 },
    }
    this.store.create(meta)
    this.list()
    return meta
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
      sessions: {}, seen: {}, heard: {}, forkedFrom: { room, event: at },
    }
    this.store.create(copy, events.slice(0, cut < 0 ? events.length : cut + 1))
    this.list()
    return copy
  }

  stop(room: string) {
    this.gens.set(room, (this.gens.get(room) ?? 0) + 1)
    for (const p of this.procs.get(room) ?? []) p.stop()
    this.procs.get(room)?.clear()
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

  send(room: string, text: string, access: Access, arena = false) {
    const meta = this.store.room(room)
    if (!meta || !text.trim()) return
    if (text.startsWith('!')) {
      const command = text.slice(1).trim()
      if (command) this.enqueue(room, () => this.shell(room, 'you', command, access))
      return
    }
    const lead = text.match(/^\s*((?:@[\w-]+[\s,]*)+)/)?.[1] ?? ''
    const mentioned = meta.crew.filter((id) => new RegExp(`@${id}(?![\\w-])`, 'i').test(lead))
    const first = !this.store.events(room).some((e) => e.kind === 'you')
    this.add(room, { kind: 'you', text, to: mentioned.length ? mentioned : undefined, arena: arena || undefined })
    if (first) {
      this.block(room, 'brief', 'Brief', text, 'you')
      if (meta.name === 'New room') this.rename(room, title(text))
    }
    this.enqueue(room, async (gen) => {
      const ctx: Ctx = { gen, hops: { n: 0 } }
      if (arena) {
        const id = uid()
        const crew = meta.crew.filter((c) => !this.why(c))
        await Promise.all(crew.map((who) => this.turn(room, who, { kind: 'reply' }, access, { ...ctx, arena: id })))
      } else {
        const lead = mentioned[0] ?? meta.crew.find((c) => !this.why(c)) ?? meta.crew[0]
        await this.conversation(room, lead, { kind: 'reply' }, access, ctx)
      }
      this.settle(room)
    })
  }

  pick(room: string, arena: string, who: string) {
    this.add(room, { kind: 'pick', arena, who })
    this.store.win(who)
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
    else this.hooks.notify(meta.name, 'Done', room)
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

  private async turn(room: string, who: string, task: Task, access: Access, ctx: Ctx): Promise<{ who: string; asks: { to: string; ask: string }[] } | null> {
    const meta = this.store.room(room)
    if (!meta || (this.gens.get(room) ?? 0) !== ctx.gen) return null
    const blocked = this.why(who)
    if (blocked) {
      const next = this.fallback(meta, who)
      this.add(room, { kind: 'wall', from: who, to: next ?? '', reason: blocked, until: this.store.spent[who]?.until })
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
    const lt: LiveTurn = { id: uid(), who, kind: task.kind === 'answer' ? 'hands' : 'say', from: task.kind === 'answer' ? task.from : undefined, ask: task.kind === 'answer' ? task.ask : undefined, arena: ctx.arena, text: '', acts: [], started: Date.now() }
    live.turns.push(lt)
    live.active = who
    live.doing = task.kind === 'answer' ? `${me.short} is answering ${this.name(task.from)}` : task.kind === 'continue' ? `${me.short} is reading the answers` : `${me.short} is working`
    if (task.kind === 'answer') live.cable = { from: task.from, to: who, at: Date.now() }
    this.changed(room)

    const running = run(who, {
      prompt: p.text, system: protocol(meta, me, crew, access, pack), cwd: meta.workspace, access,
      model: this.store.settings.models[who] || me.model, session: resumed ? session : undefined, allow: ctx.allow,
    }, this.store.keys(), (u) => {
      if (u.delta) lt.text += u.delta
      if (u.acts) lt.acts.push(...u.acts)
      if (u.working) live.doing = `${me.short}: ${u.working.slice(0, 90)}`
      this.changed(room)
    })
    const procs = this.procs.get(room) ?? new Set()
    this.procs.set(room, procs)
    procs.add(running)
    const r = await running.done
    procs.delete(running)
    live.turns = live.turns.filter((t) => t !== lt)
    if (live.active === who) live.active = live.turns[live.turns.length - 1]?.who ?? null
    this.changed(room)

    if (r.usage.input + r.usage.output + r.usage.cached > 0) {
      this.store.record(who, room, r.usage)
      this.hooks.emit('ledger', this.ledger())
    }
    if (resumed && r.error && !r.text && !r.limit && /session|resume|conversation|thread|not found|unexpected|no such|invalid/i.test(r.error)) {
      this.store.update(room, (m) => { delete m.sessions[who] })
      return this.turn(room, who, task, access, ctx)
    }
    const stopped = (this.gens.get(room) ?? 0) !== ctx.gen || r.error === 'Stopped'
    if (stopped) {
      if (lt.text.trim()) this.add(room, { kind: 'say', who, text: lt.text.trim(), acts: r.acts, error: 'Stopped' })
      return null
    }
    if (r.session && me.via === 'cli') this.store.update(room, (m) => { m.sessions[who] = r.session! })

    if (!r.text && (r.limit || r.error)) {
      if (r.limit) this.store.spent[who] = { until: r.limit.until, reason: r.error ?? 'limit' }
      else this.store.health[who] = r.error!
      this.store.saveState()
      if (r.limit) this.hooks.emit('ledger', this.ledger())
      else this.refresh()
      const next = this.fallback(meta, who)
      this.add(room, { kind: 'wall', from: who, to: next ?? '', until: r.limit?.until, reason: r.limit ? 'hit its limit' : r.error! })
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
      event = this.add(room, { kind: 'hands', from: task.from, to: who, ask: task.ask, answer: r.text, acts: r.acts, usage: r.usage, ms: r.ms })
      this.block(room, `answer-${event.id}`, `${me.short} for ${this.name(task.from)}: ${task.ask.slice(0, 60)}`, r.text, who)
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
    return { who, asks: parsed.asks }
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
