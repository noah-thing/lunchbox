import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudeLike, codex, gemini, limitOf, plain, reason } from '../electron/agents/parse'
import { check } from '../electron/room/proof'
import { prompt } from '../electron/room/context'
import { chat, PROVIDERS } from '../electron/agents/http'
import { cacheSaving, claudeCost } from '../shared/prices'
import { createServer } from 'node:http'
import { pull, suggest } from '../electron/local'
import type { Pull } from '../shared/types'
import { asks, foldChecklists, plan, plansBefore, sincePlan } from '../shared/plan'
import { classify, rating, route, score } from '../shared/route'
import { fill, nextRun } from '../shared/flow'
import { merge, section, strip } from '../electron/room/project'
import { markdown, replay } from '../electron/export'
import { cmdLine, firstPath } from '../electron/system'
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

test('limits: short waits are read in their own unit, not as minutes or an hour', () => {
  const left = (text: string) => limitOf(text)!.until - Date.now()
  assert.ok(left('Rate limit reached for gpt-5. Please try again in 349ms.') < 5000, 'milliseconds')
  assert.ok(Math.abs(left('429 Rate limit reached. Please try again in 20s.') - 20e3) < 5000, 'seconds')
  assert.ok(Math.abs(left('Rate limit reached. Please try again in 1.5s') - 1500) < 5000, 'a fraction of a second')
  assert.ok(Math.abs(left('Rate limit reached. Try again in 6m0s.') - 6 * 60e3) < 5000, 'minutes')
  assert.ok(Math.abs(left('quota exceeded, retry after 30 seconds') - 30e3) < 5000, 'seconds spelled out')
  assert.ok(Math.abs(left('429 Too Many Requests') - 60e3) < 5000, 'a rate limit with no time clears in a minute')
  assert.ok(Math.abs(left('You have hit your usage limit.') - 3600e3) < 5000, 'a used up plan still waits an hour')
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

test('plan: a full list posted again keeps who finished each step', () => {
  const list = (ticks: string) => ['Read the code', 'Build the collector', 'Tests for the collector (Codex)', 'Launch it']
    .map((s, i) => `- [${ticks[i] === 'x' ? 'x' : ' '}] ${s}`).join('\n')
  const crew = [{ id: 'claude', short: 'Claude' }, { id: 'codex', short: 'Codex' }, { id: 'grok', short: 'Grok' }]
  const events = [
    { kind: 'say', who: 'claude', text: list('    '), acts: [] },
    { kind: 'hands', from: 'claude', to: 'grok', ask: 'x', answer: '- [x] Read the code', acts: [] },
    { kind: 'say', who: 'claude', text: list('xxxx'), acts: [] },
  ].map(ev)
  const steps = plan(events, crew)
  assert.deepEqual(steps.map((s) => s.done), [true, true, true, true])
  assert.deepEqual(steps.map((s) => s.who), ['grok', 'claude', 'codex', 'claude'])
  assert.deepEqual(plan(events).map((s) => s.who), ['grok', 'claude', 'claude', 'claude'], 'without a crew only ticks count')
})

test('plan: one message that repeats its checklist counts each step once', () => {
  const list = (t: string) => ['Read', 'Build', 'Test'].map((s, i) => `- [${t[i]}] ${s} the thing`).join('\n')
  const steps = plan([{ kind: 'say', who: 'codex', text: [list('   '), 'Working on it.', list('x  '), list('xx ')].join('\n\n'), acts: [] }].map(ev))
  assert.deepEqual(steps.map((s) => s.done), [true, true, false])
})

test('plan: when a message holds a plan and then a report in other words, the report is the plan', () => {
  const text = ['- [ ] Read the settings layer', '- [ ] Add configuration tests', '- [ ] Run the full suite', '', 'Done.', '',
    '- [x] Added 33 configuration tests in [test_config.py](/home/me/sysmon/tests/test_config.py)', '- [x] Checked the top_process path', '- [x] Ran the full suite: 41 passed'].join('\n')
  const steps = plan([{ kind: 'say', who: 'codex', text, acts: [] }].map(ev))
  assert.deepEqual(steps.map((s) => s.done), [true, true, true])
  const short = text.split('\n').filter((l) => !l.includes('top_process')).join('\n')
  assert.deepEqual(plan([{ kind: 'say', who: 'codex', text: short, acts: [] }].map(ev)).map((s) => s.done), [false, false, false], 'a two line report does not wipe the plan')
})

test('sincePlan: a later message that repeats the plan shows only what it changes', () => {
  const list = (t: string) => ['Read the code', 'Build the page', 'Run the tests'].map((s, i) => `- [${t[i]}] ${s}`).join('\n')
  const events = [
    { kind: 'say', who: 'codex', text: list('   '), acts: [] },
    { kind: 'say', who: 'codex', text: 'Read it.\n\n' + list('x  '), acts: [] },
    { kind: 'say', who: 'codex', text: list('x  '), acts: [] },
    { kind: 'say', who: 'codex', text: '- [x] Build the page\n- [ ] Deploy it', acts: [] },
  ].map(ev)
  const before = plansBefore(events)
  const blocks = (text: string) => text.split('\n\n').map((t) => t.startsWith('- [')
    ? { t: 'list', items: t.split('\n').map((l) => ({ text: l.slice(6), check: l[3] === 'x' })) } : { t: 'p', text: t })
  const show = (i: number) => sincePlan(blocks((events[i] as any).text), (b: any) => b.items, before.get(events[i].id)!)
  assert.equal((show(0)[0] as any).items.length, 3, 'the first post shows the whole plan')
  assert.deepEqual((show(1)[1] as any).items.map((i: any) => i.text), ['Read the code'], 'a repeat shows only the newly ticked step')
  assert.equal(show(2).length, 0, 'a repeat that changes nothing disappears')
  assert.equal(before.get(events[1].id)![0].done, false, 'earlier snapshots never change')
  assert.deepEqual(plan(events).map((s) => [s.text, s.done]), [['Read the code', true], ['Build the page', true], ['Run the tests', false], ['Deploy it', false]])
  const other = sincePlan([{ t: 'list', items: [{ text: 'Buy milk', check: false }, { text: 'Call mum', check: false }] }], (b: any) => b.items, plan(events))
  assert.equal(other.length, 1, 'a different list stays whole')
})

test('foldChecklists: a list posted again updates the first copy in place', () => {
  const list = (...items: [string, boolean][]) => ({ t: 'list', items: items.map(([text, check]) => ({ text, check })) })
  const para = (text: string) => ({ t: 'p', text })
  const fold = (blocks: any[]) => foldChecklists(blocks, (b: any) => b.items)
  const first = list(['Read the data layer', false], ['Add tests', false], ['Run the suite', false])
  const out = fold([first, para('pytest is unavailable'), list(['Read the data layer', true], ['Add tests', false], ['Run the suite', false])])
  assert.equal(out.length, 2, 'the repeat is dropped')
  assert.equal(out[0], first, 'the list stays where it first appeared')
  assert.deepEqual(first.items.map((i) => i.check), [true, false, false])

  const tick = fold([list(['Write the hero section', false], ['Deploy', false]), list(['Write the hero', true])])
  assert.equal(tick.length, 1, 'a short tick line folds into the list')
  assert.equal((tick[0] as any).items[0].check, true)

  const grown = fold([list(['A step one', false], ['B step two', false], ['C step three', false]), list(['A step one', true], ['B step two', true], ['C step three', false], ['D step four', false])])
  assert.equal(grown.length, 1)
  assert.deepEqual((grown[0] as any).items.map((i: any) => i.text), ['A step one', 'B step two', 'C step three', 'D step four'])

  const other = fold([list(['Buy milk', false], ['Call mum', false]), list(['Deploy the site', false], ['Post on X', false])])
  assert.equal(other.length, 2, 'a different checklist stays')
  const plain = fold([{ t: 'list', items: [{ text: 'a note' }, { text: 'another' }] }, { t: 'list', items: [{ text: 'a note' }, { text: 'another' }] }])
  assert.equal(plain.length, 2, 'ordinary bullet lists are never folded')
})

test('asks: only crew handles at line start count', () => {
  const r = asks('Checking.\n@grok: what is trending?\nEmail me@site.com\n@nobody: hi', ['grok', 'codex'])
  assert.deepEqual(r.asks, [{ to: 'grok', ask: 'what is trending?' }])
  assert.equal(r.text, 'Checking.\nEmail me@site.com\n@nobody: hi')
})

test('asks: a comma is talk and a code block is code, neither hands off', () => {
  const text = '@codex, thanks, that fixed it.\n```\n@grok: not an ask\n```\n@grok: what is trending?'
  const r = asks(text, ['grok', 'codex'])
  assert.deepEqual(r.asks, [{ to: 'grok', ask: 'what is trending?' }])
  assert.equal(r.text, '@codex, thanks, that fixed it.\n```\n@grok: not an ask\n```')
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

test('pulling a local model reports the model layer, then ready', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    const lines = [
      { status: 'pulling manifest' },
      { status: 'pulling a1', total: 5000, completed: 2000 },
      { status: 'pulling b2', total: 40, completed: 40 },
      { status: 'pulling a1', total: 5000, completed: 5000 },
      { status: 'success' },
    ]
    res.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()))
  const base = PROVIDERS.ollama.base
  PROVIDERS.ollama.base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  try {
    const seen: Pull[] = []
    await pull('qwen3:8b', (p) => seen.push(p))
    const last = seen[seen.length - 1]
    assert.equal(last.finished, true)
    assert.equal(last.total, 5000, 'a small layer never replaces the model layer')
    assert.equal(last.done, 5000)
    assert.match(suggest().model, /^qwen3:/)
  } finally {
    PROVIDERS.ollama.base = base
    server.close()
  }
})

test('provider JSON errors read as a sentence', () => {
  const raw = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6.1-terra\' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}'
  assert.match(plain(raw), /^its model gpt-6\.1-terra is not available on a ChatGPT plan/)
  assert.equal(plain('{"error":{"message":"Overloaded"}}'), 'Overloaded')
  assert.equal(plain('plain words stay'), 'plain words stay')
})

// The Savings page is only as true as these numbers, so they are checked against a real turn.
test('savings: Claude Code turn is priced exactly like Anthropic bills it', () => {
  const { turn } = feed(claudeLike(), fixture('claude'))
  const u = turn.usage
  assert.equal(u.cached, 51804)
  assert.equal(u.written, 29259)
  assert.equal(u.input, 4 + 29259, 'input counts what was billed in full, writes included')
  // Our price table rebuilds Claude Code's own cost for the call to the cent fraction.
  const ours = claudeCost('claude-haiku-5-5', { input: 4, read: 51804, output: 398, short: 29259 })!
  assert.ok(Math.abs(ours - u.cost) < 1e-6, `${ours} vs ${u.cost}`)
  // Saved: 51804 reads at $0.09 off each million, minus a quarter of $0.10 on 29259 writes.
  assert.ok(Math.abs((u.saved ?? 0) - (51804 * 0.09 - 29259 * 0.025) / 1e6) < 1e-9)
})

test('savings: hour long cache writes cost double, not a quarter extra', () => {
  const short = cacheSaving('claude-sonnet-5-5', 100000, { short: 20000 })!
  const hour = cacheSaving('claude-sonnet-5-5', 100000, { short: 0, hour: 20000 })!
  assert.ok(Math.abs(short - (100000 * 1.8 - 20000 * 0.5) / 1e6) < 1e-9)
  assert.ok(Math.abs(hour - (100000 * 1.8 - 20000 * 2) / 1e6) < 1e-9)
  assert.equal(cacheSaving('gpt-6', 100000, 0), null, 'unknown prices stay in tokens')
})

test('savings: Gemini CLI cached tokens are not counted twice', () => {
  const p = gemini()
  p.line({ type: 'result', status: 'success', stats: { total_tokens: 1300, input_tokens: 1200, output_tokens: 100, cached: 800, input: 400 } })
  assert.deepEqual([p.turn.usage.input, p.turn.usage.cached], [400, 800])
  const q = gemini()
  q.line({ type: 'result', status: 'success', stats: { input_tokens: 1200, output_tokens: 100, cached: 800 } })
  assert.equal(q.turn.usage.input, 400)
})

test('savings: the ledger sums per day, per agent and per room', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { Store } = await import('../electron/store')
  const store = new Store(mkdtempSync(join(tmpdir(), 'lb-ledger-')), { seal: (t: string) => t, open: (t: string) => t })
  store.record('claude', 'r1', { input: 1000, output: 50, cached: 9000, cost: 0.01, written: 1000, saved: 0.02, kept: 300 })
  store.record('claude', 'r2', { input: 500, output: 20, cached: 4000, cost: 0.005, saved: 0.01 })
  store.record('grok', 'r1', { input: 700, output: 10, cached: 300, cost: 0.002 })
  const t = store.totals()
  const today = t.days[t.days.length - 1]
  assert.equal(t.days.length, 14)
  const now = new Date()
  assert.equal(today.day, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`, 'days are local dates')
  assert.deepEqual([today.input, today.cached, today.kept], [2200, 13300, 300])
  assert.ok(Math.abs(today.saved - 0.03) < 1e-12)
  assert.deepEqual([t.week.claude.cached, t.week.claude.kept, t.week.grok.cached], [13000, 300, 300])
  assert.ok(Math.abs((t.rooms.r1.saved ?? 0) - 0.02) < 1e-12)
  assert.equal(t.rooms.r1.input, 1700)
})

test('plan limits: windows are sized in cost per percent, trusting the upper measurements', async () => {
  const { windowSize, roughSize } = await import('../electron/limits')
  const w = (start: number, pts: [number, number][]) => pts.map(([pct, units], i) => ({ at: start + i * 60e3, pct, units, start }))
  // Three clean windows of about 120 credits and one where another computer used the plan,
  // which made the percentage climb with fewer credits here.
  const readings = [
    ...w(1, [[2, 2.4], [30, 36]]),
    ...w(2, [[0, 0], [50, 61]]),
    ...w(3, [[10, 12], [40, 47]]),
    ...w(4, [[5, 3], [60, 20]]),
  ]
  const size = windowSize(readings, 8)!
  assert.ok(size > 115 && size < 125, `about 120 credits, got ${size}`)
  assert.equal(windowSize(w(5, [[1, 1], [3, 3]]), 8), undefined, 'too little movement to trust')
  assert.equal(roughSize(30, 25), 120)
  assert.equal(roughSize(10, 0), undefined)
})

test('plan limits: Codex credits follow the published rates per model', async () => {
  const { codexCredits } = await import('../shared/prices')
  assert.equal(codexCredits('gpt-6-astra', { fresh: 1e6, cached: 0, output: 0 }), 250)
  assert.equal(codexCredits('gpt-6.1-terra', { fresh: 0, cached: 1e6, output: 1e6 }), 1.25 + 125)
  assert.equal(codexCredits('some-new-model', { fresh: 1e6, cached: 0, output: 0 }), 50, 'unlisted models count like GPT-6 Sol')
})

test('plan limits: tallies read logs once and pick up only what was added', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'lb-tally-'))
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
  mkdirSync(join(home, '.claude', 'projects', 'p'), { recursive: true })
  const file = join(home, '.claude', 'projects', 'p', 's.jsonl')
  const line = (id: string, at: string, u: object) => JSON.stringify({ type: 'assistant', timestamp: at, requestId: 'r' + id, message: { id, usage: u } }) + '\n'
  const t = new Date().toISOString()
  writeFileSync(file, line('a', t, { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000, output_tokens: 20 }) + line('a', t, { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000, output_tokens: 20 }))
  const { update, used } = await import('../electron/tally')
  const tally = { files: {} }
  await update('claude', tally, Date.now() - 3600e3)
  const u = used(tally, Date.now() - 3600e3)
  assert.deepEqual([u.all, u.fresh], [5130, 130], 'a message written twice counts once')
  assert.ok(u.units > 0, 'priced at list rates')
  appendFileSync(file, line('b', t, { input_tokens: 5, output_tokens: 5 }))
  await update('claude', tally, Date.now() - 3600e3)
  assert.equal(used(tally, Date.now() - 3600e3).fresh, 140)
  delete process.env.CLAUDE_CONFIG_DIR
})

test('claude: subagents get their own rows and never leak into the answer', () => {
  const parser = claudeLike()
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Splitting this up.' }, { type: 'tool_use', id: 't1', name: 'Task', input: { description: 'Read the auth code', prompt: 'Find where tokens are checked', subagent_type: 'Explore', model: 'haiku' } }, { type: 'tool_use', id: 't2', name: 'Agent', input: { prompt: 'Write the tests\nfor the parser' } }] } },
    { type: 'assistant', parent_tool_use_id: 't1', message: { content: [{ type: 'text', text: 'SUBAGENT TEXT' }, { type: 'tool_use', id: 's1', name: 'Grep', input: { pattern: 'verifyToken' } }] } },
    { type: 'user', parent_tool_use_id: 't1', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'src/auth.ts:12' }] } },
    { type: 'stream_event', parent_tool_use_id: 't1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'MORE SUBAGENT TEXT' } } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Tokens are checked in src/auth.ts line 12.' }] }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'Stopped' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: ' Done.' }] } },
  ]
  const updates = lines.map((l) => parser.line(l))
  assert.equal(parser.turn.text, 'Splitting this up. Done.', 'nothing a subagent says reaches the answer')
  const rows = updates.flatMap((u) => u?.agents ?? [])
  assert.deepEqual(rows.filter((r) => r.state === 'running' && r.tools === 0).map((r) => r.task), ['Read the auth code', 'Write the tests'], 'both rows appear as soon as they start')
  const moving = rows.find((r) => r.id === 't1' && r.tools === 1)
  assert.equal(moving?.last, 'Grep verifyToken', 'a row shows the tool its subagent is on')
  const ended = parser.turn.acts.filter((a) => a.t === 'agent')
  assert.deepEqual(ended.map((a) => a.t === 'agent' && [a.id, a.state, a.kind, a.model]), [['t1', 'done', 'Explore', 'haiku'], ['t2', 'failed', undefined, undefined]])
  assert.equal(ended[0].t === 'agent' && ended[0].note, 'Tokens are checked in src/auth.ts line 12.')
  assert.ok(!parser.turn.acts.some((a) => a.t === 'tool'), 'the subagent calls are not listed as plain tool calls')
})

test('prices: Fable 5.2 at its own rates, not 5.1', async () => {
  const { claudePrice } = await import('../shared/prices')
  assert.deepEqual(claudePrice('claude-fable-5-2'), { input: 8, read: 0.2, output: 40 })
  assert.deepEqual(claudePrice('claude-fable-5-1'), { input: 10, read: 0.25, output: 50 })
  assert.deepEqual(claudePrice('claude-mythos-5-2'), { input: 8, read: 0.2, output: 40 })
})

test('connectors wear their product logo, or a terminal or server', async () => {
  const { logoOf } = await import('../shared/logos')
  assert.equal(logoOf({ kind: 'openai', base: 'https://api.groq.com/openai/v1' }), 'groq')
  assert.equal(logoOf({ kind: 'cli', command: '/usr/local/bin/aider --yes' }), 'aider')
  assert.equal(logoOf({ kind: 'cli', command: 'cursor-agent' }), 'cursor')
  assert.equal(logoOf({ kind: 'cli', command: 'my-tool' }), 'terminal')
  assert.equal(logoOf({ kind: 'openai', base: 'http://10.0.0.2:9000/v1' }), 'server')
  assert.equal(logoOf({ kind: 'anthropic', base: 'https://gateway.example.com' }), 'claude')
})

test('briefing: brief always kept, newest memory first, no transcript, only changes when resumed', async () => {
  const { briefing } = await import('../electron/room/context')
  const block = (id: string, text: string, v = 1) => ({ id, title: id, text, v, at: 0 })
  const meta = { id: 'r', name: 'r', created: 0, updated: 0, crew: ['claude', 'codex'], workspace: '/w', sessions: {}, seen: { codex: { brief: 1, old: 1 } }, heard: {}, saved: { full: 0, sent: 0 },
    blocks: [block('brief', 'Build the page'), block('old', 'x'.repeat(3990)), block('a', 'y'.repeat(3990)), block('b', 'z'.repeat(3990)), block('c', 'w'.repeat(3990)), block('newest', 'fresh finding', 2)] }
  const events = [{ id: '1', at: 0, kind: 'you' as const, text: 'Make the hero darker' }, { id: '2', at: 0, kind: 'say' as const, who: 'claude', text: 'SECRET TRANSCRIPT LINE', acts: [] }]
  const p = briefing(meta, events, 'codex', 'Do the task')
  assert.match(p.text, /## brief\nBuild the page/)
  assert.match(p.text, /fresh finding/, 'the newest block survives the cap')
  assert.doesNotMatch(p.text, /## old\n/, 'the oldest block is the one dropped')
  assert.doesNotMatch(p.text, /SECRET TRANSCRIPT LINE/)
  assert.match(p.text, /Make the hero darker/)
  const again = briefing(meta, events, 'codex', 'Do the task', true)
  assert.doesNotMatch(again.text, /## brief\n/, 'a resumed session is not sent what it already has')
  assert.match(again.text, /fresh finding/)
  const follow = briefing(meta, events, 'codex', 'Reply', false, ['Claude: here is the draft'])
  assert.match(follow.text, /The last few lines of the room:\n\nClaude: here is the draft/)
})

test('which: only real paths count, never where.exe telling us it found nothing', () => {
  assert.equal(firstPath('INFO: Could not find files for the given pattern(s).\r\n', true), '')
  const npm = 'C:\\Users\\me\\AppData\\Roaming\\npm'
  assert.equal(firstPath(`${npm}\\claude\r\n${npm}\\claude.cmd\r\n`, true), `${npm}\\claude.cmd`)
  assert.equal(firstPath('\\\\server\\share\\tool.exe\r\n', true), '\\\\server\\share\\tool.exe')
  assert.equal(firstPath('/usr/local/bin/codex\n', false), '/usr/local/bin/codex')
  assert.equal(firstPath('echo\n', false), '', 'a shell builtin has no path to start')
})

// What cmd.exe does to one line: a caret makes the next character plain, and any special
// character left bare would split the command, redirect it or open a quoted stretch.
function cmdParse(s: string) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '^') out += s[++i]
    else if (/[&|<>()"%!]/.test(s[i])) throw new Error(`bare ${s[i]} in ${s}`)
    else out += s[i]
  }
  return out
}

// How a C runtime program splits what reaches it.
function argv(s: string) {
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    while (s[i] === ' ') i++
    if (i >= s.length) break
    let cur = ''
    let quoted = false
    while (i < s.length && (quoted || s[i] !== ' ')) {
      if (s[i] === '\\') {
        let n = 0
        while (s[i] === '\\') { n++; i++ }
        if (s[i] === '"') { cur += '\\'.repeat(n >> 1); if (n % 2) { cur += '"'; i++ } } else cur += '\\'.repeat(n)
      } else if (s[i] === '"') { quoted = !quoted; i++ } else cur += s[i++]
    }
    out.push(cur)
  }
  return out
}

test('cmdLine: arguments reach a .cmd shim intact through both of cmd.exe\'s passes', () => {
  const args = [
    'he said "hi & bye"', '100% %PATH% !USERNAME!', 'a|b<c>d^e', 'C:\\path with space\\', 'ends\\\\', '', '(x) ; , = * ?',
    'mcp_servers.lunchbox.url="http://127.0.0.1:4000/mcp"', 'Jöran ✓', '\\"', '-p',
  ]
  const line = cmdLine('claude.cmd', args)
  // First the line cmd.exe is given, then the %* the shim passes on.
  const shim = cmdParse(line)
  assert.ok(shim.startsWith('claude.cmd '))
  assert.deepEqual(argv(cmdParse(shim.slice('claude.cmd '.length))), args)
  assert.equal(cmdLine('C:\\Program Files\\nodejs\\npx.cmd', []), 'C:\\Program^ Files\\nodejs\\npx.cmd')
})
