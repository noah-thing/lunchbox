import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type Tool = {
  name: string
  description: string
  input: Record<string, unknown>
  required?: string[]
  // A complete JSON schema, for tools passed through from another MCP server.
  schema?: Record<string, unknown>
  run(args: Record<string, unknown>): Promise<string>
}

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: any }

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

// One MCP server for every agent the room starts. Each turn gets its own URL, and the URL is the
// credential: it names the tools that turn may use and stops working when the turn ends.
export class Hands {
  private server: Server | null = null
  private grants = new Map<string, Tool[]>()
  private port = 0

  async start() {
    if (this.server) return
    this.server = createServer((req, res) => { this.handle(req, res).catch(() => this.send(res, 500, { error: 'internal' })) })
    this.server.requestTimeout = 0
    this.server.headersTimeout = 0
    const server = this.server
    try {
      await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok) })
    } catch (e) {
      this.server = null
      throw e
    }
    this.port = (server.address() as AddressInfo).port
  }

  stop() {
    this.server?.close()
    this.server = null
    this.port = 0
  }

  grant(tools: Tool[]) {
    // Without a server the agents run without the room's tools rather than call a dead address.
    if (!this.port) return { url: '', revoke: () => {} }
    const token = randomBytes(18).toString('base64url')
    this.grants.set(token, tools)
    return { url: `http://127.0.0.1:${this.port}/mcp/${token}`, revoke: () => this.grants.delete(token) }
  }

  private send(res: ServerResponse, status: number, body?: unknown) {
    if (res.headersSent) return
    if (body === undefined) {
      res.writeHead(status).end()
      return
    }
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    // The token is the last part of the URL, or a bearer header for a CLI that takes it that way.
    const token = req.url?.match(/^\/mcp\/([\w-]+)/)?.[1] ?? req.headers.authorization?.match(/^Bearer\s+([\w-]+)$/i)?.[1]
    const tools = token ? this.grants.get(token) : undefined
    if (!tools) return this.send(res, 404, { error: 'This turn has ended' })
    if (req.method === 'DELETE') return this.send(res, 200)
    if (req.method !== 'POST') return this.send(res, 405)

    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 1_000_000) return this.send(res, 413)
    }
    let body: Rpc | Rpc[]
    try { body = JSON.parse(raw) } catch { return this.send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }

    const batch = Array.isArray(body) ? body : [body]
    const replies = (await Promise.all(batch.map((m) => this.reply(m, tools)))).filter((r) => r !== null)
    if (!replies.length) return this.send(res, 202)
    this.send(res, 200, Array.isArray(body) ? replies : replies[0])
  }

  private async reply(m: Rpc, tools: Tool[]) {
    if (m.id === undefined || m.id === null) return null
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result })
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: m.id, error: { code, message } })
    switch (m.method) {
      case 'initialize': {
        const asked = m.params?.protocolVersion
        return ok({
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'lunchbox', version: '1' },
          instructions: 'Tools from the Lunchbox room you are working in: your crewmates, their abilities, the room\'s shared memory, the Lunchbox browser the person can watch, and any tools they connected.',
        })
      }
      case 'ping':
        return ok({})
      case 'tools/list':
        return ok({
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.schema ?? { type: 'object', properties: t.input, required: t.required ?? Object.keys(t.input) },
          })),
        })
      case 'tools/call': {
        const tool = tools.find((t) => t.name === m.params?.name)
        if (!tool) return fail(-32602, `Unknown tool ${m.params?.name}`)
        try {
          const text = await tool.run(m.params?.arguments ?? {})
          return ok({ content: [{ type: 'text', text }] })
        } catch (e) {
          return ok({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true })
        }
      }
      default:
        return fail(-32601, `Method not found: ${m.method}`)
    }
  }
}
