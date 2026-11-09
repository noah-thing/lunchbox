import { app, net } from 'electron'
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { join } from 'node:path'
import type { AgentInfo, Report } from '../shared/types'

// Reports go to a small function that files them as issues in the private repo; the app never
// holds a GitHub token. When it can't be reached, a report waits in the outbox and goes later.
const ENDPOINT = 'https://lunchbox-report.vercel.app/api/report'

type Logged = { at: number; where: 'main' | 'window'; message: string }
const errors: Logged[] = []

// Paths name the person, so the home folder is written as ~ in anything that leaves the machine.
const clean = (s: string) => s.split(homedir()).join('~').slice(0, 2000)

export function logError(where: Logged['where'], e: unknown) {
  const message = clean(e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e))
  errors.push({ at: Date.now(), where, message })
  if (errors.length > 30) errors.shift()
}

export function catchErrors() {
  process.on('uncaughtException', (e) => logError('main', e))
  process.on('unhandledRejection', (e) => logError('main', e))
}

export function diagnostics(agents: AgentInfo[]) {
  return [
    `Lunchbox ${app.getVersion()} on ${process.platform} ${release()} (${process.arch}), Electron ${process.versions.electron}, ${app.getLocale()}`,
    `Agents: ${agents.filter((a) => a.found).map((a) => `${a.short}${a.version ? ` ${a.version}` : ''}${a.ready ? '' : ' (not ready)'}`).join(', ') || 'none'}`,
    errors.length ? `Recent errors:\n${errors.slice(-8).map((e) => `[${new Date(e.at).toISOString()} ${e.where}] ${e.message}`).join('\n')}` : 'No errors recorded this session.',
  ].join('\n')
}

async function post(r: Report) {
  const res = await net.fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...r, version: app.getVersion(), platform: process.platform }) })
  if (!res.ok) throw new Error(`The report service answered ${res.status}`)
  return (await res.json().catch(() => ({}))) as { number?: number }
}

export async function send(r: Report, dir: string): Promise<{ ok: boolean; queued?: boolean; number?: number }> {
  const report = { ...r, text: clean(r.text).slice(0, 8000), context: r.context && clean(r.context), diagnostics: r.diagnostics && clean(r.diagnostics) }
  try {
    const { number } = await post(report)
    return { ok: true, number }
  } catch {
    appendFileSync(join(dir, 'outbox.jsonl'), JSON.stringify(report) + '\n')
    return { ok: false, queued: true }
  }
}

// Reports written while offline go out at the next start.
export async function flush(dir: string) {
  const file = join(dir, 'outbox.jsonl')
  if (!existsSync(file)) return
  const waiting = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Report] } catch { return [] } })
  rmSync(file, { force: true })
  for (const r of waiting) {
    try { await post(r) } catch { appendFileSync(file, JSON.stringify(r) + '\n') }
  }
}
