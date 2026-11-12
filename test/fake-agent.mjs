#!/usr/bin/env node
// Stands in for the claude, grok and codex binaries in the engine test. It prints the same
// stream formats the real CLIs do and records each call so the test can check the arguments.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const name = basename(process.argv[1]).replace(/\.(cmd|mjs)$/, '')
const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log(`${name} 1.0.0`)
  process.exit(0)
}
const file = args[args.indexOf('--prompt-file') + 1]
let input = ''
if (args.includes('--prompt-file')) input = readFileSync(file, 'utf8')
else {
  try { input = readFileSync(0, 'utf8') } catch {}
}
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ name, args, input }) + '\n')
const pause = Number(process.env.FAKE_DELAY ?? 0)
const sleep = (ms) => ms && Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const say = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); sleep(pause) }

// FAKE_SCRIPT=showcase plays one clean room for the README: Claude plans and asks two crewmates
// at once, Grok searches X, Codex builds a page and proves it with a passing test.
if (process.env.FAKE_SCRIPT === 'showcase') {
  const { showcase } = await import('./showcase.mjs')
  await showcase(name, input, args, say, sleep, pause)
  process.exit(0)
}

// FAKE_SCRIPT=progress: a long Claude turn as Claude Code streams it, thinking, writing a file
// through its tool input, then more thinking and a command, with progress shots taken between.
if (process.env.FAKE_SCRIPT === 'progress' && name === 'claude') {
  const se = (event) => say({ type: 'stream_event', event })
  const think = (n) => { se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }); for (let t = 100; t <= n; t += 100) { say({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: t, estimated_tokens_delta: 100 }); sleep(120) } }
  say({ type: 'system', subtype: 'init', session_id: 'progress', model: 'claude-opus-5-5' })
  const write = (text) => { se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }); for (const w of text.split(/(?<= )/)) { se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } }); sleep(25) } }
  say({ type: 'system', subtype: 'status', status: 'requesting' })
  think(1200)
  write("I'll build the pricing page and prove it works.\n\n- [ ] Plan the tiers and the layout\n- [ ] Write the pricing page\n- [ ] Build it and run the tests\n- [ ] Check it at phone width\n")
  think(4200)
  write('- [x] Plan the tiers and the layout\n')
  think(600)
  se({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'w1', name: 'Write', input: {} } })
  const json = JSON.stringify({ file_path: process.cwd() + '/src/pages/pricing.tsx', content: 'export function Pricing() {\n  return <main />\n}\n'.repeat(200) })
  for (let i = 0; i < json.length; i += 160) { se({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 160) } }); sleep(40) }
  se({ type: 'content_block_stop', index: 1 })
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: JSON.parse(json) }] } })
  say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'File created' }] } })
  write('- [x] Write the pricing page\n')
  say({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 2000, error_status: 529 })
  sleep(2500)
  say({ type: 'system', subtype: 'status', status: 'requesting' })
  think(1200)
  se({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'b1', name: 'Bash', input: {} } })
  se({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command": "npm run build && npx playwright test pricing"}' } })
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm run build && npx playwright test pricing' } }] } })
  sleep(3000)
  say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'built\n4 passed\nexit code 0' }] } })
  write('- [x] Build it and run the tests\n')
  think(2000)
  write('- [x] Check it at phone width\n\nThe pricing page is in src/pages/pricing.tsx and its four tests pass.')
  const reply = 'The pricing page is in src/pages/pricing.tsx and its four tests pass.'
  say({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: 'progress', total_cost_usd: 0.2, usage: { input_tokens: 6, output_tokens: 3900 } })
  process.exit(0)
}

// FAKE_SCRIPT=subagents: Claude splits the work across three subagents and reports back.
if (process.env.FAKE_SCRIPT === 'subagents' && name === 'claude') {
  const tasks = [['a', 'Map where auth tokens are checked', 'Explore', 'haiku'], ['b', 'Write tests for the token parser', 'general-purpose', 'sonnet'], ['c', 'Review the session middleware', 'code-reviewer', 'opus']]
  say({ type: 'system', subtype: 'init', session_id: 'subs' })
  say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Splitting this into three parts that can run at once.' }, ...tasks.map(([id, description, subagent_type, model]) => ({ type: 'tool_use', id, name: 'Task', input: { description, prompt: description, subagent_type, model } }))] } })
  const steps = [['a', 'Grep', { pattern: 'verifyToken' }], ['b', 'Read', { file_path: 'src/auth/token.ts' }], ['c', 'Read', { file_path: 'src/middleware/session.ts' }], ['a', 'Read', { file_path: 'src/auth/guard.ts' }], ['b', 'Write', { file_path: 'test/token.test.ts' }], ['b', 'Bash', { command: 'npm test -- token' }], ['c', 'Grep', { pattern: 'expires' }]]
  for (const [parent, tool, input] of steps) { sleep(900); say({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id: parent + tool, name: tool, input }] } }) }
  sleep(1200)
  say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Tokens are checked in src/auth/guard.ts and token.ts.' }] } })
  sleep(Number(process.env.SUBS_HOLD ?? 0))
  say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: '6 tests written, all passing.' }] } })
  say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c', content: 'Sessions never expire when the clock is skewed; one fix suggested.' }] } })
  say({ type: 'assistant', message: { content: [{ type: 'text', text: '\n\nAll three are back. Tokens are checked in two places, the parser now has six passing tests, and the review found one real bug: sessions never expire when the clock is skewed.' }] } })
  say({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'subs', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 80 } })
  process.exit(0)
}

if (name === 'codex') {
  say({ type: 'thread.started', thread_id: 'thread-1' })
  // FAKE_SCRIPT=cut: Codex runs a command and, unless told to stay quiet, writes half a reply before the limit.
  if (process.env.FAKE_SCRIPT === 'cut') {
    say({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'npm run build', aggregated_output: 'ok', exit_code: 0, status: 'completed' } })
    if (!process.env.FAKE_QUIET) say({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Built it. Next I will deploy the' } })
  }
  say({ type: 'error', message: "You've hit your usage limit. Try again in 2 hours." })
  process.exit(1)
}

const mcp = args.includes('--mcp-config') ? JSON.parse(((v) => (v.trim().startsWith('{') ? v : readFileSync(v, 'utf8')))(args[args.indexOf('--mcp-config') + 1])).mcpServers.lunchbox.url : null
// Brought in by the main agent for one task: report back. Checked first, because the briefing
// quotes the person's message, which may hold the words the main agent reacts to.
if (input.includes('brought you in for this:')) {
  const text = `Done: drafted the launch post in 42 words.`
  say({ type: 'system', subtype: 'init', session_id: `${name}-session`, model: 'fake' })
  say({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
  say({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: `${name}-session`, total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 20 } })
  process.exit(0)
}

// The main agent brings a crewmate in through the room's tool and passes on its report.
if (mcp && input.includes('Bring:')) {
  let id = 0
  const rpc = async (method, params) => (await fetch(mcp, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })).json()
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1' } })
  say({ type: 'system', subtype: 'init', session_id: `${name}-session`, model: 'fake' })
  const got = (await rpc('tools/call', { name: 'bring_in', arguments: { agent: 'grok', task: 'Draft the launch post', context: 'Keep it under 50 words.' } })).result.content[0].text
  const text = `Grok reported: ${got}`
  say({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
  say({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: `${name}-session`, total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 20 } })
  process.exit(0)
}

// Claude writes, asks Codex mid-turn through the room's tool, then carries on with the answer.
if (mcp && input.includes('Consult:') && name === 'claude') {
  let id = 0
  const rpc = async (method, params) => (await fetch(mcp, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })).json()
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1' } })
  const se = (event) => say({ type: 'stream_event', event })
  const write = (text) => { se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }); for (const w of text.split(/(?<= )/)) { se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } }); sleep(30) } }
  say({ type: 'system', subtype: 'init', session_id: `${name}-session`, model: 'fake' })
  write('I built the island and rendered six views. For a second opinion I will ask a crewmate for the weakest points.')
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c1', name: 'mcp__lunchbox__ask_crewmate', input: { agent: 'codex', question: 'Name the three weakest points in the renders.' } }] } })
  const got = (await rpc('tools/call', { name: 'ask_crewmate', arguments: { agent: 'codex', question: 'Name the three weakest points in the renders.' } })).result.content[0].text
  say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: got }] } })
  sleep(1500)
  write('Codex is right about the cliffs. I broke them up with ledges and planted paths, and re-rendered the north view.')
  const text = 'I built the island and rendered six views. For a second opinion I will ask a crewmate for the weakest points.\n\nCodex is right about the cliffs. I broke them up with ledges and planted paths, and re-rendered the north view.'
  say({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
  say({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: `${name}-session`, total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 20 } })
  process.exit(0)
}

if (mcp && input.includes('Borrow:')) {
  let id = 0
  const rpc = async (method, params) => {
    const res = await fetch(mcp, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
    return res.json()
  }
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1' } })
  const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name)
  say({ type: 'system', subtype: 'init', session_id: `${name}-session`, model: 'fake' })
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'm1', name: 'mcp__lunchbox__search_x', input: { query: 'agent limits' } }] } })
  const found = (await rpc('tools/call', { name: 'search_x', arguments: { query: 'agent limits' } })).result.content[0].text
  say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'm1', content: found }] } })
  const text = `Grok found: ${found}\nTools: ${tools.join(', ')}`
  say({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
  say({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: `${name}-session`, total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 20 } })
  process.exit(0)
}

let reply
if (input.includes('asks you:')) reply = '212 posts this week. Most complain about limits.'
else if (input.includes('crewmates answered above')) reply = 'Limits are the top complaint.\n- [x] Research\nAll tests pass.'
else if (input.includes('prove that')) reply = 'I could not run them here.'
// Whoever leads asks a crewmate, never itself, so the handoff happens whichever agent the router picks.
else reply = `Let me check what people say first.\n- [ ] Research\n- [ ] Build\n@${name === 'grok' ? 'claude' : 'grok'}: what are people saying about AI agent limits?`

const session = `${name}-session`
say({ type: 'system', subtype: 'init', session_id: session, model: 'fake' })
sleep(pause * 8)
if (input.includes('asks you:')) {
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'run_terminal_command', input: { command: 'x-search "agent limits" --since 7d --count' } }] } })
  sleep(pause * 10)
  say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '212', is_error: false }] } })
}
for (const word of reply.split(/(?<= )/)) say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } } })
say({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } })
// Shaped like a real Claude Code turn: the long system prompt comes back from cache, the new prompt is written.
const fresh = Math.round(input.length / 4)
const usage = { input_tokens: 6, output_tokens: Math.round(reply.length / 4), cache_read_input_tokens: 14200, cache_creation_input_tokens: fresh }
const modelUsage = { 'claude-sonnet-5-5': { inputTokens: 6, outputTokens: usage.output_tokens, cacheReadInputTokens: 14200, cacheCreationInputTokens: fresh, costUSD: 0.01 } }
let cost = 0.01
// FAKE_RUNNING is a file: with it the cost and per model rows run on across resumes of a session,
// the way Claude Code reports them, while usage stays the turn's own.
if (process.env.FAKE_RUNNING && name === 'claude') {
  let before = {}
  try { before = JSON.parse(readFileSync(process.env.FAKE_RUNNING, 'utf8')) } catch {}
  const row = modelUsage['claude-sonnet-5-5']
  for (const k of Object.keys(row)) row[k] += before[k] ?? 0
  cost = row.costUSD
  writeFileSync(process.env.FAKE_RUNNING, JSON.stringify(row))
}
say({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: session, total_cost_usd: cost, usage, modelUsage })
