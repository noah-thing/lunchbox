import type { ChildProcess } from 'node:child_process'
import type { Access, Verdict } from '../shared/types'
import { decide, prefix } from './policy'
import { env, launch, shellFor, stop } from './system'

export type Answer = 'once' | 'always' | 'deny'
export type Ran = { code: number | null; ms: number; how: string; verdict: Verdict; out: string }
type Hooks = { verdict(v: Verdict): void; start(): void; out(text: string): void }

const running = new Map<string, ChildProcess>()
const waiting = new Map<string, (a: Answer) => void>()

export function answer(id: string, a: Answer) {
  waiting.get(id)?.(a)
  waiting.delete(id)
}

export function kill(id: string) {
  const child = running.get(id)
  if (child) stop(child)
  answer(id, 'deny')
}

const TAIL = 12000

export async function execute(req: { id: string; command: string; cwd: string; root: string; access: Access; memory: Set<string> }, hooks: Hooks): Promise<Ran> {
  const verdict = decide(req.access, req.command, req.cwd, req.root, req.memory)
  hooks.verdict(verdict)
  if (verdict.decision === 'deny') return { code: null, ms: 0, how: 'blocked', verdict, out: '' }
  let how = 'auto'
  if (verdict.decision === 'ask') {
    const a = await new Promise<Answer>((done) => waiting.set(req.id, done))
    if (a === 'deny') return { code: null, ms: 0, how: 'declined', verdict, out: '' }
    if (a === 'always') req.memory.add(prefix(req.command))
    how = a === 'always' ? 'allowed always' : 'allowed once'
  }
  const t0 = Date.now()
  const { file, args } = shellFor(req.command)
  const child = launch(file, args, { cwd: req.cwd, env: await env({ CI: '1' }), stdio: ['ignore', 'pipe', 'pipe'] })
  running.set(req.id, child)
  hooks.start()
  let out = ''
  const take = (b: Buffer) => {
    const text = b.toString()
    out = (out + text).slice(-TAIL)
    hooks.out(text)
  }
  child.stdout?.on('data', take)
  child.stderr?.on('data', take)
  const cap = setTimeout(() => stop(child), 15 * 60 * 1000)
  const code = await new Promise<number | null>((done) => {
    child.on('close', done)
    child.on('error', (e) => { take(Buffer.from(String(e))); done(-1) })
  })
  clearTimeout(cap)
  running.delete(req.id)
  return { code, ms: Date.now() - t0, how, verdict, out }
}
