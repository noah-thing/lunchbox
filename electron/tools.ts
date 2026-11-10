import type { ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { CATALOG, type CatalogTool } from '../shared/catalog'
import type { Store } from './store'
import { env, launch, stop, which } from './system'
import type { Tool } from './hands'

export type ToolState = { id: string; state: 'off' | 'starting' | 'ready' | 'error'; tools: { name: string; description: string }[]; error?: string; missing?: string[] }

type Server = {
  child: ChildProcess
  pending: Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>
  next: number
  tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[]
  log: string[]
}

const STARTUP = 90e3
const CALL = 10 * 60e3
const MAX_OUT = 60000

const keyOf = (tool: string, secret: string) => `tool:${tool}:${secret}`

// Runs the MCP servers a person switched on, over stdio, and lends their tools to every agent
// through the room's own MCP server. Servers start once and stay up while the app is open.
export class Toolbox {
  private servers = new Map<string, Server>()
  private states = new Map<string, ToolState>()

  constructor(private store: Store, private emit: (channel: string, payload: unknown) => void) {}

  private get conf() { return this.store.settings.tools ?? {} }

  list(): ToolState[] {
    return CATALOG.map((t) => this.states.get(t.id) ?? { id: t.id, state: 'off', tools: [] })
  }

  private set(s: ToolState) {
    this.states.set(s.id, s)
    this.emit('tools', this.list())
  }

  missing(t: CatalogTool) {
    const keys = this.store.keys()
    const need = (t.secrets ?? []).filter((s) => !s.optional && !keys[keyOf(t.id, s.id)]).map((s) => s.label)
    if (t.input && !this.conf[t.id]?.input?.trim()) need.push(t.input.label)
    return need
  }

  async startAll() {
    await Promise.all(CATALOG.filter((t) => this.conf[t.id]?.on).map((t) => this.start(t.id).catch(() => {})))
  }

  async configure(id: string, patch: { on?: boolean; input?: string; secrets?: Record<string, string> }) {
    const t = CATALOG.find((x) => x.id === id)
    if (!t) throw new Error('Unknown tool')
    for (const [k, v] of Object.entries(patch.secrets ?? {})) this.store.setKey(keyOf(id, k), v.trim())
    const cur = this.conf[id] ?? { on: false }
    this.store.saveSettings({ tools: { ...this.conf, [id]: { ...cur, ...(patch.on !== undefined ? { on: patch.on } : {}), ...(patch.input !== undefined ? { input: patch.input.trim() } : {}) } } })
    this.stop(id)
    if (this.conf[id]?.on) await this.start(id)
    else this.set({ id, state: 'off', tools: [] })
    return this.states.get(id)
  }

  stop(id: string) {
    const s = this.servers.get(id)
    if (!s) return
    this.servers.delete(id)
    for (const p of s.pending.values()) p.fail(new Error('The tool was switched off'))
    stop(s.child)
  }

  stopAll() {
    for (const id of [...this.servers.keys()]) this.stop(id)
  }

  async start(id: string) {
    const t = CATALOG.find((x) => x.id === id)
    if (!t) return
    const missing = this.missing(t)
    if (missing.length) return this.set({ id, state: 'error', tools: [], error: `Needs ${missing.join(' and ')}`, missing })
    this.set({ id, state: 'starting', tools: [] })
    const bin = await which(t.run)
    if (!bin) return this.set({ id, state: 'error', tools: [], error: t.run === 'uvx' ? 'Needs uv from astral.sh/uv' : 'Needs Node.js from nodejs.org' })

    const keys = this.store.keys()
    const extraEnv: Record<string, string> = {}
    const args = [...t.args]
    for (const s of t.secrets ?? []) {
      const v = keys[keyOf(t.id, s.id)]
      if (!v) continue
      if (s.env) extraEnv[s.env] = v
      if (s.arg) args.push(s.arg, v)
    }
    const input = this.conf[id]?.input?.replace(/^~(?=$|[/\\])/, homedir())
    if (t.input && input) args.push(input)

    const child = launch(bin, args, { env: await env(extraEnv), stdio: ['pipe', 'pipe', 'pipe'], cwd: homedir() })
    const server: Server = { child, pending: new Map(), next: 1, tools: [], log: [] }
    this.servers.set(id, server)
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let m: any
      try { m = JSON.parse(line) } catch { return }
      if (m.id !== undefined && server.pending.has(m.id)) {
        const p = server.pending.get(m.id)!
        server.pending.delete(m.id)
        m.error ? p.fail(new Error(m.error.message || 'The tool failed')) : p.ok(m.result)
      } else if (m.method === 'notifications/tools/list_changed') {
        this.request(server, 'tools/list', {}).then((r) => { server.tools = r.tools ?? []; this.ready(id, server) }).catch(() => {})
      } else if (m.method && m.id !== undefined) {
        this.write(server, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Not supported' } })
      }
    })
    createInterface({ input: child.stderr! }).on('line', (l) => { server.log = [...server.log.slice(-20), l] })
    // A server that crashed closes its input; the next write would be an uncaught EPIPE.
    child.stdin?.on('error', () => {})
    child.on('exit', (code) => {
      if (this.servers.get(id) !== server) return
      this.servers.delete(id)
      for (const p of server.pending.values()) p.fail(new Error('The tool stopped'))
      const last = server.log.filter((l) => l.trim()).at(-1) ?? ''
      this.set({ id, state: 'error', tools: [], error: `Stopped${code !== null ? ` with code ${code}` : ''}${last ? `: ${last.slice(0, 200)}` : ''}` })
    })
    child.on('error', (e) => this.set({ id, state: 'error', tools: [], error: e.message }))

    try {
      await this.request(server, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lunchbox', version: '1' } }, STARTUP)
      this.write(server, { jsonrpc: '2.0', method: 'notifications/initialized' })
      const r = await this.request(server, 'tools/list', {}, 30e3)
      server.tools = r.tools ?? []
      this.ready(id, server)
    } catch (e) {
      if (this.servers.get(id) === server) {
        this.stop(id)
        this.set({ id, state: 'error', tools: [], error: (e as Error).message })
      }
    }
  }

  private ready(id: string, s: Server) {
    this.set({ id, state: 'ready', tools: s.tools.map((t) => ({ name: t.name, description: (t.description ?? '').split('\n')[0].slice(0, 160) })) })
  }

  private write(s: Server, msg: unknown) {
    if (s.child.stdin?.writable) s.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  private request(s: Server, method: string, params: unknown, timeout = CALL): Promise<any> {
    const id = s.next++
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => { s.pending.delete(id); fail(new Error(`No answer to ${method} after ${Math.round(timeout / 1000)}s`)) }, timeout)
      s.pending.set(id, { ok: (v) => { clearTimeout(timer); ok(v) }, fail: (e) => { clearTimeout(timer); fail(e) } })
      this.write(s, { jsonrpc: '2.0', id, method, params })
    })
  }

  // Every ready server's tools, renamed so they cannot clash with each other or with the room's.
  tools(): Tool[] {
    const out: Tool[] = []
    for (const [id, s] of this.servers) {
      const t = CATALOG.find((x) => x.id === id)!
      if (this.states.get(id)?.state !== 'ready') continue
      for (const tool of s.tools) {
        out.push({
          name: `${id}_${tool.name}`.replace(/[^\w-]/g, '_').slice(0, 64),
          description: `${t.name}: ${tool.description ?? tool.name}`.slice(0, 1000),
          input: {},
          schema: tool.inputSchema ?? { type: 'object', properties: {} },
          run: async (args) => {
            const live = this.servers.get(id)
            if (!live) throw new Error(`${t.name} is not running`)
            const r = await this.request(live, 'tools/call', { name: tool.name, arguments: args })
            const text = (r.content ?? []).map((c: any) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : c.type === 'resource' ? c.resource?.text ?? '' : '')).join('\n')
            if (r.isError) throw new Error(text || `${t.name} reported an error`)
            return text.length > MAX_OUT ? text.slice(0, MAX_OUT) + '\n… (cut)' : text || 'Done.'
          },
        })
      }
    }
    return out
  }
}
