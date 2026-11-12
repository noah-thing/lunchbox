import type { Tool } from '../hands'

// Tool calls for models that have no tool calling of their own. The model writes a small block of
// tags in its answer and Lunchbox reads it out. Tags rather than JSON, because file content goes
// between them as it is: a model asked to put a whole file inside a JSON string has to escape
// every quote and line break, and small models get that wrong. One block a message, so each
// result is seen before the next step is chosen.

type Spec = Pick<Tool, 'name' | 'description' | 'input' | 'required'>
export type TextCall = { name: string; args: Record<string, unknown> }

// Values that are text as written, and may themselves hold tags.
const RAW = new Set(['content', 'find', 'replace'])

export function manual(specs: Spec[]) {
  const tools = specs.map((s) => {
    const params = Object.entries(s.input).map(([k, v]) => `${k}${s.required?.includes(k) ? '' : ' (optional)'}: ${(v as { description?: string }).description ?? ''}`)
    return `- ${s.name}: ${s.description}${params.length ? `\n  ${params.join('\n  ')}` : ''}`
  })
  return [
    'You can read and change the files in the room\'s folder and run commands, with the tools below. To use one, end your message with a block in exactly this form, then stop. The result arrives in the next message, and you carry on from it.',
    '<read_file>\n<path>src/app.js</path>\n</read_file>',
    `Tools:\n${tools.join('\n')}`,
    [
      'Rules for tool blocks:',
      '- The tag is the tool\'s name, and each value sits between tags named after it.',
      '- One block a message, last in the message, with nothing after it.',
      '- Write values as they are, with no quotes and no escaping. File content goes in as plain text with its line breaks.',
      '- Every block you write runs, so never write one as an example or inside a code fence.',
      '- Look before you answer: list and read the files a question is about instead of asking the person to paste them.',
      '- When the work is done, answer in plain words with no tool block.',
    ].join('\n'),
  ].join('\n\n')
}

const unfence = (v: string) => v.replace(/^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/, '$1')
// One line break after the opening tag and before the closing one belongs to the block, not the value.
const trim1 = (v: string) => v.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '')

function typed(spec: Spec | undefined, key: string, value: string): unknown {
  const type = (spec?.input[key] as { type?: string } | undefined)?.type
  if (type === 'number') return Number(value.trim()) || 0
  if (type === 'boolean') return /^\s*(true|yes|1)\s*$/i.test(value)
  return RAW.has(key) ? unfence(trim1(value)) : value.trim()
}

function tagged(body: string, spec: Spec | undefined) {
  const args: Record<string, unknown> = {}
  let rest = body
  // The raw values first, each read to its last closing tag, so a file that contains tags survives.
  for (const key of RAW) {
    const open = rest.indexOf(`<${key}>`)
    if (open < 0) continue
    const close = rest.lastIndexOf(`</${key}>`)
    const end = close > open ? close : rest.length
    args[key] = typed(spec, key, rest.slice(open + key.length + 2, end))
    rest = rest.slice(0, open) + rest.slice(close > open ? end + key.length + 3 : end)
  }
  for (const m of rest.matchAll(/<([a-z_]+)>([\s\S]*?)<\/\1>/g)) if (!(m[1] in args)) args[m[1]] = typed(spec, m[1], m[2])
  return args
}

function fromJson(o: any): TextCall | null {
  if (!o || typeof o !== 'object') return null
  const name = o.name ?? o.tool ?? o.function?.name ?? o.tool_name
  let args = o.arguments ?? o.args ?? o.parameters ?? o.function?.arguments ?? o.input ?? {}
  if (typeof args === 'string') { try { args = JSON.parse(args) } catch { return null } }
  return typeof name === 'string' && args && typeof args === 'object' ? { name, args } : null
}

// The first tool call in a message, the words before it, and a note when something that was
// plainly meant as a call could not be read, so the model can be told and try again.
export function readCall(text: string, specs: Spec[]): { call?: TextCall; before: string; error?: string } {
  const names = specs.map((s) => s.name)
  const open = new RegExp(`<(${names.join('|')})>`).exec(text)
  // Models trained on another format use it whatever the instructions say; those are read too.
  const wrapped = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/.exec(text) ?? /```(?:json|tool_call|tool_code)?\s*(\{[\s\S]*?"(?:name|tool)"[\s\S]*?\})\s*```/.exec(text)
  if (open && (!wrapped || open.index < wrapped.index)) {
    const spec = specs.find((s) => s.name === open[1])
    const from = open.index + open[0].length
    const close = text.lastIndexOf(`</${open[1]}>`)
    const call = { name: open[1], args: tagged(text.slice(from, close > from ? close : text.length), spec) }
    const missing = (spec?.required ?? []).filter((k) => call.args[k] === undefined || call.args[k] === '')
    if (missing.length) return { before: text.slice(0, open.index).trim(), error: `The ${open[1]} block is missing ${missing.map((k) => `<${k}>`).join(' and ')}. Write the whole block again.` }
    return { call, before: text.slice(0, open.index).trim() }
  }
  const whole = text.trim()
  const json = wrapped?.[1] ?? (whole.startsWith('{') && whole.endsWith('}') && /"(name|tool)"\s*:/.test(whole) ? whole : '')
  if (json) {
    const before = wrapped ? text.slice(0, wrapped.index).trim() : ''
    let parsed: unknown
    try { parsed = JSON.parse(json) } catch { return { before, error: 'That tool call was not valid JSON. Use the tag form shown in the instructions instead, with values written as plain text.' } }
    const o = parsed as { tool?: string; say?: string }
    // The shape asked for when a reply is constrained: no tool means the words are the answer.
    if (o && (o.tool === 'none' || o.tool === '') && typeof o.say === 'string') return { before: o.say.trim() }
    const call = fromJson(parsed)
    if (!call) return { before, error: 'That tool call had no tool name. Use the tag form shown in the instructions.' }
    if (!names.includes(call.name)) return { before, error: `There is no tool called ${call.name}. The tools are: ${names.join(', ')}.` }
    return { call, before: [before, typeof o?.say === 'string' ? o.say.trim() : ''].filter(Boolean).join('\n\n') }
  }
  // A block for a tool that does not exist, closed like a real one.
  const stray = /<([a-z]+_[a-z_]+)>\s*<(path|command|query)>[\s\S]*?<\/\1>/.exec(text)
  if (stray && !names.includes(stray[1])) return { before: text.slice(0, stray.index).trim(), error: `There is no tool called ${stray[1]}. The tools are: ${names.join(', ')}.` }
  return { before: text }
}

// The JSON shape a server is held to when a model keeps getting the tag form wrong.
export function schema(specs: Spec[]) {
  const keys = [...new Set(specs.flatMap((s) => Object.keys(s.input)))]
  return {
    type: 'object',
    properties: {
      say: { type: 'string' },
      tool: { type: 'string', enum: [...specs.map((s) => s.name), 'none'] },
      args: { type: 'object', properties: Object.fromEntries(keys.map((k) => [k, { type: 'string' }])) },
    },
    required: ['tool', 'args'],
  }
}

// What the person sees of a streamed answer: thinking a model writes out between <think> tags and
// the tool block itself are held back, across however the stream happens to be cut into pieces.
export class Sieve {
  private held = ''
  private thinking = false
  private shut = false
  private openers: string[]
  thought = false

  constructor(tools: string[] = []) {
    this.openers = ['<think>', '<thinking>', ...(tools.length ? ['<tool_call>', ...tools.map((t) => `<${t}>`)] : [])]
  }

  feed(piece: string): string {
    if (this.shut) return ''
    this.held += piece
    let out = ''
    for (;;) {
      if (this.thinking) {
        const end = /<\/think(ing)?>/.exec(this.held)
        if (!end) { this.held = this.held.slice(-12); return out }
        this.held = this.held.slice(end.index + end[0].length).replace(/^\s+/, '')
        this.thinking = false
        continue
      }
      let at = -1, hit = ''
      for (const o of this.openers) { const i = this.held.indexOf(o); if (i >= 0 && (at < 0 || i < at)) { at = i; hit = o } }
      if (at < 0) {
        // The end of this piece may be the start of a tag whose rest has not arrived.
        const lt = this.held.lastIndexOf('<')
        const tail = lt >= 0 ? this.held.slice(lt) : ''
        const keep = tail && this.openers.some((o) => o.startsWith(tail)) ? tail.length : 0
        out += this.held.slice(0, this.held.length - keep)
        this.held = keep ? tail : ''
        return out
      }
      out += this.held.slice(0, at)
      this.held = this.held.slice(at + hit.length)
      if (hit.startsWith('<think')) { this.thinking = this.thought = true; continue }
      this.shut = true
      return out
    }
  }

  // What was held back in case it was a tag, once the answer is over and it was not.
  end() {
    const rest = this.shut || this.thinking ? '' : this.held
    this.held = ''
    return rest
  }
}

// The same without a stream, for text that arrived whole.
export const unthink = (text: string) => text.replace(/<think(ing)?>[\s\S]*?(<\/think(ing)?>|$)\s*/g, '')
