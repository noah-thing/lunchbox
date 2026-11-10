import { randomUUID } from 'node:crypto'
import { fill, nextRun } from '../shared/flow'
import type { Event, Flow, FlowState } from '../shared/types'
import type { Engine } from './room/engine'
import type { Store } from './store'

type Hooks = {
  emit(channel: string, payload: unknown): void
  notify(title: string, body: string, room: string): void
}

const TICK = 30e3
const MISSED = 6 * 3600e3
// A step that has not settled in an hour has hung, most likely on an agent that stopped answering.
// Without a limit the flow would count as running forever and never fire again.
const STEP = 60 * 60e3
// Runs kept per flow, matching the run history; older rooms are deleted.
const KEEP = 20

// How a step ended, from the events it added: the first one is the step's own message, so an
// earlier step's answer never counts for this one.
export function stepResult(events: Event[], from: number) {
  const said = events.slice(from).findLast((e) => e.kind === 'say')
  return said?.kind === 'say' ? { text: said.text, ok: !said.error && !!said.text, stopped: said.error === 'Stopped' } : { text: '', ok: false, stopped: false }
}

// Runs saved flows: each run is a fresh room, steps are sent one after another, and every step
// waits for the room to go quiet, including handoffs and fallbacks, before the next one starts.
export class Flows {
  private timer: NodeJS.Timeout | null = null
  private running = new Map<string, FlowState>()

  constructor(private store: Store, private engine: Engine, private hooks: Hooks) {}

  start() {
    const now = Date.now()
    let changed = false
    for (const f of this.store.flows) {
      // A run missed while the app was closed still happens if it is recent; older ones are skipped.
      if (f.on && f.next && f.next < now - MISSED) { f.next = nextRun(f, now); changed = true }
      if (f.on && f.every && !f.next) { f.next = nextRun(f, now); changed = true }
    }
    if (changed) this.save()
    this.timer = setInterval(() => this.tick(), TICK)
    setTimeout(() => this.tick(), 4000)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  list() {
    return this.store.flows
  }

  states() {
    return [...this.running.values()]
  }

  private save() {
    this.store.saveFlows()
    this.hooks.emit('flows', { flows: this.store.flows, running: this.states() })
  }

  put(input: Partial<Flow> & Pick<Flow, 'name' | 'steps' | 'crew' | 'workspace' | 'access'>): Flow {
    const old = input.id ? this.store.flows.find((f) => f.id === input.id) : undefined
    const steps = input.steps.map((s) => ({ text: s.text.trim(), to: s.to || undefined })).filter((s) => s.text)
    if (!input.name.trim()) throw new Error('The flow needs a name')
    if (!steps.length) throw new Error('The flow needs at least one step')
    if (!input.crew.length) throw new Error('The flow needs at least one agent')
    // Only what the editor edits is taken from it. Its copy of runs and next can be older than
    // ours, since a run may have finished while it was open.
    const { crew, workspace, pack, access, every, at, day } = input
    const flow: Flow = {
      ...old,
      id: old?.id ?? randomUUID().slice(0, 8),
      created: old?.created ?? Date.now(),
      runs: old?.runs ?? [],
      name: input.name.trim(),
      steps, crew, workspace, pack, access, every, at, day,
      on: input.on ?? old?.on ?? true,
    }
    flow.next = flow.on ? nextRun(flow) : undefined
    this.store.flows = old ? this.store.flows.map((f) => (f.id === flow.id ? flow : f)) : [flow, ...this.store.flows]
    this.save()
    return flow
  }

  remove(id: string) {
    this.store.flows = this.store.flows.filter((f) => f.id !== id)
    this.save()
  }

  toggle(id: string, on: boolean) {
    const f = this.store.flows.find((x) => x.id === id)
    if (!f) return
    f.on = on
    f.next = on ? nextRun(f) : undefined
    this.save()
  }

  private tick() {
    const now = Date.now()
    for (const f of this.store.flows) {
      if (f.on && f.next && f.next <= now && !this.running.has(f.id)) this.run(f.id)
    }
  }

  // What the previous run ended with, so a step can compare against it with {{last}}.
  private last(f: Flow) {
    const prev = f.runs[0]?.room
    if (!prev) return undefined
    const said = this.store.events(prev).findLast((e) => e.kind === 'say' && e.text && !e.error)
    return said?.kind === 'say' ? said.text.slice(0, 3000) : undefined
  }

  // Starts a run and returns its room straight away; `done` settles when the last step has.
  run(id: string): { room: string; done: Promise<boolean> } {
    const f = this.store.flows.find((x) => x.id === id)
    if (!f) throw new Error('That flow is gone')
    const busy = this.running.get(id)
    if (busy) return { room: busy.room, done: Promise.resolve(false) }
    const started = Date.now()
    if (f.every) f.next = nextRun(f, started + 60e3)
    const date = new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    const vars: { date: string; last?: string; previous?: string } = { date, last: this.last(f), previous: '' }
    const meta = this.engine.create({
      crew: f.crew, workspace: f.workspace, pack: f.pack, flow: f.id,
      name: `${f.name}, ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
    })
    const state: FlowState = { flow: f.id, room: meta.id, step: 0, of: f.steps.length }
    this.running.set(id, state)
    this.save()

    const run = async () => {
      let ok = false
      for (const [i, step] of f.steps.entries()) {
        state.step = i + 1
        this.hooks.emit('flows', { flows: this.store.flows, running: this.states() })
        const text = (step.to && f.crew.includes(step.to) ? `@${step.to} ` : '') + fill(step.text, vars)
        const from = this.store.events(meta.id).length
        await this.engine.send(meta.id, text, f.access, { from: 'flow' })
        let timer: NodeJS.Timeout | undefined
        const settled = await Promise.race([this.engine.idle(meta.id).then(() => true), new Promise<false>((ok) => { timer = setTimeout(ok, STEP, false) })])
        clearTimeout(timer)
        if (!settled) {
          this.engine.stop(meta.id, `Step ${i + 1} ran for over an hour without finishing, so the flow stopped it.`)
          return false
        }
        const said = stepResult(this.store.events(meta.id), from)
        ok = said.ok
        // Stopping the room stops the flow; the next step would only start the work again.
        if (said.stopped) return false
        // {{last}} is how the last run ended; {{previous}} is what the step before this one answered.
        if (said.text) vars.previous = said.text.slice(0, 3000)
      }
      return ok
    }
    const done = run().catch(() => false).then((ok) => {
      this.running.delete(id)
      const current = this.store.flows.find((x) => x.id === id)
      if (current) current.runs = [{ at: started, room: meta.id, ok, ms: Date.now() - started }, ...current.runs].slice(0, KEEP)
      this.prune(id)
      this.save()
      this.hooks.notify(f.name, ok ? 'Flow finished' : 'Flow needs a look', meta.id)
      return ok
    })
    return { room: meta.id, done }
  }

  // A flow that runs every hour would otherwise leave a new room behind each time, forever.
  // Rooms the person pinned stay.
  private prune(id: string) {
    const rooms = this.store.list().filter((m) => m.flow === id && !m.pinned).sort((a, b) => b.created - a.created)
    for (const m of rooms.slice(KEEP)) this.engine.remove(m.id)
  }
}
