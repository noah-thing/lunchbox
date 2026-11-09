import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudeLike, codex, limitOf, reason } from '../electron/agents/parse'
import { check } from '../electron/room/proof'
import { prompt } from '../electron/room/context'
import { chat, PROVIDERS } from '../electron/agents/http'
import { cacheSaving } from '../shared/prices'
import { createServer } from 'node:http'
import { asks, plan } from '../shared/plan'
import { classify, rating, route, score } from '../shared/route'
import { fill, nextRun } from '../shared/flow'
import { merge, section, strip } from '../electron/room/project'
import { markdown, replay } from '../electron/export'
import type { Event, RoomMeta } from '../shared/types'

const fixture = (name: string) =>
  readFileSync(join(process.cwd(), 'test', 'fixtures', `${name}.jsonl`), 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))

function feed(parser: ReturnType<typeof claudeLike>, lines: unknown[]) {
  let streamed = ''
  for (const l of lines) streamed += parser.line(l)?.delta ?? ''
  return { turn: parser.turn, streamed }
}

test('claude: streams text, pairs tool calls with results, reads usage and session', () => {
  const { turn, streamed } = feed(claudeLike(), fixture('claude'))
  assert.ok(turn.session, 'session id')
  assert.ok(streamed.length > 0, 'text deltas')
  assert.ok(turn.final.length > 0, 'final result text')
  assert.ok(turn.acts.length > 0, 'tool activity')
  assert.ok(turn.usage.output > 0 && turn.usage.cost > 0, 'usage')
  assert.equal(turn.error, undefined)
})

test('grok: same shape as claude without partial deltas', () => {
  const { turn, streamed } = feed(claudeLike(), fixture('grok'))
  assert.ok(turn.session)
  assert.ok(streamed.length > 0)
  assert.ok(turn.acts.some((a) => a.t === 'cmd'), 'terminal command recorded')
  assert.ok(turn.usage.cost > 0)
})

test('codex: commands keep their exit codes, file changes become edits', () => {
  const p = codex()
  for (const l of fixture('codex')) p.line(l)
  const cmds = p.turn.acts.filter((a) => a.t === 'cmd')
  assert.ok(cmds.length > 0)
  assert.ok(cmds.every((a) => a.t === 'cmd' && typeof a.exit === 'number' && !a.command.includes("-lc '")), 'shell wrapper removed')
  assert.ok(p.turn.acts.some((a) => a.t === 'edit'))
  assert.ok(p.turn.usage.input > 0)
  assert.equal(p.turn.session, fixture('codex')[0].thread_id)
})

test('codex: warnings do not end a turn, failures do', () => {
  const p = codex()
  p.line({ type: 'item.completed', item: { type: 'error', message: 'Model metadata not found' } })
  assert.equal(p.turn.error, undefined)
  p.line({ type: 'turn.failed', error: { message: 'boom' } })
  assert.equal(p.turn.error, 'boom')
})

test('limits are recognised with their reset times', () => {
  assert.equal(limitOf('Everything is fine'), null)
  const epoch = limitOf('Claude AI usage limit reached|1900000000')
  assert.equal(epoch?.until, 1900000000 * 1000)
  const inTwo = limitOf("You've hit your usage limit. Try again in 2 hours.")!
  assert.ok(Math.abs(inTwo.until - Date.now() - 2 * 3600e3) < 5000)
  const at = limitOf('5-hour limit reached, resets 3pm')!
  assert.equal(new Date(at.until).getHours(), 15)
})

test('stderr is reduced to the line that matters', () => {
  const err = 'Error: This client is no longer supported. Please migrate.\n    at throwIneligible (file:///x.js:1:1)\n    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)'
  assert.equal(reason(err), 'This client is no longer supported. Please migrate.')
})

const ev = (e: Record<string, unknown>, i: number) => ({ id: `e${i}`, at: i, ...e }) as Event

test('proof: a claim needs a passing command after the last edit', () => {
  const edited = { kind: 'say', who: 'codex', text: '', acts: [{ t: 'edit', path: 'a.ts', change: 'edit' }] }
  const tested = (exit: number) => ({ kind: 'say', who: 'codex', text: '', acts: [{ t: 'cmd', command: 'npm test', exit }] })
  assert.equal(check('All tests pass.', [edited, tested(0)].map(ev))[0].ok, true)
  assert.equal(check('All tests pass.', [tested(0), edited].map(ev))[0].ok, false)
  assert.equal(check('The tests are passing now', [edited, tested(1)].map(ev))[0].ok, false)
  assert.equal(check('Done, looks good.', [edited].map(ev)).length, 0)
  const run = { kind: 'run', who: 'you', command: 'npm run build', cwd: '/', verdict: { kind: 'write', decision: 'allow', reason: '' }, code: 0, ms: 1, out: '', how: 'auto' }
  assert.equal(check('The build succeeds.', [edited, run].map(ev))[0].ok, true)
})

test('plan: newest checklist wins and later ticks close steps', () => {
  const events = [
    { kind: 'say', who: 'claude', text: '- [ ] Research the market\n- [ ] Build the page\n- [ ] Deploy', acts: [] },
    { kind: 'hands', from: 'claude', to: 'grok', ask: 'x', answer: '- [x] Research', acts: [] },
  ].map(ev)
  const steps = plan(events)
  assert.deepEqual(steps.map((s) => s.done), [true, false, false])
  assert.equal(steps[0].who, 'grok')
})

test('asks: only crew handles at line start count', () => {
  const r = asks('Checking.\n@grok: what is trending?\nEmail me@site.com\n@nobody: hi', ['grok', 'codex'])
  assert.deepEqual(r.asks, [{ to: 'grok', ask: 'what is trending?' }])
  assert.equal(r.text, 'Checking.\nEmail me@site.com\n@nobody: hi')
})

test('context: a resumed agent only gets what changed', () => {
  const meta: RoomMeta = {
    id: 'r', name: 'Room', created: 0, updated: 0, crew: ['claude'], workspace: '/tmp', sessions: {}, heard: { claude: 1 },
    seen: { claude: { brief: 1 } }, saved: { full: 0, sent: 0 },
    blocks: [{ id: 'brief', title: 'Brief', text: 'Make a site', v: 1, at: 0 }, { id: 'files', title: 'Changed files', text: 'a.ts', v: 1, at: 0 }],
  }
  const events = [{ kind: 'you', text: 'Make a site' }, { kind: 'you', text: 'Make it blue' }].map(ev)
  const p = prompt(meta, events, 'claude', 'Go.', (id) => id, true)
  assert.ok(!p.text.includes('Make a site'))
  assert.ok(p.text.includes('Make it blue') && p.text.includes('Changed files'))
  assert.ok(p.sent < p.full)
})

test('context: an agent without a session gets the whole memory every turn', () => {
  const meta: RoomMeta = {
    id: 'r', name: 'Room', created: 0, updated: 0, crew: ['claude-api'], workspace: '/tmp', sessions: {}, heard: {},
    seen: { 'claude-api': { brief: 1 } }, saved: { full: 0, sent: 0 },
    blocks: [{ id: 'brief', title: 'Brief', text: 'Make a site', v: 1, at: 0 }],
  }
  const p = prompt(meta, [ev({ kind: 'you', text: 'Go on' })], 'claude-api', 'Go.', (id) => id, false)
  assert.ok(p.tail.includes('Make a site'), 'a stateless agent must not lose the brief')
  assert.equal(p.sent, p.full)
})

test('context: the conversation stays a stable prefix from turn to turn, even past the window', () => {
  const meta: RoomMeta = { id: 'r', name: 'Room', created: 0, updated: 0, crew: ['claude-api'], workspace: '/tmp', sessions: {}, heard: {}, seen: {}, saved: { full: 0, sent: 0 }, blocks: [] }
  const events: Event[] = []
  let kept = 0, turns = 0, previous: string[] = []
  for (let i = 0; i < 120; i++) {
    events.push(ev({ kind: 'you', text: `Message ${i} ` + 'words '.repeat(80) }))
    const { history } = prompt(meta, events, 'claude-api', 'Go.', (id) => id, false)
    if (previous.length) {
      turns++
      if (previous.every((l, j) => history[j] === l)) kept++
    }
    previous = history
  }
  // Past the window the start moves in steps, so nearly every turn can read its prefix from cache.
  assert.ok(kept / turns > 0.85, `prefix kept on ${kept} of ${turns} turns`)
})

test('cache: Anthropic requests carry a breakpoint on the last history block and report the saving', async () => {
  let body: any = null
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      body = JSON.parse(raw)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":40,"cache_read_input_tokens":10000,"cache_creation_input_tokens":200}}}',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Done."}}',
        'data: {"type":"message_delta","usage":{"output_tokens":3}}',
        '',
      ].join('\n\n'))
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()))
  const base = PROVIDERS.anthropic.base
  PROVIDERS.anthropic.base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const r = await chat('anthropic', 'k', 'claude-opus-5-5', 'Rules', 'Memory and task', AbortSignal.timeout(5000), () => {}, ['Head', 'Person: one', 'Claude: two'], 'r:claude-api')
    const blocks = body.messages[0].content
    assert.equal(blocks.length, 4)
    assert.deepEqual(blocks[2].cache_control, { type: 'ephemeral' }, 'breakpoint on the last history block')
    assert.equal(blocks[3].cache_control, undefined, 'the changing part is never cached')
    assert.equal(blocks[3].text, 'Memory and task')
    assert.equal(r.usage.cached, 10000)
    assert.equal(r.usage.written, 200)
    assert.equal(r.usage.saved, cacheSaving('claude-opus-5-5', 10000, 200))
    assert.ok((r.usage.saved ?? 0) > 0.03)
  } finally {
    PROVIDERS.anthropic.base = base
    server.close()
  }
})

test('cache: savings are only priced for models with a known price', () => {
  assert.equal(cacheSaving('gpt-unknown', 1000, 0), null)
  assert.ok((cacheSaving('claude-sonnet-5-5', 1_000_000, 0) ?? 0) > 1.7)
  assert.ok((cacheSaving('claude-sonnet-5-5', 0, 1_000_000) ?? 0) < 0, 'a cold write costs extra')
})

test('route: messages are sorted into kinds of work', () => {
  assert.equal(classify('What are people saying on X about the launch today?'), 'live')
  assert.equal(classify('Fix the failing test in the auth module'), 'code')
  assert.equal(classify('Draft a newsletter about our spring release'), 'writing')
  assert.equal(classify('hello there'), 'general')
})

test('route: the best rated free agent leads, kept answers move ratings', () => {
  assert.equal(route({}, 'live', [{ id: 'claude', paid: false }, { id: 'grok', paid: false }]), 'grok')
  assert.equal(route({}, 'code', [{ id: 'codex', paid: false }, { id: 'claude', paid: false, budgetLeft: 0.9 }]), 'codex')
  assert.equal(route({}, 'code', [{ id: 'codex', paid: false, budgetLeft: 0.1 }, { id: 'claude', paid: false }]), 'claude')
  let r = {}
  for (let i = 0; i < 3; i++) r = score(r, 'code', 'claude', ['claude', 'codex'])
  assert.ok(rating(r, 'code', 'claude').r > rating(r, 'code', 'codex').r)
  assert.equal(rating(r, 'code', 'claude').n, 3)
  assert.equal(route(r, 'code', [{ id: 'codex', paid: false }, { id: 'claude', paid: false }]), 'claude')
})

test('flows: schedules land on the next matching local time', () => {
  const mon = new Date(2026, 10, 9, 10, 0).getTime()
  const at = (t?: number) => (t ? new Date(t) : null)
  assert.equal(at(nextRun({ every: 'day', at: '09:00' }, mon))?.getDate(), 10)
  assert.equal(at(nextRun({ every: 'day', at: '11:30' }, mon))?.getHours(), 11)
  const fri = new Date(2026, 10, 13, 18, 0).getTime()
  assert.equal(at(nextRun({ every: 'weekday', at: '09:00' }, fri))?.getDay(), 1)
  assert.equal(at(nextRun({ every: 'week', day: 3, at: '08:00' }, mon))?.getDay(), 3)
  const hour = at(nextRun({ every: 'hour', at: '00:15' }, mon))!
  assert.deepEqual([hour.getHours(), hour.getMinutes()], [10, 15])
  assert.equal(nextRun({}, mon), undefined)
  assert.equal(fill('On {{date}} after {{ last }}', { date: 'Monday' }), 'On Monday after nothing yet, this is the first run')
})

test('project memory: one section, rewritten in place and removable', () => {
  const meta = {
    id: 'r', name: 'Launch', created: 0, updated: 0, crew: [], workspace: '/tmp', sessions: {}, seen: {}, heard: {}, saved: { full: 0, sent: 0 },
    blocks: [{ id: 'brief', title: 'Brief', text: 'Ship the launch page', v: 1, at: 1 }, { id: 'decisions', title: 'Decisions', text: '- Blue, not green', v: 1, at: 2 }],
  } as RoomMeta
  const own = '# Project\n\nRun npm test before pushing.\n'
  const once = merge(own, section(meta))
  assert.ok(once.startsWith(own.trim()) && once.includes('Ship the launch page') && once.includes('Blue, not green'))
  meta.blocks[0].text = 'Ship the pricing page'
  const twice = merge(once, section(meta))
  assert.equal(twice.match(/<!-- lunchbox:memory -->/g)?.length, 1)
  assert.ok(twice.includes('pricing') && !twice.includes('launch page'))
  assert.equal(strip(twice), own)
})

test('export: markdown and a self contained replay', () => {
  const meta = { id: 'r', name: 'Limits <check>', created: 0, updated: 0, crew: ['claude', 'grok'], workspace: '/tmp', sessions: {}, seen: {}, heard: {}, blocks: [], saved: { full: 0, sent: 0 } } as RoomMeta
  const events = [
    { id: '1', at: 1000, kind: 'you', text: 'What do people say?' },
    { id: '2', at: 5000, kind: 'hands', from: 'claude', to: 'grok', ask: 'search X', answer: '212 posts', acts: [], via: 'tool' },
    { id: '3', at: 9000, kind: 'say', who: 'claude', text: 'Mostly **limits**. Run `npm test`.', acts: [{ t: 'cmd', command: 'npm test', exit: 0 }] },
  ] as Event[]
  const name = (id: string) => ({ claude: 'Claude', grok: 'Grok' })[id] ?? id
  const md = markdown(meta, events, name)
  assert.match(md, /\*\*Claude:\*\* Mostly/)
  assert.match(md, /> \*\*Claude asked Grok:\*\* search X/)
  const html = replay(meta, events, name)
  assert.ok(html.includes('Limits &lt;check&gt;') && !html.includes('<check>'))
  assert.ok(html.includes('<b>limits</b>') && html.includes('<code>npm test</code>'))
  assert.equal(html.match(/<section /g)?.length, 3)
  assert.ok(!/src="http|href="http[^"]*\.css/.test(html), 'nothing is fetched')
})
