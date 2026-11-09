#!/usr/bin/env node
// Stands in for the claude, grok and codex binaries in the engine test. It prints the same
// stream formats the real CLIs do and records each call so the test can check the arguments.
import { appendFileSync, readFileSync } from 'node:fs'
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
const modelUsage = { 'claude-sonnet-5-5': { inputTokens: 6, outputTokens: usage.output_tokens, cacheReadInputTokens: 14200, cacheCreationInputTokens: fresh } }
say({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: session, total_cost_usd: 0.01, usage, modelUsage })
