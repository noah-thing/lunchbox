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
