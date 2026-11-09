import { copyFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// One clean room for the README, played by the stand-in agents through the real engine:
// Claude leads, Grok searches X, Codex draws the banner through the room's image tool, then
// builds the event page and proves it with a passing test run.

const ASK_GROK = `On it. Grok checks X for what people want from a hackathon, I write the announcement on that, and Codex designs the banner and builds the event page.
@grok: what do developers on X say makes a hackathon worth going to?`

const GROK = `Three things come up most: one night instead of a weekend (338 posts), real prizes over swag (271), and teams formed before the night (164).`

const BRIEF = `Grok found three clear wants: one night, real prizes, teams set in advance. The announcement leads with all three. Codex, the banner first.`

const POST = `Banner is in. The announcement, built on what Grok found:

**"One night. Real prizes. Teams set before you arrive. Build Night, Stockholm, 29 November."**

@codex: build events/build-night.html with the banner and the announcement, then run the tests.`

const DONE = `Build Night is ready to announce. The event page is up at events/build-night.html with the banner and the announcement, and its tests pass. Post the announcement above when you're ready.
- [x] What people want, from X
- [x] Announcement
- [x] Banner
- [x] Event page`

const BANNER = {
  prompt: 'Build Night banner: chrome BUILD N1GHT on black, glossy pixel objects',
  file: 'events/build-night.png',
  size: '1536x1024',
}

const usage = (text) => ({ input_tokens: 6, output_tokens: Math.round(text.length / 4), cache_read_input_tokens: 14200, cache_creation_input_tokens: 900 })
const IMAGE = new URL('./fixtures/showcase-banner.png', import.meta.url).pathname

// SHOWCASE_PACE=real gives the recording human timing: a pause to think before writing, text
// that streams in uneven chunks at reading speed, and searches, images and tests that take as
// long as they would. Without it the script runs at test speed.
const real = process.env.SHOWCASE_PACE === 'real'

export async function showcase(name, input, args, say, sleep, pause) {
  const asked = input.includes('asks you:')
  const wait = (ms, fast) => sleep(real ? ms : fast)
  const stream = (text) => {
    say({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
    const words = text.split(/(?<= )/)
    for (let i = 0; i < words.length;) {
      const n = real ? 1 + Math.floor(Math.random() * 3) : 1
      say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: words.slice(i, i + n).join('') } } })
      i += n
      if (real) sleep(40 + Math.floor(Math.random() * 90))
    }
  }

  if (name === 'codex') {
    const cwd = args[args.indexOf('-C') + 1] || process.cwd()
    say({ type: 'thread.started', thread_id: 'codex-showcase' })
    const image = input.match(/save it as (\S+?\.png)/)
    if (image) {
      say({ type: 'item.started', item: { type: 'command_execution', command: `image_gen ${BANNER.file}` } })
      wait(7600, pause * 30)
      mkdirSync(dirname(image[1]), { recursive: true })
      copyFileSync(IMAGE, image[1])
      say({ type: 'item.completed', item: { type: 'agent_message', text: image[1] } })
    } else {
      say({ type: 'item.started', item: { type: 'command_execution', command: 'ls events' } })
      wait(1600, pause * 6)
      mkdirSync(join(cwd, 'events'), { recursive: true })
      writeFileSync(join(cwd, 'events/build-night.html'), '<img src="build-night.png" alt="Build Night">\n<h1>Build Night</h1>\n<p>One night. Real prizes. Stockholm, 29 November.</p>\n')
      say({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'events/build-night.html', kind: 'add' }] } })
      say({ type: 'item.started', item: { type: 'command_execution', command: 'npm test' } })
      // Long enough for the README shots to catch Codex mid-run.
      sleep(Number(process.env.SHOWCASE_HOLD ?? 0) || pause * 8)
      say({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 0, aggregated_output: '✓ event page renders\n✓ banner loads\n\n18 passed' } })
      say({ type: 'item.completed', item: { type: 'agent_message', text: 'events/build-night.html is up with the banner and the announcement. All 18 tests pass.' } })
    }
    say({ type: 'turn.completed', usage: { input_tokens: 21000, cached_input_tokens: 18400, output_tokens: 640 } })
    return
  }

  const session = `${name}-showcase`
  say({ type: 'system', subtype: 'init', session_id: session, model: 'claude-sonnet-5-5' })
  let reply
  let lead = ''
  if (name === 'grok' && asked) {
    say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x1', name: 'run_terminal_command', input: { command: 'x-search "hackathon" --since 30d --top' } }] } })
    wait(5000, pause * 10)
    say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x1', is_error: false, content: [
      '773 posts',
      "@mira.codes · One night beats a whole weekend. I can't give up two days anymore. · 2.4k",
      "@jonasbuilds · Real prizes or I'm not coming. Stickers don't pay rent. · 1.9k",
      "@tobi_ships · The best ones I've been to had teams set a week before. · 1.6k",
      "@devnoor · Ship one thing in one night, demo it, go home. That's the format. · 1.2k",
    ].join('\n') }] } })
    reply = GROK
  } else if (input.includes('crewmates answered above') && input.includes('events/build-night.html is up')) {
    reply = DONE
  } else if (input.includes('crewmates answered above')) {
    // The banner comes from the room's image tool, which hands the drawing to Codex.
    const url = args.includes('--mcp-config') ? JSON.parse(((v) => (v.trim().startsWith('{') ? v : readFileSync(v, 'utf8')))(args[args.indexOf('--mcp-config') + 1])).mcpServers.lunchbox.url : null
    if (url) {
      wait(1400 + Math.floor(Math.random() * 500), 0)
      stream(BRIEF)
      say({ type: 'assistant', message: { content: [{ type: 'text', text: BRIEF }] } })
      lead = BRIEF
      wait(500, 0)
      let id = 0
      const rpc = async (method, params) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })).json()
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1' } })
      say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'img', name: 'mcp__lunchbox__make_image', input: BANNER }] } })
      const r = await rpc('tools/call', { name: 'make_image', arguments: BANNER })
      say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'img', content: r.result?.content?.[0]?.text ?? '' }] } })
    }
    reply = POST
  } else {
    reply = ASK_GROK
  }
  wait(lead ? 900 : 1500 + Math.floor(Math.random() * 700), pause * 4)
  stream(reply)
  say({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } })
  const u = usage(lead + reply)
  say({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: session, total_cost_usd: 0.012, usage: u, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 6, outputTokens: u.output_tokens, cacheReadInputTokens: 14200, cacheCreationInputTokens: 900 } } })
}
