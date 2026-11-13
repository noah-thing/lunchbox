import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chat, looping, PROVIDERS, roomFor, setBase } from '../electron/agents/http'
import { inside, replace, use, type Bench } from '../electron/agents/bench'
import { Sieve, manual, readCall } from '../electron/agents/textcalls'
import { specs } from '../electron/agents/bench'
import type { Access, Act } from '../shared/types'

// A room's folder with two files, and the rules of a mode, without the room around it.
function folder(access: Access = 'workspace', confirm = true) {
  const root = mkdtempSync(join(tmpdir(), 'lunchbox-bench-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'app.js'), 'const greeting = "hello"\nconsole.log(greeting)\n')
  writeFileSync(join(root, 'README.md'), '# Demo\n')
  const asked: string[] = []
  const bench: Bench = {
    root, access,
    run: async (command) => {
      try { return { code: 0, out: execSync(command, { cwd: root, encoding: 'utf8' }), how: 'auto', reason: 'only reads' } } catch (e) { return { code: 1, out: String((e as { stderr?: string }).stderr ?? e), how: 'auto', reason: '' } }
    },
    confirm: async (what) => { asked.push(what); return confirm },
  }
  return { root, bench, asked }
}

type Seen = { url: string; body: any }
// A model server that answers each chat request with the next scripted reply.
async function fake(reply: (n: number, body: any, req: IncomingMessage) => (res: ServerResponse) => void, extra?: (req: IncomingMessage, res: ServerResponse) => boolean) {
  const seen: Seen[] = []
  let n = 0
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      if (extra?.(req, res)) return
      const body = raw ? JSON.parse(raw) : {}
      seen.push({ url: req.url ?? '', body })
      reply(n++, body, req)(res)
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()))
  return { seen, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() }
}

const ndjson = (rows: unknown[]) => (res: ServerResponse) => { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.end(rows.map((r) => JSON.stringify(r)).join('\n') + '\n') }
const sse = (rows: unknown[]) => (res: ServerResponse) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(rows.map((r) => `data: ${JSON.stringify(r)}`).join('\n\n') + '\n\ndata: [DONE]\n\n') }
const refuse = (status: number, message: string) => (res: ServerResponse) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: message })) }
const says = (content: string) => ndjson([{ message: { role: 'assistant', content } }, { done: true, prompt_eval_count: 40, eval_count: 6 }])
const calls = (name: string, args: unknown) => ndjson([{ message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] } }, { done: true, prompt_eval_count: 40, eval_count: 6 }])

function watch() {
  const steps: string[] = []
  const acts: Act[] = []
  let shown = ''
  return { steps, acts, text: () => shown, delta: (d: string) => { shown += d }, onStep: (s: { working?: string; acts?: Act[] }) => { if (s.working) steps.push(s.working); if (s.acts) acts.push(...s.acts) } }
}

test('bench: paths stay inside the folder, through links too', () => {
  const { root } = folder()
  assert.ok(inside(root, 'src/app.js').endsWith('app.js'))
  assert.ok(inside(root, 'new/deep/file.txt').endsWith('file.txt'), 'a file that does not exist yet is fine')
  assert.throws(() => inside(root, '../outside.txt'), /outside the room/)
  assert.throws(() => inside(root, '/etc/passwd'), /outside the room/)
  symlinkSync(tmpdir(), join(root, 'away'))
  assert.throws(() => inside(root, 'away/x.txt'), /outside the room/)
  symlinkSync('/etc/hosts', join(root, 'hosts'))
  assert.throws(() => inside(root, 'hosts'), /outside the room/)
})

test('bench: an edit replaces exactly one place, and says how to fix a miss', () => {
  assert.equal(replace('a b a', 'b', 'c', false), 'a c a')
  assert.equal(replace('a b a', 'a', 'x', true), 'x b x')
  assert.throws(() => replace('a b a', 'a', 'x', false), /appears 2 times/)
  assert.throws(() => replace('a b', 'z', 'x', false), /not in the file/)
  assert.equal(replace('  let x = 1\n', 'let x = 1  ', 'let x = 2', false), '  let x = 2\n', 'stray spaces at the edges are forgiven')
  assert.equal(replace('cost', 'cost', '$& $1', false), '$& $1', 'the replacement is text, not a pattern')
})

test('bench: Plan only reads, Ask asks before each change, Auto just works', async () => {
  const plan = folder('plan')
  assert.match((await use(plan.bench, 'write_file', { path: 'x.txt', content: 'hi' })).text, /Plan mode/)
  assert.ok((await use(plan.bench, 'read_file', { path: 'README.md' })).text.includes('# Demo'))
  assert.deepEqual(specs('plan').map((s) => s.name), ['list_directory', 'read_file', 'search_file_content', 'run_command'])

  const no = folder('ask', false)
  const declined = await use(no.bench, 'edit_file', { path: 'src/app.js', find: 'hello', replace: 'hi' })
  assert.equal(declined.ok, false)
  assert.match(declined.text, /declined/)
  assert.deepEqual(no.asked, ['Edit src/app.js'])
  assert.ok(readFileSync(join(no.root, 'src/app.js'), 'utf8').includes('hello'), 'nothing changed')

  const yes = folder('ask', true)
  const made = await use(yes.bench, 'write_file', { path: 'notes/a.md', content: 'one\ntwo' })
  assert.deepEqual(yes.asked, ['Create notes/a.md'])
  assert.deepEqual(made.act, { t: 'edit', path: 'notes/a.md', change: 'write' })

  const auto = folder()
  await use(auto.bench, 'edit_file', { path: 'src/app.js', find: '"hello"', replace: '"hej"' })
  assert.equal(auto.asked.length, 0)
  assert.ok(readFileSync(join(auto.root, 'src/app.js'), 'utf8').includes('"hej"'))
  const out = await use(auto.bench, 'write_file', { path: '../escape.txt', content: 'x' })
  assert.equal(out.ok, false)
  assert.match(out.text, /outside the room/)
  const listing = (await use(auto.bench, 'list_directory', {})).text
  assert.ok(listing.includes('src/') && listing.includes('src/app.js') && listing.includes('README.md'))
  assert.match((await use(auto.bench, 'search_file_content', { query: 'GREETING' })).text, /src\/app\.js:1: const greeting/)
  const ran = await use(auto.bench, 'run_command', { command: 'node src/app.js' })
  assert.match(ran.text, /hej\nexit code 0/)
  assert.deepEqual(ran.act && { ...ran.act, out: undefined }, { t: 'cmd', command: 'node src/app.js', exit: 0, out: undefined })
})

test('ollama: a message sent mid-turn joins between steps, and unload frees the model', async () => {
  const { bench } = folder()
  const script = [calls('list_directory', {}), says('Done, and I used the new name.')]
  const freed: string[] = []
  const f = await fake((n) => script[n], (req, res) => {
    if (req.url === '/api/generate') {
      freed.push(req.url)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"done":true}')
      return true
    }
    if (req.url !== '/api/show') return false
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ capabilities: ['completion', 'tools'], model_info: { 'qwen.context_length': 32768 } }))
    return true
  })
  PROVIDERS['fake-mid'] = { base: `${f.base}/api`, style: 'ollama', prefer: /./, unload: true }
  const w = watch()
  let waiting: string | null = 'Call it greet instead'
  try {
    const r = await chat('fake-mid', '', 'coder:27b', 'Rules', 'Rename it', AbortSignal.timeout(8000), w.delta, [], 'r:mid', { bench, onStep: w.onStep, inbox: () => { const m = waiting; waiting = null; return m } })
    assert.equal(r.text, 'Done, and I used the new name.')
    const chats = f.seen.filter((x: any) => x.body?.messages)
    const second = chats[1].body.messages
    assert.equal(second.at(-1).role, 'user', 'the message comes after the step it waited for')
    assert.equal(second.at(-1).content, 'Call it greet instead')
    assert.equal(second.filter((m: any) => m.content === 'Call it greet instead').length, 1, 'and is handed over once')
    assert.ok(chats.every((x: any) => x.body.keep_alive === '30m'), 'the model stays loaded between the steps of a turn')
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(freed.length, 1, 'and is freed once, when the turn is over')
  } finally { delete PROVIDERS['fake-mid']; f.close() }
})

test('ollama: a model with tool calling works through the folder over several rounds', async () => {
  const { root, bench } = folder()
  const script = [
    calls('list_directory', {}),
    calls('read_file', { path: 'src/app.js' }),
    calls('edit_file', { path: 'src/app.js', find: '"hello"', replace: '"hej"' }),
    calls('run_command', { command: 'node src/app.js' }),
    says('It now prints hej, and I ran it to check.'),
  ]
  const f = await fake((n) => script[n], (req, res) => {
    if (req.url !== '/api/show') return false
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ capabilities: ['completion', 'tools'], model_info: { 'qwen.context_length': 262144 } }))
    return true
  })
  PROVIDERS['fake-ollama'] = { base: `${f.base}/api`, style: 'ollama', prefer: /./ }
  const w = watch()
  try {
    const r = await chat('fake-ollama', '', 'coder:27b', 'Rules', 'Make it say hej', AbortSignal.timeout(8000), w.delta, ['Head'], 'r:ollama', { bench, onStep: w.onStep })
    assert.equal(r.text, 'It now prints hej, and I ran it to check.')
    assert.equal(f.seen.length, 5, 'one request a round')
    assert.deepEqual(f.seen[0].body.tools.map((t: any) => t.function.name), ['list_directory', 'read_file', 'search_file_content', 'write_file', 'edit_file', 'run_command'])
    assert.equal(f.seen[0].body.options.num_ctx, roomFor(262144), 'the window is asked for, capped by what this computer holds')
    assert.ok(f.seen[0].body.options.num_ctx >= 8192)
    assert.equal(f.seen[0].body.keep_alive, '30m')
    // Each round carries the calls and results before it.
    const last = f.seen[4].body.messages
    assert.deepEqual(last.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_name), ['list_directory', 'read_file', 'edit_file', 'run_command'])
    assert.ok(last.find((m: any) => m.role === 'tool' && m.tool_name === 'read_file').content.includes('const greeting = "hello"'))
    assert.ok(last.find((m: any) => m.role === 'tool' && m.tool_name === 'run_command').content.includes('hej'))
    assert.equal(last.filter((m: any) => m.role === 'assistant' && m.tool_calls).length, 4)
    assert.ok(readFileSync(join(root, 'src/app.js'), 'utf8').includes('"hej"'))
    // The room sees the same steps a command line agent's turn shows.
    assert.deepEqual(r.acts.map((a) => a.t), ['tool', 'tool', 'edit', 'cmd'])
    assert.deepEqual(w.acts, r.acts)
    assert.ok(w.steps.includes('read_file src/app.js') && w.steps.includes('$ node src/app.js'))
    assert.equal(r.usage.input, 200, 'tokens of every round are counted')
  } finally { delete PROVIDERS['fake-ollama']; f.close() }
})

test('text calls: a model without tool calling lists, reads, edits and runs through tag blocks', async () => {
  const { root, bench } = folder()
  const script = [
    says('<think>I should look first.</think>I will look at the folder.\n\n<list_directory>\n</list_directory>'),
    says('<read_file>\n<path>src/app.js</path>\n</read_file>'),
    says('Changing the greeting.\n<edit_file>\n<path>src/app.js</path>\n<find>"hello"</find>\n<replace>"hej"</replace>\n</edit_file>'),
    says('<write_file>\n<path>docs/page.html</path>\n<content>\n<p class="a">It\'s "quoted" & <b>tagged</b></p>\n</content>\n</write_file>'),
    says('<run_command>\n<command>node src/app.js</command>\n</run_command>'),
    says('Done. It prints hej now.'),
  ]
  const f = await fake((n) => script[n], (req, res) => {
    if (req.url !== '/api/show') return false
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ capabilities: ['completion'], model_info: { 'x.context_length': 8192 } }))
    return true
  })
  PROVIDERS['fake-plain'] = { base: `${f.base}/api`, style: 'ollama', prefer: /./ }
  const w = watch()
  try {
    const r = await chat('fake-plain', '', 'abliterated:27b', 'Rules', 'Make it say hej', AbortSignal.timeout(8000), w.delta, [], '', { bench, onStep: w.onStep })
    assert.equal(f.seen[0].body.tools, undefined, 'no tools are sent to a model that has none')
    assert.match(f.seen[0].body.messages[0].content, /end your message with a block/)
    assert.equal(r.text, 'I will look at the folder.\n\nChanging the greeting.\n\nDone. It prints hej now.', 'thinking and tool blocks stay out of what the person reads')
    assert.equal(w.text().replace(/\n{3,}/g, '\n\n'), r.text)
    assert.deepEqual(r.acts.map((a) => a.t), ['tool', 'tool', 'edit', 'edit', 'cmd'])
    assert.ok(readFileSync(join(root, 'src/app.js'), 'utf8').includes('"hej"'))
    assert.equal(readFileSync(join(root, 'docs/page.html'), 'utf8'), '<p class="a">It\'s "quoted" & <b>tagged</b></p>', 'file content arrives as written, no escaping')
    const back = f.seen[2].body.messages.at(-1)
    assert.equal(back.role, 'user')
    assert.match(back.content, /Result of read_file:\nconst greeting = "hello"/)
    assert.match(f.seen[5].body.messages.at(-1).content, /Result of run_command:\nhej\nexit code 0/)
  } finally { delete PROVIDERS['fake-plain']; f.close() }
})

test('text calls: a server that refuses tools is asked again in text, and a bad block is repaired, then held to a shape', async () => {
  const { root, bench } = folder()
  const script = [
    refuse(400, 'registry.ollama.ai/library/coder:latest does not support tools'),
    says('<read_file>\n</read_file>'),
    says('<tool_call>{"name": "read_file", "arguments": {path: src/app.js}}</tool_call>'),
    says('{"tool": "write_file", "args": {"path": "out.txt", "content": "ok"}, "say": "Writing it."}'),
    says('{"tool": "none", "args": {}, "say": "All done."}'),
  ]
  // No capabilities in /api/show: an older server, so the first request is what finds out.
  const f = await fake((n) => script[n], (req, res) => { if (req.url !== '/api/show') return false; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return true })
  PROVIDERS['fake-old'] = { base: `${f.base}/api`, style: 'ollama', prefer: /./ }
  const w = watch()
  try {
    const r = await chat('fake-old', '', 'coder', 'Rules', 'Write out.txt', AbortSignal.timeout(8000), w.delta, [], '', { bench, onStep: w.onStep })
    assert.ok(f.seen[0].body.tools, 'tools are tried first')
    assert.equal(f.seen[1].body.tools, undefined)
    assert.match(f.seen[1].body.messages[0].content, /Rules for tool blocks/)
    assert.match(f.seen[2].body.messages.at(-1).content, /missing <path>/)
    assert.equal(f.seen[2].body.format, undefined)
    assert.match(f.seen[3].body.messages.at(-2).content, /not valid JSON/)
    assert.deepEqual(f.seen[3].body.format.properties.tool.enum.slice(-2), ['run_command', 'none'], 'the second retry is held to a JSON shape')
    assert.ok(f.seen[4].body.format, 'and stays held for the rest of the turn')
    assert.equal(readFileSync(join(root, 'out.txt'), 'utf8'), 'ok')
    assert.equal(r.text, 'Writing it.\n\nAll done.')
  } finally { delete PROVIDERS['fake-old']; f.close() }
})

test('text calls: a model that never gets a call right is stopped with a plain reason, and so is one that repeats a failing call', async () => {
  const { bench } = folder()
  const f = await fake((n) => (n < 9 ? says('<tool_call>{broken</tool_call>') : says('x')), (req, res) => { if (req.url !== '/api/show') return false; res.writeHead(200); res.end('{"capabilities":["completion"]}'); return true })
  PROVIDERS['fake-bad'] = { base: `${f.base}/api`, style: 'ollama', prefer: /./ }
  try {
    await assert.rejects(chat('fake-bad', '', 'tiny', 'Rules', 'Go', AbortSignal.timeout(8000), () => {}, [], '', { bench, onStep() {} }), /kept writing tool calls Lunchbox could not read/)
    assert.equal(f.seen.length, 3, 'two repairs, then it stops')
  } finally { delete PROVIDERS['fake-bad']; f.close() }
  const g = await fake(() => calls('read_file', { path: 'nope.txt' }), (req, res) => { if (req.url !== '/api/show') return false; res.writeHead(200); res.end('{"capabilities":["tools"]}'); return true })
  PROVIDERS['fake-loop'] = { base: `${g.base}/api`, style: 'ollama', prefer: /./ }
  try {
    const err = await chat('fake-loop', '', 'tiny', 'Rules', 'Go', AbortSignal.timeout(8000), () => {}, [], '', { bench, onStep() {} }).catch((e) => e)
    assert.match(err.message, /same failing read_file call 3 times/)
    assert.equal(err.acts.length, 3, 'what it did before stopping is kept')
  } finally { delete PROVIDERS['fake-loop']; g.close() }
})

test('openai style: streamed tool calls are put together, run, and answered, and calls written as text still work', async () => {
  const { root, bench } = folder()
  const piece = (i: number, id: string | undefined, name: string | undefined, args: string) => ({ choices: [{ delta: { tool_calls: [{ index: i, ...(id ? { id } : {}), function: { ...(name ? { name } : {}), arguments: args } }] } }] })
  const script = [
    sse([{ choices: [{ delta: { role: 'assistant', content: 'Reading both.' } }] }, piece(0, 'c1', 'read_file', '{"pa'), piece(0, undefined, undefined, 'th":"src/app.js"}'), piece(1, 'c2', 'read_file', '{"path":"README.md"}'), { choices: [], usage: { prompt_tokens: 50, completion_tokens: 9 } }]),
    sse([{ choices: [{ delta: { content: '<tool_call>\n{"name": "write_file", "arguments": {"path": "b.txt", "content": "two"}}\n</tool_call>' } }] }, { choices: [], usage: { prompt_tokens: 80, completion_tokens: 12 } }]),
    sse([{ choices: [{ delta: { content: 'Both files read, b.txt written.' } }] }, { choices: [], usage: { prompt_tokens: 90, completion_tokens: 7 } }]),
  ]
  const f = await fake((n) => script[n])
  PROVIDERS['fake-openai'] = { base: f.base, style: 'openai', prefer: /./ }
  const w = watch()
  try {
    const r = await chat('fake-openai', 'k', 'gpt-x', 'Rules', 'Read them', AbortSignal.timeout(8000), w.delta, ['Head'], '', { bench, onStep: w.onStep })
    assert.equal(f.seen[0].body.tools.length, 6)
    assert.equal(f.seen[0].body.tools[0].type, 'function')
    const chats = f.seen.filter((x: any) => x.body?.messages)
    const second = chats[1].body.messages
    assert.deepEqual(second.at(-3).tool_calls.map((c: any) => [c.id, c.function.name, c.function.arguments]), [['c1', 'read_file', '{"path":"src/app.js"}'], ['c2', 'read_file', '{"path":"README.md"}']])
    assert.deepEqual(second.slice(-2).map((m: any) => [m.role, m.tool_call_id]), [['tool', 'c1'], ['tool', 'c2']])
    assert.ok(second.at(-2).content.includes('const greeting'))
    assert.match(f.seen[2].body.messages.at(-1).content, /Result of write_file:\nWrote b\.txt/)
    assert.equal(readFileSync(join(root, 'b.txt'), 'utf8'), 'two')
    assert.equal(r.text, 'Reading both.\n\nBoth files read, b.txt written.')
    assert.equal(r.usage.input, 220)
  } finally { delete PROVIDERS['fake-openai']; f.close() }
})

test('anthropic: tool use goes round with the thinking that came before it, unchanged', async () => {
  const { bench } = folder()
  const ev = (o: unknown) => o
  const script = [
    sse([
      ev({ type: 'message_start', message: { usage: { input_tokens: 30, cache_read_input_tokens: 100 } } }),
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Look first.' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } }),
      ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Checking the file.' } }),
      ev({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu1', name: 'read_file', input: {} } }),
      ev({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path": "READ' } }),
      ev({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'ME.md"}' } }),
      ev({ type: 'message_delta', usage: { output_tokens: 20 } }),
    ]),
    sse([ev({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 150 } } }), ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }), ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'It is a demo.' } }), ev({ type: 'message_delta', usage: { output_tokens: 5 } })]),
  ]
  const f = await fake((n) => script[n])
  PROVIDERS['fake-claude'] = { base: f.base, style: 'anthropic', prefer: /./ }
  try {
    const r = await chat('fake-claude', 'k', 'claude-sonnet-5-5', 'Rules', 'What is this?', AbortSignal.timeout(8000), () => {}, ['Head'], '', { bench, onStep() {} })
    assert.deepEqual(f.seen[0].body.tools.map((t: any) => t.name).slice(0, 2), ['list_directory', 'read_file'])
    assert.ok(f.seen[0].body.tools[1].input_schema.properties.path)
    const [, said, result] = f.seen[1].body.messages
    assert.deepEqual(said.content, [{ type: 'thinking', thinking: 'Look first.', signature: 'sig123' }, { type: 'text', text: 'Checking the file.' }, { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'README.md' } }])
    assert.deepEqual(result.content, [{ type: 'tool_result', tool_use_id: 'tu1', content: '# Demo\n', cache_control: { type: 'ephemeral' } }])
    assert.equal(r.text, 'Checking the file.\n\nIt is a demo.')
    assert.equal(r.usage.cached, 250)
    assert.equal(r.usage.output, 25)
  } finally { delete PROVIDERS['fake-claude']; f.close() }
})

test('text calls: the block is read whatever a model wraps it in, and what was not a call stays text', () => {
  const tools = specs('workspace')
  assert.deepEqual(readCall('Sure.\n<read_file>\n<path> src/a.ts </path>\n<start>20</start>\n</read_file>', tools), { call: { name: 'read_file', args: { path: 'src/a.ts', start: 20 } }, before: 'Sure.' })
  const fenced = readCall('<write_file>\n<path>a.md</path>\n<content>\n```md\n# Title\n</content> is a tag I mention\n```\n</content>\n</write_file>', tools)
  assert.equal(fenced.call?.args.content, '# Title\n</content> is a tag I mention', 'content runs to its last closing tag, and a fence around it is dropped')
  assert.deepEqual(readCall('```json\n{"name": "run_command", "arguments": {"command": "npm test"}}\n```', tools).call, { name: 'run_command', args: { command: 'npm test' } })
  assert.deepEqual(readCall('{"tool": "list_directory", "args": {}}', tools).call, { name: 'list_directory', args: {} })
  assert.match(readCall('<delete_file>\n<path>a</path>\n</delete_file>', tools).error ?? '', /no tool called delete_file/)
  assert.equal(readCall('Use <b>bold</b> and {"a": 1} in the page.', tools).call, undefined)
  assert.equal(readCall('Use <b>bold</b> and {"a": 1} in the page.', tools).error, undefined)
  assert.equal(readCall('<write_file><path>x</path><content>cut off mid file', tools).call?.args.content, 'cut off mid file', 'an answer cut short still yields its call')
  assert.ok(manual(tools).includes('- edit_file:') && manual(specs('plan')).includes('run_command') && !manual(specs('plan')).includes('write_file'))
})

test('streamed answers: thinking tags and tool blocks are held back however the stream is cut', () => {
  const run = (pieces: string[], tools = ['read_file']) => { const s = new Sieve(tools); return pieces.map((p) => s.feed(p)).join('') + s.end() }
  assert.equal(run(['<thi', 'nk>secret', ' plan</th', 'ink>\nHello ', 'the', 're']), 'Hello there')
  assert.equal(run(['Looking. <read', '_file>\n<path>a</path>\n</read_file> trailing']), 'Looking. ')
  assert.equal(run(['a < b and <b>bold</b>', ' x <']), 'a < b and <b>bold</b> x <')
  assert.equal(run(['<think>never closed']), '')
  assert.equal(run(['plain <read_file> text'], []), 'plain <read_file> text', 'without tools only thinking is hidden')
})

test('local models: the window follows the model and the memory, and a model stuck repeating is noticed', () => {
  assert.equal(roomFor(262144, 8), 8192)
  assert.equal(roomFor(262144, 16), 16384)
  assert.equal(roomFor(262144, 64), 32768)
  assert.equal(roomFor(4096, 64), 4096)
  assert.equal(roomFor(0, 16), 16384)
  assert.equal(looping('The answer is 42. '.repeat(20)), false, 'a short answer is left alone')
  assert.equal(looping('Intro.\n' + 'I will now check the file and report back to you shortly.\n'.repeat(80)), true)
  assert.equal(looping(Array.from({ length: 200 }, (_, i) => `Line ${i} says something different each time around.`).join('\n')), false)
})

test('local models: the address of a built in server can be changed and set back', () => {
  PROVIDERS['base-test'] = { base: 'http://127.0.0.1:11434/api', style: 'ollama', prefer: /./ }
  try {
    const at = (typed: string) => { setBase('base-test', typed); return PROVIDERS['base-test'].base }
    assert.equal(at('192.168.1.20'), 'http://192.168.1.20:11434/api')
    assert.equal(at('http://box.local:8000/'), 'http://box.local:8000/api')
    assert.equal(at('0.0.0.0:11500'), 'http://127.0.0.1:11500/api')
    assert.equal(at('https://ollama.example.com/v1'), 'https://ollama.example.com/api')
    assert.equal(at(''), 'http://127.0.0.1:11434/api')
  } finally { delete PROVIDERS['base-test'] }
})

// An agent counts as installed only when it starts: a file on the PATH is not proof.
test('detection: a broken link, a file that cannot run, a tool that fails and one that hangs are not found', { skip: process.platform === 'win32' }, async () => {
  const { chmodSync } = await import('node:fs')
  const { probe, resetPath, runnable, which } = await import('../electron/system')
  const { detect } = await import('../electron/agents')
  const bin = mkdtempSync(join(tmpdir(), 'lunchbox-path-'))
  const script = (name: string, body: string, mode = 0o755) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), mode) }
  symlinkSync(join(bin, 'gone-away'), join(bin, 'claude'))
  script('codex', 'echo "codex 9.9.9"', 0o644)
  script('grok', 'echo "grok: cannot find its runtime" >&2; exit 127')
  script('gemini', 'echo "gemini 3.1.0"')
  script('slow', '/bin/sleep 5; echo "slow 1.0.0"')
  const before = process.env.LUNCHBOX_PATH
  process.env.LUNCHBOX_PATH = bin
  process.env.LUNCHBOX_PATH_ONLY = '1'
  resetPath()
  try {
    assert.equal(await which('claude'), '', 'a link to nothing is not on the PATH')
    assert.equal(await which('codex'), '', 'nor is a file that may not run')
    assert.equal(runnable(join(bin, 'codex')), false)
    assert.equal(runnable(join(bin, 'claude')), false)
    assert.equal(await which('grok'), join(bin, 'grok'))
    assert.deepEqual(await probe(join(bin, 'grok')), { ok: false, version: '' })
    assert.deepEqual(await probe(join(bin, 'gemini')), { ok: true, version: '3.1.0' })
    assert.equal((await probe(join(bin, 'slow'), 300)).ok, false, 'one that does not answer in time counts as not starting')

    const agents = await detect({}, {}, {})
    const of = (id: string) => agents.find((a) => a.id === id)!
    assert.deepEqual([of('claude').found, of('codex').found, of('grok').found, of('gemini').found], [false, false, false, true])
    assert.equal(of('gemini').ready, true)
    assert.equal(of('gemini').version, '3.1.0')
    assert.match(of('grok').note ?? '', /does not start/)
    assert.equal(of('claude').note, undefined, 'nothing is said about a tool that is simply not there')
    assert.equal(agents.filter((a) => a.via === 'cli' && a.found).length, 1, 'the count is only what is real')
  } finally {
    if (before === undefined) delete process.env.LUNCHBOX_PATH
    else process.env.LUNCHBOX_PATH = before
    delete process.env.LUNCHBOX_PATH_ONLY
    resetPath()
  }
})

// Something else listening on a local server's port is not that server.
test('detection: a local server counts as running only when it answers like one', async () => {
  const { listModels } = await import('../electron/agents/http')
  const f = await fake(() => (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}') })
  PROVIDERS['not-ollama'] = { base: `${f.base}/api`, style: 'ollama', prefer: /./ }
  PROVIDERS['not-openai'] = { base: f.base, style: 'openai', prefer: /./ }
  try {
    await assert.rejects(listModels('not-ollama', ''), /not like a model server/)
    await assert.rejects(listModels('not-openai', ''), /not like a model server/)
  } finally { delete PROVIDERS['not-ollama']; delete PROVIDERS['not-openai']; f.close() }
})
