import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
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

  // The open decision marks the room as waiting and fills the inbox; answering it clears both.
  assert.equal(engine.summaries().find((r) => r.id === room.id)?.waiting, true)
  assert.equal(engine.inbox().find((w) => w.room === room.id)?.items[0]?.kind, 'decide')
  engine.decide(room.id, events[5].id, 0, 'plan')
  assert.equal(engine.summaries().find((r) => r.id === room.id)?.waiting, false)
  assert.equal(engine.inbox().some((w) => w.room === room.id), false)
  await engine.idle(room.id)
  store.flush()
})

// Claude borrows Grok's X search through the room's MCP server, mid-turn, and finishes with it.
test('room: borrowed hands over MCP', { skip: process.platform === 'win32' }, async (t) => {
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
  // A failing assertion must not leave the server open and the run hanging.
  t.after(() => { hands.stop(); delete process.env.FAKE_LOG })
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
  assert.match(said.text, /Tools: ask_crewmate, bring_in, search_x, search_web, make_image, propose_flow, room_memory, remember/)
  assert.ok(said.acts.some((a) => a.t === 'tool' && a.name === 'mcp__lunchbox__search_x'))

  engine.send(room.id, 'What is trending on X today?', 'workspace')
  await engine.idle(room.id)
  const routed = store.events(room.id).filter((e) => e.kind === 'you').at(-1) as Extract<typeof events[number], { kind: 'you' }>
  assert.equal(routed.lead, 'claude', 'the main agent takes every message nobody is named in')

  // The main agent brings Grok in for one task; Grok gets a briefing, not the conversation.
  const log = join(root, 'calls.jsonl')
  process.env.FAKE_LOG = log
  const before = store.events(room.id).length
  engine.send(room.id, 'Bring: get the launch post drafted', 'workspace')
  await engine.idle(room.id)
  const after = store.events(room.id).slice(before)
  assert.deepEqual(after.map((e) => e.kind), ['you', 'joined', 'say', 'left', 'say'])
  const joined = after[1] as Extract<typeof events[number], { kind: 'joined' }>
  assert.deepEqual([joined.by, joined.who, joined.task], ['claude', 'grok', 'Draft the launch post'])
  assert.match((after[4] as Extract<typeof events[number], { kind: 'say' }>).text, /Grok reported: Done: drafted the launch post/)
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const grok = calls.find((c) => c.name === 'grok')
  assert.match(grok.input, /You are joining this room for one task/)
  assert.match(grok.input, /Keep it under 50 words/)
  assert.doesNotMatch(grok.input, /The conversation so far|Since your last turn/, 'a joiner never gets the transcript')
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
  // A file that only held the room's memory is removed along with it.
  assert.equal(existsSync(join(work, 'AGENTS.md')), false)
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

// Side by side: Codex is out, and its slot must not be handed to someone who is already answering.
test('room: a failed side by side slot stays empty', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'lunchbox-arena-'))
  const bin = join(root, 'bin')
  const agent = join(process.cwd(), 'test', 'fake-agent.mjs')
  require('node:fs').mkdirSync(bin)
  for (const name of ['claude', 'codex', 'grok']) symlinkSync(agent, join(bin, name))
  process.env.LUNCHBOX_PATH = `${bin}:${process.env.PATH}`

  const { Store } = await import('../electron/store')
  const { Engine } = await import('../electron/room/engine')
  const store = new Store(join(root, 'data'), { seal: (t: string) => t, open: (t: string) => t })
  const engine = new Engine(store, { emit: () => {}, notify: () => {}, packs: () => [] })
  await engine.refresh()
  const room = engine.create({ crew: ['codex', 'claude', 'grok'], workspace: root })
  engine.send(room.id, 'testing', 'workspace', { arena: true })
  await engine.idle(room.id)

  const events = store.events(room.id)
  const said = events.filter((e) => e.kind === 'say').map((e) => (e as { who: string }).who).sort()
  assert.deepEqual(said, ['claude', 'grok'])
  const wall = events.find((e) => e.kind === 'wall') as Extract<typeof events[number], { kind: 'wall' }>
  assert.equal(wall.from, 'codex')
  assert.equal(wall.to, '')
  assert.ok(wall.arena)
  store.flush()
})

// A message sent while the agent is still working reaches it on its next, resumed turn.
test('room: a message sent mid-turn is not lost', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'lunchbox-heard-'))
  const bin = join(root, 'bin')
  require('node:fs').mkdirSync(bin)
  symlinkSync(join(process.cwd(), 'test', 'fake-agent.mjs'), join(bin, 'claude'))
  process.env.LUNCHBOX_PATH = `${bin}:${process.env.PATH}`
  const log = (process.env.FAKE_LOG = join(root, 'calls.jsonl'))
  process.env.FAKE_DELAY = '20'

  const { Store } = await import('../electron/store')
  const { Engine } = await import('../electron/room/engine')
  const { resetPath } = await import('../electron/system')
  resetPath()
  const store = new Store(join(root, 'data'), { seal: (t: string) => t, open: (t: string) => t })
  const engine = new Engine(store, { emit: () => {}, notify: () => {}, packs: () => [] })
  await engine.refresh()

  const room = engine.create({ crew: ['claude'], workspace: root })
  engine.send(room.id, 'Fix the login bug', 'workspace')
  while (!existsSync(log)) await new Promise((r) => setTimeout(r, 10))
  engine.send(room.id, 'Also update the README', 'workspace')
  assert.deepEqual(engine.live(room.id).queued.map((q) => q.text), ['Also update the README'], 'shown as queued under the live turn')
  assert.equal(store.events(room.id).filter((e) => e.kind === 'you').length, 1, 'and not in the room yet')
  await engine.idle(room.id)
  delete process.env.FAKE_DELAY

  assert.deepEqual(engine.live(room.id).queued, [])
  const said = store.events(room.id).filter((e) => e.kind === 'you' || e.kind === 'say').map((e) => e.kind === 'you' ? e.text : 'reply')
  assert.deepEqual(said, ['Fix the login bug', 'reply', 'Also update the README', 'reply'], 'the transcript keeps the order things were answered in')

  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(calls.length, 2)
  assert.ok(!calls[0].input.includes('Also update the README'), 'the first turn started before the second message')
  assert.ok(calls[1].args.includes('--resume'), 'the second turn resumes')
  assert.ok(calls[1].input.includes('Also update the README'), 'and is given the message sent while it worked')
  store.flush()
})

// Stop ends the turn and drops what was queued behind it; the queued text goes back to the
// message box, never into the room unanswered. Edit takes one queued message back the same way.
test('room: stop and edit hand queued messages back', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'lunchbox-queue-'))
  const bin = join(root, 'bin')
  require('node:fs').mkdirSync(bin)
  symlinkSync(join(process.cwd(), 'test', 'fake-agent.mjs'), join(bin, 'claude'))
  process.env.LUNCHBOX_PATH = `${bin}:${process.env.PATH}`
  const log = (process.env.FAKE_LOG = join(root, 'calls.jsonl'))
  process.env.FAKE_DELAY = '200'

  const { Store } = await import('../electron/store')
  const { Engine } = await import('../electron/room/engine')
  const { resetPath } = await import('../electron/system')
  resetPath()
  const store = new Store(join(root, 'data'), { seal: (t: string) => t, open: (t: string) => t })
  const engine = new Engine(store, { emit: () => {}, notify: () => {}, packs: () => [] })
  await engine.refresh()

  const room = engine.create({ crew: ['claude'], workspace: root })
  engine.send(room.id, 'Fix the login bug', 'workspace')
  while (!existsSync(log)) await new Promise((r) => setTimeout(r, 10))
  engine.send(room.id, 'Then the README', 'workspace')
  engine.send(room.id, 'And the changelog', 'workspace')
  const queued = engine.live(room.id).queued
  assert.equal(queued.length, 2)

  engine.takeBack(room.id, queued[1].id)
  assert.deepEqual(engine.live(room.id).queued.map((q) => q.text), ['Then the README'])
  assert.equal(engine.live(room.id).back?.text, 'And the changelog')

  engine.stop(room.id)
  await engine.idle(room.id)
  delete process.env.FAKE_DELAY
  assert.deepEqual(engine.live(room.id).queued, [])
  assert.equal(engine.live(room.id).back?.text, 'Then the README', 'stop hands the queued message back')
  const asked = store.events(room.id).filter((e) => e.kind === 'you').map((e) => (e as { text: string }).text)
  assert.deepEqual(asked, ['Fix the login bug'], 'nothing queued lands in the room unanswered')
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1, 'and no agent ran for it')
  store.flush()
})

// An agent can offer a flow once per room. Accepting the card creates it with the room's crew
// and folder, and never with full access, since a flow runs with nobody watching.
test('room: a flow is offered once and created from the card', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lunchbox-offer-'))
  const { Store } = await import('../electron/store')
  const { Engine } = await import('../electron/room/engine')
  const store = new Store(join(root, 'data'), { seal: (t: string) => t, open: (t: string) => t })
  const made: unknown[] = []
  const engine = new Engine(store, { emit: () => {}, notify: () => {}, packs: () => [], flow: (f) => { made.push(f); return { ...f, id: 'f1', on: true, created: 0, runs: [] } as never } })
  const room = engine.create({ crew: ['claude', 'codex'], workspace: root, studio: true })
  assert.equal(store.room(room.id)!.studio, true)
  const offer = (engine as unknown as { offerFlow: (r: string, w: string, f: unknown, why: string) => string }).offerFlow.bind(engine)
  const flow = { name: 'Weekly competitor check', steps: [{ text: 'Check what changed on the three competitor sites since {{last}}' }], every: 'week', at: '09:00', day: 1 }
  assert.match(offer(room.id, 'claude', flow, 'Saves the Monday check'), /Offered/)
  assert.match(offer(room.id, 'claude', flow, 'Again'), /already offered/)
  const cards = store.events(room.id).filter((e) => e.kind === 'decide')
  assert.equal(cards.length, 1)
  engine.decide(room.id, cards[0].id, 0, 'full')
  assert.equal(made.length, 1)
  assert.deepEqual({ ...(made[0] as object), steps: undefined }, { name: 'Weekly competitor check', steps: undefined, every: 'week', at: '09:00', day: 1, crew: ['claude', 'codex'], workspace: root, access: 'workspace', pack: undefined })
  assert.ok(store.events(room.id).some((e) => e.kind === 'note' && /Created the flow/.test(e.text)))
  engine.setStudio(room.id, false)
  assert.equal(store.room(room.id)!.studio, undefined)
  store.flush()
})

// Checkpoints leave out build output and very large files, and a stage that fails stops the
// checkpoint, so a rewind never runs without a true copy of the folder first.
test('checkpoints: skip heavy files and refuse to rewind on a failed stage', { skip: process.platform === 'win32' }, async () => {
  const { mkdirSync, readdirSync, truncateSync, writeFileSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  const root = mkdtempSync(join(tmpdir(), 'lunchbox-snapcap-'))
  const work = join(root, 'work')
  mkdirSync(join(work, 'dist'), { recursive: true })
  writeFileSync(join(work, 'app.js'), 'one')
  writeFileSync(join(work, 'dist', 'app.min.js'), 'built')
  // Sparse, so the test takes no real disk space.
  writeFileSync(join(work, 'clip.mov'), '')
  truncateSync(join(work, 'clip.mov'), 26 << 20)
  const { Snapshots } = await import('../electron/snap')
  const snaps = new Snapshots(join(root, 'snaps'))
  const first = await snaps.take(work, 'first')
  assert.ok(first)
  const [repo] = readdirSync(join(root, 'snaps'))
  const git = (...args: string[]) => execFileSync('git', args, { env: { ...process.env, GIT_DIR: join(root, 'snaps', repo), GIT_WORK_TREE: work }, cwd: work }).toString()
  assert.deepEqual(git('ls-tree', '-r', '--name-only', first!.ref).trim().split('\n'), ['app.js'])

  writeFileSync(join(work, 'app.js'), 'two')
  writeFileSync(join(root, 'snaps', repo, 'index.lock'), '')
  assert.equal(await snaps.take(work, 'locked'), null, 'a stage that fails is not committed')
  await assert.rejects(snaps.restore(work, first!.ref), /nothing was changed/)
  assert.equal(readFileSync(join(work, 'app.js'), 'utf8'), 'two')
})

// A limit partway through hands the task on with what was written so far, and a turn that failed
// before any text still leaves its commands in the room.
test('room: a reply cut off by a limit is carried on, and failed turns keep their acts', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'lunchbox-cut-'))
  const bin = join(root, 'bin')
  require('node:fs').mkdirSync(bin)
  for (const name of ['claude', 'codex']) symlinkSync(join(process.cwd(), 'test', 'fake-agent.mjs'), join(bin, name))
  process.env.LUNCHBOX_PATH = `${bin}:${process.env.PATH}`
  process.env.FAKE_LOG = join(root, 'calls.jsonl')
  process.env.FAKE_SCRIPT = 'cut'
  // The login PATH is cached by whichever test looked first; without this a real codex could run.
  ;(await import('../electron/system')).resetPath()
  const { Store } = await import('../electron/store')
  const { Engine } = await import('../electron/room/engine')
  try {
    const store = new Store(join(root, 'data'), { seal: (t: string) => t, open: (t: string) => t })
    const engine = new Engine(store, { emit: () => {}, notify: () => {}, packs: () => [] })
    await engine.refresh()
    store.saveSettings({ route: 'order' })
    const room = engine.create({ crew: ['codex', 'claude'], workspace: root })
    engine.send(room.id, 'Build and deploy the site', 'workspace')
    await engine.idle(room.id)
    const events = store.events(room.id)
    assert.deepEqual(events.slice(0, 3).map((e) => e.kind), ['you', 'say', 'wall'])
    const cut = events[1] as Extract<typeof events[number], { kind: 'say' }>
    assert.match(cut.text, /deploy the$/)
    const calls = readFileSync(process.env.FAKE_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(calls[1].name, 'claude')
    assert.match(calls[1].input, /hit its usage limit partway[\s\S]*Next I will deploy the/)

    delete store.spent.codex
    process.env.FAKE_QUIET = '1'
    const quiet = engine.create({ crew: ['codex', 'claude'], workspace: root })
    engine.send(quiet.id, 'Build it', 'workspace')
    await engine.idle(quiet.id)
    const log = store.events(quiet.id)
    const acts = log[1] as Extract<typeof log[number], { kind: 'say' }>
    assert.equal(acts.kind, 'say')
    assert.equal(acts.text, '')
    assert.ok(acts.acts.some((a) => a.t === 'cmd' && a.command === 'npm run build'), 'the build Codex ran is on the record')
    assert.equal(log[2].kind, 'wall')
    store.flush()
  } finally {
    delete process.env.FAKE_SCRIPT
    delete process.env.FAKE_QUIET
  }
})

// A local model leads and calls a crewmate. The stand-in Ollama answers with an ask line, first
// plain and then dressed up the way small models write it; both must reach the crewmate.
test('room: an Ollama main agent calls a crewmate', { skip: process.platform === 'win32' }, async () => {
  const { createServer } = await import('node:http')
  const { PROVIDERS } = await import('../electron/agents/http')
  const root = mkdtempSync(join(tmpdir(), 'lunchbox-ollama-'))
  const bin = join(root, 'bin')
  require('node:fs').mkdirSync(bin)
  symlinkSync(join(process.cwd(), 'test', 'fake-agent.mjs'), join(bin, 'grok'))
  process.env.LUNCHBOX_PATH = `${bin}:${process.env.PATH}`
  const { resetPath } = await import('../electron/system')
  resetPath()

  let ask = '@grok: what is trending today?'
  const bodies: any[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (b) => (body += b))
    req.on('end', () => {
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'tiny:1b' }] }))
      if (req.url === '/api/show') return res.end(JSON.stringify({ model_info: { 'llama.context_length': 8192 } }))
      const o = JSON.parse(body)
      bodies.push(o)
      // Once the crewmate's answer is in the conversation, the model wraps up.
      const answered = JSON.stringify(o.messages).includes('answering')
      const text = answered ? 'Grok says it is done.' : `Let me ask.\n${ask}`
      res.write(JSON.stringify({ message: { content: text } }) + '\n')
      res.end(JSON.stringify({ done: true, prompt_eval_count: 10, eval_count: 5 }) + '\n')
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const base = PROVIDERS.ollama.base
  PROVIDERS.ollama.base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  try {
    const { Store } = await import('../electron/store')
    const { Engine } = await import('../electron/room/engine')
    const store = new Store(join(root, 'data'), { seal: (t: string) => t, open: (t: string) => t })
    const engine = new Engine(store, { emit: () => {}, notify: () => {}, packs: () => [] })
    const agents = await engine.refresh()
    assert.ok(agents.find((a) => a.id === 'ollama')?.ready, 'the stand-in Ollama counts as ready')
    store.saveSettings({ route: 'order' })

    for (const line of ['@grok: what is trending today?', '- **@grok:** what is trending today?', '> `@grok`: what is trending today?', '### @Grok: what is trending today?']) {
      ask = line
      const room = engine.create({ crew: ['ollama', 'grok'], workspace: root })
      engine.send(room.id, 'Find out what is trending', 'workspace')
      await engine.idle(room.id)
      const hands = store.events(room.id).find((e) => e.kind === 'hands')
      assert.ok(hands && hands.kind === 'hands' && hands.to === 'grok' && hands.from === 'ollama', `"${line}" reaches grok`)
      assert.ok(hands.answer, 'and grok answers')
    }
    assert.equal(bodies[0].options?.num_ctx, 8192, 'Ollama is asked for a window that fits, capped at the model')
  } finally {
    PROVIDERS.ollama.base = base
    server.close()
  }
})

// Claude Code's cost and per model rows run on across resumes. Each turn is recorded on its own,
// and a restart of Lunchbox neither loses the count nor sends the session its rules again.
test('room: resumed turns are counted once each, across a restart', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'lunchbox-meter-'))
  const bin = join(root, 'bin')
  require('node:fs').mkdirSync(bin)
  symlinkSync(join(process.cwd(), 'test', 'fake-agent.mjs'), join(bin, 'claude'))
  process.env.LUNCHBOX_PATH = `${bin}:${process.env.PATH}`
  const log = (process.env.FAKE_LOG = join(root, 'calls.jsonl'))
  process.env.FAKE_RUNNING = join(root, 'running.json')

  const { Store } = await import('../electron/store')
  const { Engine } = await import('../electron/room/engine')
  const { resetPath } = await import('../electron/system')
  resetPath()
  const plain = { seal: (t: string) => t, open: (t: string) => t }
  const open = async () => {
    const store = new Store(join(root, 'data'), plain)
    const engine = new Engine(store, { emit: () => {}, notify: () => {}, packs: () => [] })
    await engine.refresh()
    return { store, engine }
  }
  try {
    let { store, engine } = await open()
    const room = engine.create({ crew: ['claude'], workspace: root })
    for (const text of ['Fix the login bug', 'Now the signup form']) {
      engine.send(room.id, text, 'workspace')
      await engine.idle(room.id)
    }
    store.flush()
    ;({ store, engine } = await open())
    engine.send(room.id, 'And the footer', 'workspace')
    await engine.idle(room.id)
    store.flush()

    const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(calls.length, 3)
    assert.ok(calls[0].input.includes('one of several AI agents'), 'a new session gets the protocol')
    assert.ok(calls[2].args.includes('--resume'), 'the session survives the restart')
    assert.ok(!calls[1].input.includes('one of several AI agents') && !calls[2].input.includes('one of several AI agents'), 'and is not sent its rules again')

    const turns = store.events(room.id).flatMap((e) => (e.kind === 'say' && e.usage ? [e.usage] : []))
    assert.deepEqual(turns.map((u) => Math.round(u.cost * 100)), [1, 1, 1], 'each turn costs what it cost')
    assert.deepEqual(turns.map((u) => u.cached), [14200, 14200, 14200])
    assert.equal(store.room(room.id)?.meters?.claude.rows['claude-sonnet-5-5'][2], 42600, 'the session total is kept with the room')
    const week = store.totals().week.claude
    assert.ok(Math.abs(week.cost - 0.03) < 1e-9, `the ledger adds up to the session's cost, got ${week.cost}`)
    assert.equal(week.cached, 42600)
    // What the reads saved at the Sonnet rates in the price table, once per turn.
    assert.ok(Math.abs((week.gross ?? 0) - (3 * 14200 * 1.8) / 1e6) < 1e-9, `${week.gross}`)
  } finally {
    delete process.env.FAKE_RUNNING
  }
})
