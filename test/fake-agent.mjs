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

if (name === 'codex') {
  say({ type: 'thread.started', thread_id: 'thread-1' })
  say({ type: 'error', message: "You've hit your usage limit. Try again in 2 hours." })
  process.exit(1)
}

const mcp = args.includes('--mcp-config') ? JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.lunchbox.url : null
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
else reply = 'Let me check what people say first.\n- [ ] Research\n- [ ] Build\n@grok: what are people saying about AI agent limits?'

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
say({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: session, total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 } })
