import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudeLike, codex, gemini, limitOf, plain, reason } from '../electron/agents/parse'
import { wallWhy } from '../shared/wall'
import { check } from '../electron/room/proof'
import { prompt } from '../electron/room/context'
import { chat, listModels, parseHeaders, PROVIDERS } from '../electron/agents/http'
import { cacheSaving, claudeCost, codexSaving, costSaving, rates, readSaving } from '../shared/prices'
import { clean, logs, NATIVE, trim } from '../electron/room/trim'
import { Hands, wrap } from '../electron/hands'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { pull, suggest } from '../electron/local'
import type { Pull } from '../shared/types'
import { asks, foldChecklists, plan, plansBefore, sincePlan } from '../shared/plan'
import { canReplace, parseFeed, pick } from '../electron/macfeed'
import { classify, rating, route, score } from '../shared/route'
import { fill, nextRun } from '../shared/flow'
import { merge, section, strip } from '../electron/room/project'
import { markdown, replay } from '../electron/export'
import { cmdLine, firstPath } from '../electron/system'
import { sentence, stepOf } from '../shared/steps'
import { cut, weave } from '../shared/weave'
import { testConnector } from '../electron/agents'
import type { Event, RoomMeta } from '../shared/types'
import { shift, side } from '../src/lib/fit'
import { evict } from '../shared/tabs'

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

test('claude: thinking, a file being written and retries show as they happen', () => {
  const p = claudeLike()
  const se = (event: unknown) => p.line({ type: 'stream_event', event })
  assert.equal(p.line({ type: 'system', subtype: 'status', status: 'requesting' })?.working, '~Thinking')
  assert.equal(se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })?.working, '~Thinking')
  p.line({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 400, estimated_tokens_delta: 400 })
  assert.equal(p.line({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 900, estimated_tokens_delta: 500 })?.tokens, 900)
  assert.equal(se({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Write', input: {} } })?.working, 'Write')
  assert.equal(se({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path": "/Users/a/site/src/pa' } })?.working, 'Write')
  const u = se({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ge.html", "content": "<h1>' + 'x'.repeat(400) } })
  assert.equal(u?.working, 'Write /Users/a/site/src/page.html')
  assert.ok((u?.tokens ?? 0) > 1000, 'tool input counts as written')
  assert.deepEqual(stepOf(u!.working!), { verb: 'Writing', text: '…/site/src/page.html' })
  assert.equal(se({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } })?.working, '')
  assert.equal(p.line({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10 })?.working, '~Reconnecting, try 2 of 11')
  assert.equal(sentence('Claude', '~Thinking'), 'Claude is thinking')
  assert.equal(sentence('Codex', '~Fix plan'), 'Codex: Fix plan')
  assert.equal(sentence('Claude', 'Grep useSmooth'), 'Claude is searching the code for useSmooth')
})

test('codex: a reasoning summary becomes the step it is on', () => {
  const p = codex()
  assert.equal(p.line({ type: 'item.completed', item: { type: 'reasoning', text: '**Inspecting the build script**\n\nI need to see how...' } })?.working, '~Inspecting the build script')
})

test('help asked for mid-turn reads inside the turn that asked, in exports too', () => {
  const head = 'I built the island. I will ask a crewmate.'
  const text = `${head}\n\nCodex is right, I fixed the cliffs.`
  assert.deepEqual(cut(text, [head.length]), [head, 'Codex is right, I fixed the cliffs.'])
  assert.deepEqual(cut('One line only', [40]), ['One line only', ''])
  const events = [
    { kind: 'you', id: 'u', at: 1, text: 'Build it' },
    { kind: 'hands', id: 'h', at: 2, from: 'claude', to: 'codex', ask: 'Weakest points?', answer: 'The cliffs.', acts: [], via: 'tool', inside: { turn: 't1', mark: head.length } },
    { kind: 'say', id: 's', at: 3, who: 'claude', text, acts: [{ t: 'edit', path: 'a.js', change: 'edit' }], turn: 't1' },
  ] as Event[]
  const woven = weave(events)
  assert.deepEqual(woven.map((e) => e.kind), ['you', 'say', 'hands', 'say'])
  assert.equal((woven[1] as { text: string }).text, head)
  assert.equal((woven[3] as { acts: unknown[] }).acts.length, 1, 'acts stay with the end of the turn')
  assert.equal(woven[3].id, 's')
})

test('connectors: extra headers reach the server, and one named like the default replaces it', async () => {
  assert.deepEqual(parseHeaders('x-plan: go\n# note\n\nbad line\nAuthorization:  Token abc '), { 'x-plan': 'go', Authorization: 'Token abc' })
  const seen: Record<string, string | undefined>[] = []
  const server = createServer((req, res) => {
    seen.push({ plan: req.headers['x-plan'] as string, auth: req.headers.authorization })
    if (req.headers['x-plan'] !== 'go') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'missing plan header' } })); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'go-model' }] }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  try {
    const c = { id: 'x', name: 'Go', kind: 'openai' as const, base }
    const without = await testConnector(c, 'sk-1')
    assert.equal(without.ok, false)
    assert.match(without.note, /missing plan header/)
    const withIt = await testConnector(c, 'sk-1', 'x-plan: go')
    assert.equal(withIt.ok, true)
    assert.deepEqual(withIt.models, ['go-model'])
    assert.equal(seen[1].auth, 'Bearer sk-1', 'the key still goes as Bearer')
    PROVIDERS['conn:hdr'] = { base, style: 'openai', prefer: /./, extra: parseHeaders('x-plan: go\nauthorization: Token raw') }
    await listModels('conn:hdr', 'sk-1')
    assert.equal(seen[2].auth, 'Token raw', 'a header named like the default replaces it')
  } finally {
    delete PROVIDERS['conn:hdr']
    server.close()
  }
})

test('prices: Sonnet 5.5 reads from cache at $0.10, Sonnet 5 at $0.20', () => {
  // A million cached tokens saved the input price minus the read price.
  assert.equal(readSaving('claude-sonnet-5-5', 1_000_000), 1.9)
  assert.equal(readSaving('claude-sonnet-5', 1_000_000), 1.8)
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

test('asks: a bullet, a quote or bold around the handle still asks', () => {
  const r = asks('Plan:\n- @codex: build the page\n> @grok: search X\n**@gemini:** check the copy\n1. @codex: run the tests', ['codex', 'grok', 'gemini'])
  assert.deepEqual(r.asks.map((a) => [a.to, a.ask]), [['codex', 'build the page'], ['grok', 'search X'], ['gemini', 'check the copy'], ['codex', 'run the tests']])
  assert.equal(r.text, 'Plan:')
  assert.equal(asks('- @codex, thanks for that', ['codex']).asks.length, 0, 'a comma is still talk')
  const more = [
    '**@grok**: search X', '*@grok:* search X', '`@grok`: search X', '### @grok: search X', '> - **@grok:** search X',
    '2) __@grok__: search X', '+ @Grok : search X', '@grok:search X', '  -   @grok:   search X  ',
  ]
  for (const line of more) assert.deepEqual(asks(line, ['grok']).asks, [{ to: 'grok', ask: 'search X' }], line)
  assert.deepEqual(asks('- @my-tool: run it\n- @my_bot: run it', ['my-tool', 'my_bot']).asks.map((a) => a.to), ['my-tool', 'my_bot'])
  assert.equal(asks('- [ ] @grok: search X', ['grok']).asks.length, 0, 'a checklist step is a plan, not an ask')
  assert.equal(asks('I will ask @grok: search X', ['grok']).asks.length, 0, 'mid sentence is talk')
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
    assert.match(suggest().model, /^qwen3/)
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
  // Gross: the reads alone, so a room shows a saving before its writes have paid off.
  assert.ok(Math.abs((u.gross ?? 0) - (51804 * 0.09) / 1e6) < 1e-9)
})

test('savings: a result without per model rows is priced at the session model', () => {
  const p = claudeLike()
  p.line({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5' })
  p.line({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 2, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0, output_tokens: 4 } })
  assert.ok(Math.abs((p.turn.usage.gross ?? 0) - (100000 * 3.8) / 1e6) < 1e-9)
  assert.ok(Math.abs((p.turn.usage.saved ?? 0) - (100000 * 3.8) / 1e6) < 1e-9)
})

test('savings: hour long cache writes cost double, not a quarter extra', () => {
  const short = cacheSaving('claude-sonnet-5', 100000, { short: 20000 })!
  const hour = cacheSaving('claude-sonnet-5', 100000, { short: 0, hour: 20000 })!
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

test('mac update: the feed is read and the zip for this chip is picked', () => {
  const yml = `version: 0.1.2
files:
  - url: Lunchbox-0.1.2-mac-x64.zip
    sha512: aaa==
    size: 121715767
  - url: Lunchbox-0.1.2-mac-arm64.zip
    sha512: bbb==
    size: 117619996
  - url: Lunchbox-0.1.2-mac-arm64.dmg
    sha512: ccc==
    size: 121192433
path: Lunchbox-0.1.2-mac-x64.zip
releaseDate: '2026-11-11T10:00:00.000Z'`
  const feed = parseFeed(yml)!
  assert.equal(feed.version, '0.1.2')
  assert.equal(feed.files.length, 3)
  assert.deepEqual(pick(feed, 'arm64'), { url: 'Lunchbox-0.1.2-mac-arm64.zip', sha512: 'bbb==', size: 117619996 })
  assert.equal(pick(feed, 'x64')!.url, 'Lunchbox-0.1.2-mac-x64.zip')
  assert.equal(parseFeed('nothing here'), null)
})

test('mac update: an app on the disk image or moved by Gatekeeper never tries to replace itself', () => {
  assert.equal(canReplace('/Volumes/Lunchbox 0.1.2/Lunchbox.app'), false)
  assert.equal(canReplace('/private/var/folders/x/AppTranslocation/ABC/d/Lunchbox.app'), false)
  assert.equal(canReplace('/usr/local/bin/lunchbox'), false)
})

test('project memory: room text holding a marker cannot end the section early', () => {
  const meta = {
    id: 'r', name: 'Launch', created: 0, updated: 0, crew: [], workspace: '/tmp', sessions: {}, seen: {}, heard: {}, saved: { full: 0, sent: 0 },
    blocks: [{ id: 'pin-1', title: 'Pinned', text: 'Keep <!-- /lunchbox:memory --> this and <!--lunchbox:memory--> that', v: 1, at: 1 }],
  } as RoomMeta
  const own = '# Project\n'
  const once = merge(own, section(meta))
  assert.equal(once.match(/lunchbox:memory/g)?.length, 2, 'only our own two markers')
  const twice = merge(once, section(meta))
  assert.equal(twice, once)
  assert.equal(strip(twice), own)
})

test('ledger: a bad line costs only that row, and old rows are trimmed from the file', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { readLedger } = await import('../electron/store')
  const file = join(mkdtempSync(join(tmpdir(), 'lb-ledger-')), 'ledger.jsonl')
  const row = (at: number, room: string) => JSON.stringify({ at, agent: 'claude', room, usage: { input: 1, output: 1, cached: 0, cost: 0 } })
  const now = Date.now()
  writeFileSync(file, [row(now - 500 * 86400e3, 'ancient'), row(now - 1000, 'a'), '{"at": 1, "agent', row(now - 500, 'b'), row(now - 30 * 86400e3, 'month')].join('\n') + '\n')
  const rows = readLedger(file, now - 14 * 86400e3)
  assert.deepEqual(rows.map((r) => r.room), ['a', 'b'])
  const kept = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).room)
  assert.deepEqual(kept, ['a', 'b', 'month'], 'the old and the broken rows leave the file, the rest stay')
})

test('store: an unreadable room list falls back to its backup and is kept aside', async () => {
  const { mkdtempSync, readdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { Store } = await import('../electron/store')
  const dir = mkdtempSync(join(tmpdir(), 'lb-store-'))
  const plain = { seal: (t: string) => t, open: (t: string) => t }
  const meta = { id: 'r1', name: 'Kept', created: 1, updated: 1, crew: ['claude'], workspace: dir, sessions: {}, seen: {}, heard: {}, blocks: [], saved: { full: 0, sent: 0 } } as RoomMeta
  const one = new Store(dir, plain)
  one.create(meta)
  one.flush()
  writeFileSync(join(dir, 'rooms.json'), '[{"id": "r1", "na')
  const two = new Store(dir, plain)
  assert.equal(two.room('r1')?.name, 'Kept')
  assert.ok(readdirSync(dir).some((f) => f.startsWith('rooms.json.unreadable-')), 'the broken file is copied before anything overwrites it')

  // A turn that ends after its room was deleted does not bring the log back.
  two.remove('r1')
  two.append('r1', { id: 'e', at: 2, kind: 'note', text: 'late' })
  assert.ok(!readdirSync(join(dir, 'rooms')).includes('r1.jsonl'))
  two.flush()
})

test('store: a line that does not parse keeps its place in the room log', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { Store } = await import('../electron/store')
  const dir = mkdtempSync(join(tmpdir(), 'lb-log-'))
  const store = new Store(dir, { seal: (t: string) => t, open: (t: string) => t })
  const ev = (id: string) => JSON.stringify({ id, at: 1, kind: 'you', text: id })
  writeFileSync(join(dir, 'rooms', 'r.jsonl'), [ev('a'), '{"id": "b", "at', ev('c')].join('\n') + '\n')
  const log = store.events('r')
  assert.equal(log.length, 3, 'heard marks count lines, so a bad one still takes a slot')
  assert.equal(log[2].id, 'c')
})

test('plan limits: tallies leave a half written last line for the next read', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, statSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'lb-tally-'))
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
  mkdirSync(join(home, '.claude', 'projects', 'p'), { recursive: true })
  const file = join(home, '.claude', 'projects', 'p', 's.jsonl')
  const t = new Date().toISOString()
  const line = (id: string, out: number) => JSON.stringify({ type: 'assistant', timestamp: t, requestId: 'r' + id, message: { id, usage: { input_tokens: 1, output_tokens: out } } }) + '\n'
  const whole = line('a', 10)
  const next = line('b', 100)
  writeFileSync(file, whole + next.slice(0, 40))
  const { update, used } = await import('../electron/tally')
  const tally: { files: Record<string, { size: number }> } = { files: {} }
  await update('claude', tally as never, Date.now() - 3600e3)
  assert.equal(tally.files[file].size, Buffer.byteLength(whole), 'the read stops after the last newline')
  appendFileSync(file, next.slice(40))
  await update('claude', tally as never, Date.now() - 3600e3)
  assert.equal(tally.files[file].size, statSync(file).size)
  assert.equal(used(tally as never, Date.now() - 3600e3).fresh, 112, 'the finished line is counted once it is whole')
  delete process.env.CLAUDE_CONFIG_DIR
})

test('plan limits: only whole agent windows, or the model in use, take an agent out', async () => {
  const { fullWindows, keepReading } = await import('../electron/limits')
  const later = Date.now() + 3600e3
  const l = { agent: 'claude', at: Date.now(), windows: [
    { id: '5h', label: '5 hours', used: 0.4, resets: later },
    { id: 'week', label: 'Week', used: 0.7, resets: later },
    { id: 'week-opus', label: 'Week, Opus', used: 1, resets: later },
  ] }
  assert.deepEqual(fullWindows(l, ''), [], 'an Opus week does not stop Claude on its default model')
  assert.deepEqual(fullWindows(l, 'claude-sonnet-4-5'), [])
  assert.deepEqual(fullWindows(l, 'opus').map((w) => w.id), ['week-opus'])
  l.windows[0].used = 1
  assert.deepEqual(fullWindows(l, '').map((w) => w.id), ['5h'])

  // Sizing only needs each window's first and last reading, so nothing else is kept.
  let list: { at: number; pct: number; units: number; start: number }[] = []
  const now = Date.now()
  for (let i = 0; i < 50; i++) list = keepReading(list, { at: now - 3600e3 + i * 60e3, pct: i, units: i, start: i < 25 ? 1 : 2 }, now)
  assert.deepEqual(list.map((r) => r.pct), [0, 24, 25, 49])
  list = keepReading(list, { at: now - 40 * 86400e3, pct: 1, units: 1, start: 0 }, now)
  assert.equal(list.length, 4, 'a month old reading is dropped')
})

test('flows: a step is judged only by what it added to the room', async () => {
  const { stepResult } = await import('../electron/flows')
  const events = [
    { id: '1', at: 1, kind: 'you', text: 'step one' },
    { id: '2', at: 2, kind: 'say', who: 'claude', text: 'Here is the digest', acts: [] },
    { id: '3', at: 3, kind: 'you', text: 'step two' },
    { id: '4', at: 4, kind: 'wall', from: 'claude', to: '', reason: 'hit its limit' },
  ] as Event[]
  assert.equal(stepResult(events, 0).ok, true)
  assert.deepEqual(stepResult(events, 2), { text: '', ok: false, stopped: false }, 'step one\'s answer does not count for step two')
})

test('band patterns: every one stays in range, holds still for a still frame, and a visit picks a new one', async () => {
  const { PATTERNS, NAMES, glyph, nextPattern } = await import('../src/ui/patterns')
  assert.equal(NAMES.length, 14)
  for (const name of NAMES) {
    const f = PATTERNS[name]
    for (let c = 0; c < 140; c += 7) for (let r = 0; r < 9; r++) {
      const v = f(c, r, 12.3, 140, 9)
      assert.ok(v >= 0 && v <= 1, `${name} ${v}`)
      assert.equal(f(c, r, 12.3, 140, 9), v, `${name} is the same for the same frame`)
      assert.ok(glyph(v, c, r).length === 1)
    }
  }
  for (const last of NAMES) for (const roll of [0, 0.5, 0.999]) assert.notEqual(nextPattern(last, roll), last)
})

test('savings: worked back from a reported cost, and Codex priced in credits', () => {
  // A Grok row from a real ledger: $2 a million fresh, cached reads counted at a quarter.
  const grok = costSaving('grok', { input: 21066, output: 151, cached: 10112, cost: 0.048094, written: 0 })!
  assert.ok(grok > 0.014 && grok < 0.016, String(grok))
  // Claude rows recorded before 0.1.2 carry no gross; a cached read is a tenth of a fresh one.
  const claude = costSaving('claude', { input: 31717, output: 61, cached: 11507, cost: 0.0810522 })!
  assert.ok(claude > 0.02 && claude < 0.03, String(claude))
  assert.equal(costSaving('ollama', { input: 900, output: 10, cached: 500, cost: 0 }), null)
  assert.equal(costSaving('grok', { input: 900, output: 10, cached: 0, cost: 0.01 }), null)
  // GPT-6.1 Terra: 25 - 1.25 credits a million at $0.04 a credit.
  assert.ok(Math.abs(codexSaving('gpt-6.1-terra', 1_000_000) - 0.95) < 1e-9)
  const turn = codex('gpt-6.1-terra')
  turn.line({ type: 'turn.completed', usage: { input_tokens: 2_000_000, cached_input_tokens: 1_000_000, output_tokens: 10 } })
  assert.ok(Math.abs(turn.turn.usage.gross! - 0.95) < 1e-9)
})

test('takeover lines say what went wrong, without terminal colours', () => {
  // Two real reports from Windows users.
  assert.equal(reason('\x1b[91m\x1b[1mError: \x1b[0mUnexpected error'), 'Unexpected error')
  assert.equal(plain('[91m[1mError: [0mUnexpected error'), 'Error: Unexpected error')
  assert.equal(wallWhy('DeepSeek', '401 Authentication Fails (governor)'), 'DeepSeek refused its API key (401). Check the key in Agents')
  assert.equal(wallWhy('OpenCode', 'Unexpected error'), 'OpenCode stopped with an error: Unexpected error')
  assert.match(wallWhy('OpenCode', 'Server process exited with code 1'), /another copy of it is running/)
  assert.equal(wallWhy('OpenCode', 'OpenCode is not installed on this computer'), 'OpenCode is not installed on this computer')
  assert.equal(wallWhy('Codex', 'hit its limit'), 'Codex hit its limit')
})

test('proof: a look claim needs an image of the work made after the last edit', () => {
  const edited = { kind: 'say', who: 'claude', text: '', acts: [{ t: 'edit', path: 'index.html', change: 'edit' }] }
  const looked = { kind: 'say', who: 'claude', text: '', acts: [{ t: 'tool', name: 'mcp__lunchbox__expert_look', detail: 'index.html' }] }
  const opened = { kind: 'say', who: 'claude', text: '', acts: [{ t: 'tool', name: 'Read', detail: 'looks/home-phone.png' }] }
  const said = 'The page looks clean on both widths now.'
  assert.equal(check(said, [edited, looked].map(ev), true)[0].ok, true)
  assert.equal(check(said, [edited, opened].map(ev), true)[0].ok, true)
  assert.equal(check(said, [looked, edited].map(ev), true)[0].ok, false)
  assert.equal(check(said, [edited].map(ev), true)[0].ok, false)
  // Outside Expert rooms the claim is not read at all.
  assert.equal(check(said, [edited].map(ev)).length, 0)
  // Talk about a plan, a condition or the person's own work is not a claim about what was made.
  for (const t of ['The plan looks good to me.', 'Let me know if the page looks good to you.', 'Check whether the layout looks right on your phone.', 'Your design looks great.', 'Once the page looks good, we can deploy.']) {
    assert.equal(check(t, [edited].map(ev), true).length, 0, t)
  }
  assert.equal(check('The header now looks good.', [edited].map(ev), true).length, 1)
})

test('studio: craft kinds, checklists and the project\'s own design files', async () => {
  const { crafts, studioChecks, studioCore } = await import('../shared/studio')
  assert.ok(crafts('Model a low poly chair in Blender').includes('3d'))
  assert.ok(crafts('Design a logo and a poster for the launch').includes('graphic'))
  assert.ok(crafts('Redesign the landing page hero').includes('ui'))
  assert.equal(studioChecks('What time is it in Tokyo?'), '')
  assert.ok(studioChecks('Make a pitch deck').length > 0)
  assert.ok(studioCore(['DESIGN.md', 'tokens.json']).includes('DESIGN.md, tokens.json'))
})

test('studio: instructions change only when Studio is on, and stay the same turn to turn', async () => {
  const { protocol } = await import('../electron/room/context')
  const meta = { id: 'r', name: 'Room', created: 0, updated: 0, crew: ['claude', 'codex'], workspace: '/w', sessions: {}, seen: {}, heard: {}, blocks: [], saved: { full: 0, sent: 0 } } as RoomMeta
  const agent = (id: string) => ({ id, short: id, name: id, maker: 'x', via: 'cli', good: 'good', tools: true, ready: true, mark: id }) as never
  const crew = [agent('claude'), agent('codex')]
  const off = protocol(meta, crew[0], crew, 'workspace', undefined, [], [], 'claude', null)
  const on = protocol(meta, crew[0], crew, 'workspace', undefined, [], [], 'claude', ['DESIGN.md'])
  assert.ok(!off.includes('Expert mode is on'))
  assert.ok(on.includes('Expert mode is on') && on.includes('DESIGN.md'))
  assert.equal(on, protocol(meta, crew[0], crew, 'workspace', undefined, [], [], 'claude', ['DESIGN.md']), 'byte for byte the same, so the cache holds')
  // Only the agent leading the room hears about the rest of Lunchbox, and about offering flows
  // only when it holds the tool.
  assert.ok(off.includes('Lunchbox around this room') && !off.includes('propose_flow'))
  assert.ok(protocol(meta, crew[0], crew, 'workspace', undefined, ['propose_flow'], [], 'claude', null).includes('offer one with propose_flow'))
  assert.ok(!protocol(meta, crew[1], crew, 'workspace', undefined, ['propose_flow'], [], 'claude', null).includes('Lunchbox around this room'))
})

// Free models answer in their own ways: some think in a separate stream and can run out before
// the answer, some gateways refuse the usage option. Each case must end in text or a clear error.
test('openai style: free model quirks end in text or a sentence, never an empty bubble', async () => {
  let mode = ''
  let asked: any[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw)
      asked.push(body)
      const sse = (rows: unknown[]) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(rows.map((r) => `data: ${JSON.stringify(r)}`).join('\n\n') + '\n\ndata: [DONE]\n\n') }
      if (mode === 'strict' && body.stream_options) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Unrecognized request argument supplied: stream_options"}}'); return }
      if (mode === 'thinking') return sse([{ choices: [{ delta: { content: null, reasoning: 'Let me think about' } }] }, { choices: [{ delta: { reasoning: ' this' }, finish_reason: 'length' }] }])
      if (mode === 'empty') return sse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }])
      if (mode === 'limit') { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Rate limit exceeded: free-models-per-day. Add credits to unlock more."}}'); return }
      sse([{ choices: [{ delta: { role: 'assistant', content: '' } }] }, { choices: [{ delta: { content: 'Hello' } }] }, { choices: [{ delta: { content: ' there' } }] }, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } }])
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()))
  PROVIDERS['free-test'] = { name: 'Free', base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, style: 'openai' } as never
  const go = () => chat('free-test', '', 'free/model', 'system', 'hi', new AbortController().signal, () => {})
  try {
    mode = 'ok'
    assert.equal((await go()).text, 'Hello there')
    mode = 'strict'; asked = []
    assert.equal((await go()).text, 'Hello there', 'asks again without stream_options')
    assert.equal(asked.length, 2)
    assert.ok(asked[0].stream_options && !asked[1].stream_options)
    mode = 'thinking'
    await assert.rejects(go(), /spent its whole answer thinking/)
    mode = 'empty'
    await assert.rejects(go(), /sent back an empty answer/)
    mode = 'limit'
    await assert.rejects(go(), (e: Error) => { assert.ok(limitOf(e.message), 'a free daily limit reads as a usage limit, so the next agent takes over'); return true })
  } finally {
    delete PROVIDERS['free-test']
    server.close()
  }
})

// The result lines of three turns of one real session, each a separate `claude -p --resume`
// (Claude Code 2.1.322, Haiku 5.5): `usage` is the turn, the cost and `modelUsage` run on.
const RESUMED = [
  { cost: 0.0070341200000000005, usage: [2, 41, 11382, 34498], model: [2, 41, 11382, 34498] },
  { cost: 0.00751072, usage: [2, 4, 45880, 78], model: [4, 45, 57262, 34576] },
  { cost: 0.0093729, usage: [2, 82, 45958, 6807], model: [6, 127, 103220, 41383] },
].map(({ cost, usage: [i, o, r, w], model: [mi, mo, mr, mw] }) => ({
  type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: '55065b38', total_cost_usd: cost,
  usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: w, cache_creation: { ephemeral_1h_input_tokens: w, ephemeral_5m_input_tokens: 0 } },
  modelUsage: { 'claude-haiku-5-5': { inputTokens: mi, outputTokens: mo, cacheReadInputTokens: mr, cacheCreationInputTokens: mw, cacheCreationEphemeral1hInputTokens: mw, costUSD: cost } },
}))

test('savings: a resumed Claude Code turn counts only itself, not the session before it', () => {
  let meter
  const turns = RESUMED.map((line, n) => {
    const p = claudeLike(meter, n > 0)
    p.line(line)
    meter = p.turn.meter
    return p.turn.usage
  })
  assert.deepEqual(turns.map((u) => [u.input, u.output, u.cached, u.written]), [[34500, 41, 11382, 34498], [80, 4, 45880, 78], [6809, 82, 45958, 6807]])
  assert.ok(Math.abs(turns[1].cost - (0.00751072 - 0.0070341200000000005)) < 1e-12)
  assert.ok(Math.abs(turns.reduce((n, u) => n + u.cost, 0) - 0.0093729) < 1e-12, 'the turns add up to what the session cost')
  // Each turn's saving is its own reads and hour long writes at Haiku 5.5 rates.
  assert.ok(Math.abs(turns[1].gross! - (45880 * 0.09) / 1e6) < 1e-12)
  assert.ok(Math.abs(turns[1].saved! - (45880 * 0.09 - 78 * 0.1) / 1e6) < 1e-12)
  assert.ok(Math.abs(turns.reduce((n, u) => n + u.gross!, 0) - (103220 * 0.09) / 1e6) < 1e-12)
  assert.ok(turns.every((u) => u.v === 2))
})

test('savings: a session resumed with no count on file falls back to the turn\'s own usage', () => {
  const p = claudeLike(undefined, true)
  p.line({ type: 'system', subtype: 'init', session_id: '55065b38', model: 'claude-haiku-5-5' })
  p.line(RESUMED[2])
  const u = p.turn.usage
  assert.deepEqual([u.input, u.output, u.cached], [6809, 82, 45958])
  assert.ok(Math.abs(u.cost - claudeCost('claude-haiku-5-5', { input: 2, output: 82, read: 45958, short: 0, hour: 6807 })!) < 1e-12)
  assert.ok(Math.abs(u.gross! - (45958 * 0.09) / 1e6) < 1e-12)
  assert.deepEqual(p.turn.meter?.rows['claude-haiku-5-5'].slice(0, 4), [6, 127, 103220, 41383], 'and the next turn has a count to work from')
})

test('savings: a CLI that reports per turn is left alone when resumed', () => {
  // Grok Build, three turns of one session, the model switched after the first: its totals are the turn's.
  const lines = [[21079, 860, 10112, 0.052374], [22400, 64, 10112, 0.10048], [704, 34, 32512, 0.035736]].map(([i, o, r, cost], n) => ({
    type: 'result', subtype: 'success', result: 'ok', session_id: 'g', total_cost_usd: cost,
    usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: 0 },
    modelUsage: { [n ? 'grok-4.7-build-fast' : 'grok-4.7-build']: { inputTokens: i, outputTokens: o, cacheReadInputTokens: r, cacheCreationInputTokens: 0, costUSD: cost } },
  }))
  let meter
  const turns = lines.map((line, n) => {
    const p = claudeLike(meter, n > 0)
    p.line(line)
    meter = p.turn.meter
    return p.turn.usage
  })
  assert.deepEqual(turns.map((u) => [u.input, u.cached, u.cost]), [[21079, 10112, 0.052374], [22400, 10112, 0.10048], [704, 32512, 0.035736]])
  const bare = claudeLike(undefined, true)
  bare.line(lines[2])
  assert.equal(bare.turn.usage.cost, 0.035736)
})

test('savings: a resumed Codex turn counts only itself', () => {
  // Codex 0.157.1, GPT-6 Luna, three turns of one thread through `exec resume`.
  const lines = [[23535, 0, 5], [53096, 23296, 11], [82678, 52736, 17]].map(([i, c, o]) => ({ type: 'turn.completed', usage: { input_tokens: i, cached_input_tokens: c, cache_write_input_tokens: 0, output_tokens: o, reasoning_output_tokens: 0 } }))
  let meter
  const turns = lines.map((line, n) => {
    const p = codex('gpt-6-luna', meter, n > 0)
    p.line(line)
    meter = p.turn.meter
    return p.turn.usage
  })
  assert.deepEqual(turns.map((u) => [u.input, u.cached, u.output]), [[23535, 0, 5], [6265, 23296, 6], [142, 29440, 6]])
  assert.ok(Math.abs(turns[2].saved! - codexSaving('gpt-6-luna', 29440)) < 1e-12)
  const bare = codex('gpt-6-luna', undefined, true)
  bare.line(lines[2])
  assert.deepEqual([bare.turn.usage.input, bare.turn.usage.cached, bare.turn.usage.saved], [0, 0, 0], 'a thread with no count on file is left out')
  assert.ok(bare.turn.meter)
})

test('savings: old ledger rows holding running totals are read as single turns, the file untouched', async () => {
  const { mkdtempSync, writeFileSync, readFileSync: read } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { readLedger, turnsOnly } = await import('../electron/store')
  const file = join(mkdtempSync(join(tmpdir(), 'lb-old-')), 'ledger.jsonl')
  const at = Date.now() - 3600e3
  // Shaped like real rows from 0.1.5: tokens per turn, cost and savings running on.
  const rows = [
    { at, agent: 'claude', room: 'a', usage: { input: 317288, output: 198465, cached: 10696012, cost: 8.6464, written: 317198, saved: 39.3761, gross: 40.6448 } },
    { at: at + 1, agent: 'codex', room: 'a', usage: { input: 100, output: 5, cached: 0, cost: 0, saved: 0, gross: 0 } },
    { at: at + 2, agent: 'claude', room: 'a', usage: { input: 16086, output: 2743, cached: 3343050, cost: 9.4985, written: 16058, saved: 52.0154, gross: 53.3484, kept: 378 } },
    { at: at + 3, agent: 'claude', room: 'b', usage: { input: 54414, output: 3700, cached: 515996, cost: 0.6124, written: 54396, saved: 1.7432, gross: 1.9608 } },
    { at: at + 4, agent: 'codex', room: 'a', usage: { input: 150, output: 9, cached: 400, cost: 0, saved: 0.01, gross: 0.01 } },
    { at: at + 5, agent: 'claude', room: 'a', usage: { input: 1972, output: 795, cached: 2072817, cost: 9.9447, written: 1956, saved: 59.8843, gross: 61.2251, kept: 676 } },
    { at: at + 6, agent: 'claude', room: 'a', usage: { input: 900, output: 30, cached: 40000, cost: 0.02, saved: 0.1, gross: 0.12 } },
    { at: at + 7, agent: 'claude', room: 'a', usage: { input: 900, output: 30, cached: 40000, cost: 0.03, saved: 0.2, gross: 0.2, v: 2 } },
    { at: at + 8, agent: 'claude', room: 'a', usage: { input: 900, output: 30, cached: 40000, cost: 0.04, saved: 0.3, gross: 0.3, v: 2 } },
  ]
  const text = rows.map((r) => JSON.stringify(r) + '\n').join('')
  writeFileSync(file, text)
  const got = readLedger(file, 0).map((r) => r.usage)
  const near = (a: number | undefined, b: number) => assert.ok(Math.abs((a ?? NaN) - b) < 1e-9, `${a} vs ${b}`)
  near(got[2].cost, 9.4985 - 8.6464)
  near(got[2].gross, 53.3484 - 40.6448)
  near(got[2].saved, 52.0154 - 39.3761)
  assert.deepEqual([got[2].input, got[2].cached, got[2].kept], [16086, 3343050, 378], 'Claude Code tokens were per turn already')
  near(got[3].cost, 0.6124)
  assert.deepEqual([got[4].input, got[4].output, got[4].cached], [50, 4, 400], 'Codex tokens ran on too')
  near(got[5].cost, 9.9447 - 9.4985)
  near(got[6].cost, 0.02)
  near(got[7].cost, 0.03)
  near(got[8].cost, 0.04)
  near(got.filter((_, n) => rows[n].agent === 'claude' && rows[n].room === 'a' && n < 6).reduce((n, u) => n + u.cost, 0), 9.9447)
  assert.equal(read(file, 'utf8'), text)
  const own = turnsOnly()
  assert.equal(own('grok', 'a', rows[0].usage), rows[0].usage)
})

// A server that answers any chat request and keeps what it was sent.
async function echo(reply: (body: any, n: number) => { status?: number; lines: string[] }) {
  const seen: { body: any; headers: Record<string, any> }[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw)
      seen.push({ body, headers: req.headers })
      const r = reply(body, seen.length)
      res.writeHead(r.status ?? 200, { 'content-type': r.status ? 'application/json' : 'text/event-stream' })
      res.end(r.lines.join('\n\n'))
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()))
  return { seen, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() }
}
const sse = (usage: object) => ({ lines: ['data: {"choices":[{"delta":{"content":"Done."}}]}', `data: ${JSON.stringify({ choices: [], usage })}`, 'data: [DONE]', ''] })

test('cache: Claude on OpenRouter is sent marked blocks, and every OpenRouter room names its session', async () => {
  const s = await echo(() => sse({ prompt_tokens: 9000, completion_tokens: 5, cost: 0.004, prompt_tokens_details: { cached_tokens: 8000, cache_write_tokens: 600 } }))
  const base = PROVIDERS.openrouter.base
  PROVIDERS.openrouter.base = s.url
  try {
    const history = ['The conversation so far:', 'Person: one', 'Claude: two']
    const r = await chat('openrouter', 'k', 'anthropic/claude-sonnet-5', 'Rules', 'Memory and task', AbortSignal.timeout(5000), () => {}, history, 'room1:openrouter')
    const [sys, user] = s.seen[0].body.messages
    assert.deepEqual(sys.content[0].cache_control, { type: 'ephemeral', ttl: '1h' })
    assert.equal(user.content.length, 4)
    assert.deepEqual(user.content[2].cache_control, { type: 'ephemeral' }, 'breakpoint on the last history block')
    assert.equal(user.content[3].cache_control, undefined, 'the changing part is never cached')
    assert.equal(user.content.slice(0, 3).map((b: any) => b.text).join(''), history.join('\n\n'), 'the model reads the same conversation as before')
    assert.equal(s.seen[0].body.session_id, 'room1:openrouter')
    assert.deepEqual([r.usage.input, r.usage.cached, r.usage.written, r.usage.cost], [1000, 8000, 600, 0.004])
    // A turn later the conversation has grown, and every block sent before is byte for byte the same.
    await chat('openrouter', 'k', 'anthropic/claude-sonnet-5', 'Rules', 'Next task', AbortSignal.timeout(5000), () => {}, [...history, 'Person: three'], 'room1:openrouter')
    const again = s.seen[1].body.messages[1].content
    assert.deepEqual(again.slice(0, 3).map((b: any) => b.text), user.content.slice(0, 3).map((b: any) => b.text))
    assert.equal(again[2].cache_control, undefined)
    assert.deepEqual(again[3].cache_control, { type: 'ephemeral' })

    await chat('openrouter', 'k', 'openai/gpt-6-luna', 'Rules', 'Memory and task', AbortSignal.timeout(5000), () => {}, history, 'room1:openrouter')
    const plainBody = s.seen[2].body
    assert.equal(plainBody.messages[0].content, 'Rules', 'other models keep plain messages')
    assert.equal(plainBody.messages[1].content, history.join('\n\n'))
    assert.equal(plainBody.session_id, 'room1:openrouter')
    assert.equal(plainBody.prompt_cache_key, undefined)
  } finally {
    PROVIDERS.openrouter.base = base
    s.close()
  }
})

test('cache: a route that refuses marked blocks still gets the room as plain text', async () => {
  const s = await echo((_b, n) => (n === 1 ? { status: 400, lines: ['{"error":{"message":"content must be a string"}}'] } : sse({ prompt_tokens: 50, completion_tokens: 5 })))
  const base = PROVIDERS.openrouter.base
  PROVIDERS.openrouter.base = s.url
  try {
    const r = await chat('openrouter', 'k', 'anthropic/claude-sonnet-5', 'Rules', 'Task', AbortSignal.timeout(5000), () => {}, ['Head', 'Person: one'], 'r:openrouter')
    assert.equal(r.text, 'Done.')
    assert.equal(s.seen.length, 2)
    assert.equal(s.seen[1].body.messages[0].content, 'Rules')
    assert.equal(s.seen[1].body.messages[1].content, 'Head\n\nPerson: one')
  } finally {
    PROVIDERS.openrouter.base = base
    s.close()
  }
})

test('cache: xAI is told which conversation it is, and DeepSeek cache hits are counted', async () => {
  const s = await echo(() => sse({ prompt_tokens: 5000, completion_tokens: 5, prompt_cache_hit_tokens: 4800, prompt_cache_miss_tokens: 200 }))
  const base = PROVIDERS.xai.base
  PROVIDERS.xai.base = s.url
  PROVIDERS['conn:deep'] = { base: s.url, style: 'openai', prefer: /./ }
  try {
    await chat('xai', 'k', 'grok-4.7', 'Rules', 'Task', AbortSignal.timeout(5000), () => {}, ['Head'], 'room1:grok-api')
    assert.equal(s.seen[0].headers['x-grok-conv-id'], 'room1:grok-api')
    assert.equal(s.seen[0].body.session_id, undefined)
    const r = await chat('conn:deep', 'k', 'deepseek-chat', 'Rules', 'Task', AbortSignal.timeout(5000), () => {}, ['Head'], 'room1:deep')
    assert.equal(s.seen[1].headers['x-grok-conv-id'], undefined)
    assert.deepEqual([r.usage.input, r.usage.cached], [200, 4800])
  } finally {
    PROVIDERS.xai.base = base
    delete PROVIDERS['conn:deep']
    s.close()
  }
})

test('cache: the lifetime a turn reports is the shortest entry it wrote', () => {
  const result = (short: number, hour: number) => ({ type: 'result', subtype: 'success', result: 'ok', session_id: 's', total_cost_usd: 0.01, usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 9000, cache_creation_input_tokens: short + hour, cache_creation: { ephemeral_5m_input_tokens: short, ephemeral_1h_input_tokens: hour } } })
  const ttl = (short: number, hour: number) => { const p = claudeLike(); p.line(result(short, hour)); return p.turn.usage.ttl }
  assert.equal(ttl(0, 500), 3600)
  assert.equal(ttl(500, 0), 300)
  assert.equal(ttl(40, 500), 300)
  assert.equal(ttl(0, 0), undefined, 'a turn that only read says nothing new')
  const grok = claudeLike()
  grok.line({ type: 'result', result: 'ok', usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 } })
  assert.equal(grok.turn.usage.ttl, undefined)
})

test('a floating surface keeps its side while it fits, flips when only the other fits, and is capped when neither does', () => {
  assert.deepEqual(side(300, 400, 100, 'up'), { side: 'up', max: 400 })
  assert.deepEqual(side(300, 100, 400, 'up'), { side: 'down', max: 400 })
  assert.deepEqual(side(300, 400, 100, 'down'), { side: 'up', max: 400 })
  assert.deepEqual(side(600, 250, 200, 'down'), { side: 'up', max: 250 })
  assert.deepEqual(side(600, 200, 200, 'down'), { side: 'down', max: 200 })
  // A sliver of room still leaves a list tall enough to use.
  assert.equal(side(600, 20, 40, 'up').max, 96)
})

test('a floating surface slides sideways only as far as the window edge', () => {
  assert.equal(shift(100, 300, 8, 900), 0)
  assert.equal(shift(-40, 300, 8, 900), 48)
  assert.equal(shift(700, 300, 8, 900), -100)
  assert.equal(shift(10, 1000, 8, 900), -2)
})

test('agent browser pages are capped: the one unused longest goes, never one at work or the person\'s', () => {
  const tab = (id: string, used: number, working = false) => ({ id, who: id === 'you' ? 'you' : 'claude', working, used })
  assert.equal(evict([tab('you', 0), tab('a', 5), tab('b', 3)], 3), undefined)
  assert.equal(evict([tab('you', 0), tab('a', 5), tab('b', 3), tab('c', 9)], 3), 'b')
  assert.equal(evict([tab('a', 5), tab('b', 3, true), tab('c', 9)], 3), 'a')
  assert.equal(evict([tab('a', 5, true), tab('b', 3, true), tab('c', 9, true)], 3), null)
})

test('asks: a long row of heading or emphasis marks is read at once, not for minutes', () => {
  const t0 = Date.now()
  for (const mark of ['#', '*', '_', '> ', '- ', '1. ']) assert.deepEqual(asks(`${mark.repeat(4000)}\nplain`, ['codex']).asks, [])
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`)
  assert.deepEqual(asks('### 2) > **@codex**: run the tests', ['codex']).asks, [{ to: 'codex', ask: 'run the tests' }])
  assert.deepEqual(asks('@codex: **please** check `a.ts`', ['codex']).asks, [{ to: 'codex', ask: 'please** check `a.ts`' }])
})

test('expert: a direction is written before building, held against the result, and the person\'s own files still lead', async () => {
  const { DIRECTION, crafts, studioChecks, studioCore } = await import('../shared/studio')
  const core = studioCore([])
  assert.equal(DIRECTION, 'looks/direction.md')
  for (const part of ['Their direction rules', 'three directions in one line each', `save it as ${DIRECTION}`, 'References', 'The one move', 'named before', `with ${DIRECTION} beside the image`, 'made by default', 'before and after', 'A one line fix stays a one line fix']) assert.ok(core.includes(part), part)
  assert.ok(core.indexOf('1. Their direction rules') < core.indexOf('2. Read the brief'), 'the person comes first')
  assert.ok(studioCore(['DESIGN.md']).includes('Where they conflict with anything below, they win'))
  assert.ok(core.length < 5600, 'the method stays short enough to send with every room')
  for (const part of ['First screen: what the opening frame holds', 'judged as a poster', 'the best thing under the fold']) assert.ok(core.includes(part), part)
  assert.match(studioChecks('Redesign the landing page'), /Compose the first screen as one frame/)
  assert.deepEqual(crafts('Design a logo for a bakery'), ['brand', 'graphic'])
  assert.match(studioChecks('Design a logo for a bakery'), /Draw it in black on white/)
  assert.match(studioChecks('Model a chair in Blender'), /Silhouette and proportion before detail/)
  assert.match(studioChecks('Redesign the landing page'), /Content first/)
  assert.match(studioChecks('Make a pitch deck'), /The argument first/)
  assert.match(studioChecks('Animate the page transition'), /Key poses first/)
  assert.match(studioChecks('Redesign the landing page'), /The project's own system and the person's direction replace any line here/)
})

test('a reply still arriving never shows markup it is about to lose', async () => {
  const { steady } = await import('../shared/stream')
  // Finished text is left alone.
  assert.equal(steady('One line.\nAnother **bold** and `code`.'), 'One line.\nAnother **bold** and `code`.')
  // A fence, a heading, a bullet or a number half typed waits until it is one.
  for (const tail of ['`', '``', '#', '## ', '-', '- [', '- [x]', '1', '12.', '3) ']) assert.equal(steady(`Intro.\n\n${tail}`), 'Intro.\n\n', tail)
  assert.equal(steady('Intro.\n\n```ts'), 'Intro.\n\n```ts')
  assert.equal(steady('## What'), '## What')
  assert.equal(steady('1. First'), '1. First')
  // Bold, code and links left open read as they will once closed.
  assert.equal(steady('This is **very'), 'This is **very**')
  assert.equal(steady('This is **very*'), 'This is **very**')
  assert.equal(steady('This is **'), 'This is ')
  assert.equal(steady('Run `npm te'), 'Run `npm te`')
  assert.equal(steady('Run `'), 'Run ')
  assert.equal(steady('Open `a*b` and **go'), 'Open `a*b` and **go**')
  assert.equal(steady('See [the docs](https://exa'), 'See the docs')
  assert.equal(steady('See [the docs](https://example.com) for'), 'See [the docs](https://example.com) for')
  assert.equal(steady('2 * 3 is six'), '2 * 3 is six')
  // In an open fence, stars and backticks are code, the closing fence waits until it is whole,
  // and the next line starts with its first character.
  assert.equal(steady('```js\nconst a = `x'), '```js\nconst a = `x')
  assert.equal(steady('```js\nconst a = 1\n'), '```js\nconst a = 1')
  assert.equal(steady('```js\nconst a = 1\n``'), '```js\nconst a = 1')
  assert.equal(steady('```js\nconst a = 1\n```'), '```js\nconst a = 1\n```')
  assert.equal(steady('```js\na\n```\nThen **more'), '```js\na\n```\nThen **more**')
})

test('a dialog keeps Tab inside it: past the last item comes the first, and back again', async () => {
  const { round } = await import('../src/lib/modal')
  assert.equal(round(3, 2, false), 0)
  assert.equal(round(3, 0, true), 2)
  // In the middle the browser moves focus as usual.
  assert.equal(round(3, 1, false), null)
  assert.equal(round(3, 1, true), null)
  // Focus that got outside comes back in at the near end.
  assert.equal(round(3, -1, false), 0)
  assert.equal(round(3, -1, true), 2)
  // Nothing to reach: focus stays on the dialog itself.
  assert.equal(round(0, -1, false), -1)
})

test('expert audit: the first screen is always stated, and a bare half is listed as a fault', async () => {
  const { report } = await import('../electron/audit')
  const view = { width: 1440, findings: [{ kind: 'first screen', text: 'The right half of the first screen (1440 by 900) is bare (6% used, the other half 44%)', at: [] }], families: ['Charter'], sizes: [18, 56], colours: 4, offGrid: 0, spacings: 10, tells: [], first: { all: 25, left: 44, right: 6, top: 30, bottom: 20 } }
  const text = report('index.html', [view, { ...view, width: 390, findings: [], first: { all: 60, left: 60, right: 60, top: 70, bottom: 50 } }], [], [])
  assert.match(text, /1\. \[first screen\] The right half/)
  assert.match(text, /First screen: 25% of the frame carries content \(left 44%, right 6%, top 30%, bottom 20%\)/)
  assert.match(text, /Phone, 390px: no layout problems found\nFirst screen: 60%/)
})

test('savings: the cost of storing the cache is counted only where the net is known', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { Store } = await import('../electron/store')
  const store = new Store(mkdtempSync(join(tmpdir(), 'lb-premium-')), { seal: (t: string) => t, open: (t: string) => t })
  // Claude reports both: reads saved 10 cents, storing cost 4, so 6 net.
  store.record('claude', 'r1', { input: 1000, output: 50, cached: 9000, cost: 0.01, written: 1000, saved: 0.06, gross: 0.1, v: 2 })
  // A gateway reports only a cost. Its saving is worked back and has no storing cost on record,
  // which must not be read as the whole saving having been spent on storing.
  store.record('openrouter', 'r1', { input: 700, output: 10, cached: 3000, cost: 0.002 })
  // Codex has no charge for storing.
  store.record('codex', 'r1', { input: 500, output: 10, cached: 4000, cost: 0, saved: 0.007, gross: 0.007, v: 2 })
  const week = store.totals().week
  assert.ok(Math.abs((week.claude.premium ?? 0) - 0.04) < 1e-12)
  assert.equal(week.openrouter.premium ?? 0, 0)
  assert.ok((week.openrouter.gross ?? 0) > 0)
  assert.equal(week.codex.premium ?? 0, 0)
})

// Saving: long command output is shortened to what an agent needs, and only for commands that log.
test('trim: short output passes untouched, colour and progress bars are dropped', () => {
  assert.deepEqual(trim('all good\n'), { text: 'all good\n', cut: 0 })
  assert.equal(clean('\x1b[32m✔ passed\x1b[0m'), '✔ passed')
  assert.equal(clean('10%\r50%\r100% done\nnext'), '100% done\nnext')
})

test('trim: a long log keeps its start, its end and the lines that look like problems', () => {
  const lines = ['> app@1.0.0 test', ...Array.from({ length: 600 }, (_, i) => `✔ case ${i} passes (0.1ms)`)]
  lines.splice(300, 0, '✖ totals with a fixed amount off (1.2ms)', '  AssertionError: 5464 !== 5465', '      at Test.run (node:internal/test_runner/test:1372:12)')
  lines.push('ℹ pass 600', 'ℹ fail 1')
  const raw = lines.join('\n')
  const r = trim(raw, '/tmp/out/1.txt')
  assert.ok(r.text.length < raw.length / 2, 'much shorter')
  assert.ok(r.text.startsWith('> app@1.0.0 test'), 'the start')
  assert.match(r.text, /✖ totals with a fixed amount off/)
  assert.match(r.text, /5464 !== 5465/)
  assert.doesNotMatch(r.text, /node:internal/, 'frames inside the runtime are left in the file')
  assert.match(r.text, /ℹ fail 1/)
  assert.match(r.text, /lines not shown/)
  assert.match(r.text, /The whole output is in \/tmp\/out\/1\.txt/)
  assert.equal(r.cut, raw.length - r.text.length)
})

test('trim: nothing is counted for output Claude Code would have moved to a file itself', () => {
  const raw = Array.from({ length: 2000 }, (_, i) => `✔ case ${i} passes (0.1ms)`).join('\n')
  assert.ok(raw.length > NATIVE)
  const r = trim(raw)
  assert.ok(r.text.length < 12000)
  assert.equal(r.cut, 0)
})

test('trim: output that would barely shrink is left whole', () => {
  const raw = Array.from({ length: 300 }, (_, i) => `src/file${i}.ts(12,4): error TS2345: argument ${i} is not assignable`).join('\n')
  assert.equal(trim(raw).text, raw)
})

test('logs: tests, builds and installs are shortened, content never is', () => {
  for (const c of ['npm test', 'cd app && npm run build', 'CI=1 pnpm install', 'npx tsc --noEmit && npm test', 'pytest -x tests/', 'cargo test --workspace', 'node --test', 'go test ./...', 'make -j8', 'npm run test:unit -- --coverage', 'yarn lint', 'npx vitest run', 'next build', './gradlew test']) assert.equal(logs(c), true, c)
  for (const c of ['cat src/app.ts', 'git diff', 'npm test 2>&1 | tail -20', 'npm test | grep fail', 'npm test; cat out.log', 'npm ls', 'node build.js', 'npm run dev &', 'npm test || exit 1', 'ls -la', 'curl -s localhost:3000', 'npm test > out.txt; echo $(wc -l < out.txt)']) assert.equal(logs(c), false, c)
  // Whatever keeps running is read while it runs, so its output is never held back in a file.
  for (const c of ['npm run dev', 'npm start', 'yarn dev', 'npx vite', 'next dev', 'npm test -- --watch', 'npx jest --watch', 'vitest', 'npx serve dist', 'docker compose up', 'npm run storybook', 'tsc -w', './gradlew bootRun', 'npx playwright test --ui']) assert.equal(logs(c), false, c)
})

test('wrap: the command keeps its exit code and its place in the shell', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunchbox-wrap-'))
  const file = join(dir, 'out.txt')
  // No room is listening on this address, so the whole output is printed, as without Lunchbox.
  const run = (command: string) => spawnSync('/bin/sh', ['-c', wrap(command, file, 'http://127.0.0.1:9/output/none/1')], { encoding: 'utf8', cwd: dir })
  const ok = run('echo one; echo two >&2')
  assert.equal(ok.status, 0)
  assert.equal(ok.stdout, 'one\ntwo\n')
  const bad = run('echo before; false')
  assert.equal(bad.status, 1)
  assert.equal(bad.stdout, 'before\n')
  // cd inside the command still moves the shell that runs what comes after it.
  assert.equal(spawnSync('/bin/sh', ['-c', `${wrap('cd /', file, 'http://127.0.0.1:9/x')}; pwd`], { encoding: 'utf8', cwd: dir }).stdout.trim(), '/')
  // A file that cannot be written runs the command as it was.
  assert.equal(spawnSync('/bin/sh', ['-c', wrap('echo plain', join(dir, 'missing', 'out.txt'), 'http://127.0.0.1:9/x')], { encoding: 'utf8' }).stdout, 'plain\n')
})

test('rates: list prices per token for what Lunchbox kept out', () => {
  const fable = rates('claude', 'claude-fable-5-2', 3600)!
  assert.equal(fable.input, 8 / 1e6)
  assert.equal(fable.read, 0.2 / 1e6)
  assert.equal(fable.write, 16 / 1e6)
  assert.equal(rates('claude', 'claude-sonnet-5-5', 300)!.write, 2.5 / 1e6)
  assert.equal(rates('codex', 'gpt-6.1-terra')!.input, (25 * 0.04) / 1e6)
  assert.equal(rates('claude', 'some-new-model'), null)
  assert.equal(rates('gemini', 'gemini-3.5-flash'), null)
})

test('claude: a turn reports its model, and what its first and last request read and wrote', () => {
  const p = claudeLike()
  const usage = (read: number, written: number) => ({ input_tokens: 2, output_tokens: 5, cache_read_input_tokens: read, cache_creation_input_tokens: written })
  p.line({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet-5-5' })
  p.line({ type: 'assistant', message: { usage: usage(14000, 30000), content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'a' } }] } })
  p.line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } })
  p.line({ type: 'assistant', message: { usage: usage(44000, 900), content: [{ type: 'text', text: 'done' }] } })
  p.line({ type: 'result', subtype: 'success', result: 'done', session_id: 's', usage: { ...usage(58000, 30900), cache_creation: { ephemeral_5m_input_tokens: 30900, ephemeral_1h_input_tokens: 0 } }, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 4, outputTokens: 10, cacheReadInputTokens: 58000, cacheCreationInputTokens: 30900, cacheCreationEphemeral1hInputTokens: 0, costUSD: 0.08 } } })
  assert.equal(p.turn.model, 'claude-sonnet-5-5')
  assert.deepEqual(p.turn.first, { read: 14000, written: 30000 })
  assert.deepEqual(p.turn.last, { read: 44000, written: 900 })
  assert.equal(p.turn.usage.ttl, 300)
  // Five minute entries: 0.75 of the $2 input price less than the hour would have cost.
  assert.ok(Math.abs(p.turn.quick! - (30900 * 2 * 0.75) / 1e6) < 1e-9)
})

test('hands: a shortened command posts its output with a token that opens nothing else', async (t) => {
  const hands = new Hands()
  await hands.start()
  t.after(() => hands.stop())
  const dir = mkdtempSync(join(tmpdir(), 'lunchbox-drop-'))
  let cut = 0
  const tool = { name: 'remember', description: '', input: {}, run: async () => 'kept' }
  const grant = hands.grant([tool], { kind: 'shorten', dir, cut: (n) => { cut += n } })
  const post = (url: string, body: string) => fetch(url, { method: 'POST', body })
  const ask = (command: string, more = {}) => post(grant.hook, JSON.stringify({ tool_name: 'Bash', tool_input: { command, ...more } })).then((r) => r.json())

  assert.deepEqual(await ask('git diff'), {}, 'content is left alone')
  assert.deepEqual(await ask('npm test', { run_in_background: true }), {}, 'and so is anything in the background')
  const wrapped: string = (await ask('npm test', { timeout: 60000 })).hookSpecificOutput.updatedInput.command
  assert.equal((await ask('npm test', { timeout: 60000 })).hookSpecificOutput.updatedInput.timeout, 60000, 'the rest of the call is kept')
  const secret = grant.hook.split('/').pop()!
  assert.ok(!wrapped.includes(secret), 'the turn\'s own token never reaches a command line')
  const drop = wrapped.match(/http:\/\/127\.0\.0\.1:\d+\/output\/[\w-]+\/[\w-]+/)![0]
  const token = drop.split('/').at(-2)!
  assert.equal((await post(grant.url.replace(secret, token), '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')).status, 404, 'the output token lists no tools')
  assert.equal((await post(grant.hook.replace(secret, token), '{}')).status, 404)

  const long = Array.from({ length: 900 }, (_, i) => `✔ case ${i} passes (0.1ms)`).join('\n') + '\n✖ one fails\nℹ fail 1\n'
  const short = await (await post(drop, long)).text()
  assert.match(short, /✖ one fails/)
  assert.ok(short.length < long.length / 3)
  assert.equal(cut, long.length - short.trimEnd().length)
  assert.equal(await (await post(drop, 'ok\n')).text(), 'ok\n')

  grant.revoke()
  assert.equal((await post(drop, long)).status, 404, 'and it ends with the turn')
})
