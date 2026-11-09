import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// A whole room against stand-in CLIs: Codex is out of quota, Claude takes over, asks Grok,
// carries on with the answer, and claims passing tests that nothing ran.
test('room: handover, handoff, resume and proof', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'lunchbox-engine-'))
  const bin = join(root, 'bin')
  const agent = join(process.cwd(), 'test', 'fake-agent.mjs')
  chmodSync(agent, 0o755)
  require('node:fs').mkdirSync(bin)
  for (const name of ['claude', 'codex', 'grok']) symlinkSync(agent, join(bin, name))
  process.env.LUNCHBOX_PATH = `${bin}:${process.env.PATH}`
  process.env.FAKE_LOG = join(root, 'calls.jsonl')

  const { Store } = await import('../electron/store')
  const { Engine } = await import('../electron/room/engine')
  const plain = { seal: (t: string) => t, open: (t: string) => t }
  const store = new Store(join(root, 'data'), plain)
  const sent: string[] = []
  const engine = new Engine(store, { emit: (c) => sent.push(c), notify: () => {}, packs: () => [] })
  const agents = await engine.refresh()
  assert.ok(['claude', 'codex', 'grok'].every((id) => agents.find((a) => a.id === id)?.ready))

  store.saveSettings({ route: 'order' })
  const room = engine.create({ crew: ['codex', 'claude', 'grok'], workspace: root })
  engine.send(room.id, 'Find out what people think of agent limits', 'workspace')
  await engine.idle(room.id)

  const events = store.events(room.id)
  const kinds = events.map((e) => e.kind)
  assert.deepEqual(kinds, ['you', 'wall', 'say', 'hands', 'say', 'decide'])

  const wall = events[1] as Extract<typeof events[number], { kind: 'wall' }>
  assert.equal(wall.from, 'codex')
  assert.equal(wall.to, 'claude')
  assert.ok(store.spent.codex.until > Date.now() + 3600e3)

  const hands = events[3] as Extract<typeof events[number], { kind: 'hands' }>
  assert.equal(hands.to, 'grok')
  assert.match(hands.answer, /212 posts/)

  const last = events[4] as Extract<typeof events[number], { kind: 'say' }>
  assert.equal(last.proof?.[0].ok, false)

  const meta = store.room(room.id)!
  assert.equal(meta.name, 'Find out what people think of agent limits')
  assert.ok(meta.blocks.some((b) => b.id === 'brief'))
  assert.ok(meta.blocks.some((b) => b.id.startsWith('answer-')))

  const calls = readFileSync(process.env.FAKE_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(calls.map((c) => c.name), ['codex', 'claude', 'grok', 'claude'])
  assert.ok(calls[0].args.includes('workspace-write'))
  assert.ok(calls[1].input.includes('@grok'), 'claude is told about its crew')
  assert.ok(calls[2].args.includes('--prompt-file'))
  assert.ok(calls[3].args.includes('--resume') && calls[3].args.includes('claude-session'), 'second claude turn resumes')
  assert.ok(!calls[3].input.includes('The conversation so far'), 'resumed turn only gets the delta')

  assert.equal(engine.search('212 posts')[0]?.room, room.id)
  const fork = engine.fork(room.id, events[3].id)!
  assert.equal(store.events(fork.id).length, 4)
  assert.ok(engine.skill(room.id)?.steps.includes('Research'))
  store.flush()
})

// Claude borrows Grok's X search through the room's MCP server, mid-turn, and finishes with it.
test('room: borrowed hands over MCP', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'lunchbox-hands-'))
  const bin = join(root, 'bin')
  const agent = join(process.cwd(), 'test', 'fake-agent.mjs')
  require('node:fs').mkdirSync(bin)
  for (const name of ['claude', 'codex', 'grok']) symlinkSync(agent, join(bin, name))
  process.env.LUNCHBOX_PATH = `${bin}:${process.env.PATH}`

  const { Store } = await import('../electron/store')
  const { Engine } = await import('../electron/room/engine')
  const { Hands } = await import('../electron/hands')
  const hands = new Hands()
  await hands.start()
  const store = new Store(join(root, 'data'), { seal: (t: string) => t, open: (t: string) => t })
  const engine = new Engine(store, { emit: () => {}, notify: () => {}, packs: () => [] }, hands)
  await engine.refresh()

  const room = engine.create({ crew: ['claude', 'grok'], workspace: root })
  engine.send(room.id, '@claude Borrow: what do people on X say about agent limits?', 'workspace')
  await engine.idle(room.id)

  const events = store.events(room.id)
  assert.deepEqual(events.map((e) => e.kind), ['you', 'hands', 'say'])
  assert.equal((events[0] as Extract<typeof events[number], { kind: 'you' }>).cat, 'live')
  const borrowed = events[1] as Extract<typeof events[number], { kind: 'hands' }>
  assert.equal(borrowed.via, 'tool')
  assert.equal(borrowed.from, 'claude')
  assert.equal(borrowed.to, 'grok')
  assert.match(borrowed.ask, /^Search X for: agent limits/)
  const said = events[2] as Extract<typeof events[number], { kind: 'say' }>
  assert.match(said.text, /Grok found: 212 posts/)
  assert.match(said.text, /Tools: ask_crewmate, search_x, search_web, make_image, room_memory, remember/)
  assert.ok(said.acts.some((a) => a.t === 'tool' && a.name === 'mcp__lunchbox__search_x'))

  engine.send(room.id, 'What is trending on X today?', 'workspace')
  await engine.idle(room.id)
  hands.stop()
  const routed = store.events(room.id).filter((e) => e.kind === 'you').at(-1) as Extract<typeof events[number], { kind: 'you' }>
  assert.equal(routed.lead, 'grok', 'live news goes to the agent built for it')
  store.flush()
})

// Checkpoints before each message, a rewind that puts files back, and an undo of the rewind.
test('room: checkpoints, rewind and project memory', { skip: process.platform === 'win32' }, async () => {
  const { writeFileSync, existsSync, readFileSync: read } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'lunchbox-snap-'))
  const work = join(root, 'work')
  require('node:fs').mkdirSync(work)
  const bin = join(root, 'bin')
  require('node:fs').mkdirSync(bin)
  symlinkSync(join(process.cwd(), 'test', 'fake-agent.mjs'), join(bin, 'claude'))
  process.env.LUNCHBOX_PATH = `${bin}:${process.env.PATH}`
  writeFileSync(join(work, 'page.html'), '<h1>v1</h1>')

  const { Store } = await import('../electron/store')
  const { Engine } = await import('../electron/room/engine')
  const { Snapshots } = await import('../electron/snap')
  const store = new Store(join(root, 'data'), { seal: (t: string) => t, open: (t: string) => t })
  const engine = new Engine(store, { emit: () => {}, notify: () => {}, packs: () => [] }, undefined, new Snapshots(join(root, 'snaps')))
  await engine.refresh()
  const room = engine.create({ crew: ['claude'], workspace: work })

  engine.send(room.id, 'Make the heading say hello', 'workspace', { files: [join(work, 'page.html')] })
  await engine.idle(room.id)
  const first = store.events(room.id)[0] as Extract<ReturnType<typeof store.events>[number], { kind: 'you' }>
  assert.deepEqual(first.files, [join(work, 'page.html')])
  assert.equal(store.room(room.id)!.checkpoints?.[0].event, first.id)

  writeFileSync(join(work, 'page.html'), '<h1>hello</h1>')
  writeFileSync(join(work, 'extra.css'), 'h1{}')
  assert.deepEqual((await engine.changedSince(room.id, first.id)).sort(), ['extra.css', 'page.html'])
  const diff = await engine.changesFor(room.id, first.id)
  const page = diff.find((f) => f.path === 'page.html')!
  assert.equal(page.status, 'modified')
  assert.deepEqual([page.added, page.removed], [1, 1])
  assert.match(page.patch, /^-<h1>v1<\/h1>$/m)
  assert.match(page.patch, /^\+<h1>hello<\/h1>$/m)
  assert.equal(diff.find((f) => f.path === 'extra.css')?.status, 'added')

  const r = await engine.rewind(room.id, { event: first.id })
  assert.equal(read(join(work, 'page.html'), 'utf8'), '<h1>v1</h1>')
  assert.ok(!existsSync(join(work, 'extra.css')))
  assert.equal(r.removed, 1)
  await engine.rewind(room.id, { ref: r.undo })
  assert.equal(read(join(work, 'page.html'), 'utf8'), '<h1>hello</h1>')
  assert.ok(existsSync(join(work, 'extra.css')))

  assert.deepEqual(engine.setProject(room.id, true), ['AGENTS.md'])
  assert.match(read(join(work, 'AGENTS.md'), 'utf8'), /Make the heading say hello/)
  engine.setProject(room.id, false)
  assert.equal(read(join(work, 'AGENTS.md'), 'utf8'), '')
  store.flush()
})

// A saved flow runs its steps in order in a room of its own, each step after the last settled.
test('flows: steps run in order and the run is recorded', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'lunchbox-flow-'))
  const bin = join(root, 'bin')
  require('node:fs').mkdirSync(bin)
  for (const name of ['claude', 'grok']) symlinkSync(join(process.cwd(), 'test', 'fake-agent.mjs'), join(bin, name))
  process.env.LUNCHBOX_PATH = `${bin}:${process.env.PATH}`

  const { Store } = await import('../electron/store')
  const { Engine } = await import('../electron/room/engine')
  const { Flows } = await import('../electron/flows')
  const store = new Store(join(root, 'data'), { seal: (t: string) => t, open: (t: string) => t })
  const engine = new Engine(store, { emit: () => {}, notify: () => {}, packs: () => [] })
  await engine.refresh()
  const notes: string[] = []
  const flows = new Flows(store, engine, { emit: () => {}, notify: (_t, body) => notes.push(body) })

  const flow = flows.put({ name: 'Digest', steps: [{ to: 'grok', text: 'What is new on {{date}}?' }, { to: 'claude', text: 'Sum it up. Last time: {{last}}' }], crew: ['claude', 'grok'], workspace: root, access: 'plan', every: 'day', at: '08:00' })
  assert.ok(flow.next && flow.next > Date.now())
  const run = flows.run(flow.id)
  assert.equal(await run.done, true)
  const you = store.events(run.room).filter((e) => e.kind === 'you') as Extract<ReturnType<typeof store.events>[number], { kind: 'you' }>[]
  assert.equal(you.length, 2)
  assert.ok(you[0].text.startsWith('@grok ') && !you[0].text.includes('{{date}}'))
  assert.match(you[1].text, /nothing yet, this is the first run/)
  assert.equal(you[0].from, 'flow')
  assert.equal(store.room(run.room)!.flow, flow.id)
  assert.equal(flows.list()[0].runs[0].ok, true)
  assert.deepEqual(notes, ['Flow finished'])

  const again = flows.run(flow.id)
  await again.done
  const second = store.events(again.room).filter((e) => e.kind === 'you')[1] as Extract<ReturnType<typeof store.events>[number], { kind: 'you' }>
  assert.ok(!second.text.includes('first run'), '{{last}} carries the previous run')
  store.flush()
})
