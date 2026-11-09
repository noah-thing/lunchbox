import { app, net } from 'electron'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { join } from 'node:path'
import type { AgentInfo, Report } from '../shared/types'

// Reports go to a small function that files them as issues in a private reports repo; the app never
// holds a GitHub token. When it can't be reached, a report waits in the outbox and goes later.
const ENDPOINT = 'https://lunchbox-report.vercel.app/api/report'

type Logged = { at: number; where: 'main' | 'window'; message: string }
const errors: Logged[] = []

// Paths name the person, so the home folder is written as ~ in anything that leaves the machine.
const SECRET = /\b(sk-[\w-]{12,}|sk-ant-[\w-]{12,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|xai-\w{20,}|AIza[\w-]{30,}|\d{6,}:[\w-]{30,}|gsk_\w{20,}|hf_\w{20,}|xox[a-z]-[\w-]{10,}|A[KS]IA[0-9A-Z]{16}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,})|(bearer\s+)[\w.-]{16,}/gi
// The home folder as it is written, and as Windows paths turn up in stack traces and JSON: with
// forward slashes, inside a file: URL, and with doubled backslashes.
const homeForms = (dir: string) => {
  const slashed = dir.replace(/\\/g, '/')
  return [...new Set([dir, slashed, encodeURI(slashed), dir.replace(/\\/g, '\\\\')])].sort((a, b) => b.length - a.length)
}
const home = new RegExp(homeForms(homedir()).map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi')
// Paths name the person and keys must never travel: the home folder becomes ~ and anything shaped
// like a key or token is replaced before a report leaves the machine.
// The keys this app holds are taken out by value as well, whatever they look like.
const clean = (s: string, max = 2000, keys: string[] = []) =>
  keys.filter((k) => k.length >= 8).reduce((t, k) => t.split(k).join('[removed]'), s).replace(home, '~').replace(SECRET, (_m, _k, bearer) => `${bearer ?? ''}[removed]`).slice(0, max)

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

export async function send(r: Report, dir: string, keys: string[] = []): Promise<{ ok: boolean; queued?: boolean; number?: number }> {
  const report: Report = {
    kind: (['bug', 'idea', 'question'] as const).includes(r.kind) ? r.kind : 'bug',
    text: clean(String(r.text ?? ''), 8000, keys),
    contact: r.contact ? clean(String(r.contact), 200, keys) : undefined,
    context: r.context ? clean(String(r.context), 4000, keys) : undefined,
    diagnostics: r.diagnostics ? clean(String(r.diagnostics), 6000, keys) : undefined,
  }
  try {
    const { number } = await post(report)
    return { ok: true, number }
  } catch (e) {
    // A report the service refused for good is not kept; one that couldn't reach it waits.
    if (/answered 4(?!29)\d\d/.test(String((e as Error).message))) return { ok: false }
    queue(dir, [report])
    return { ok: false, queued: true }
  }
}

// Reports written while offline go out at the next start.
export async function flush(dir: string) {
  const file = join(dir, 'outbox.jsonl')
  if (!existsSync(file)) return
  const waiting = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Report] } catch { return [] } })
  const left: Report[] = []
  for (const r of waiting) {
    try { await post(r) } catch (e) { if (!/answered 4(?!29)\d\d/.test(String((e as Error).message))) left.push(r) }
  }
  rmSync(file, { force: true })
  queue(dir, left)
}

// At most 50 reports wait offline; the oldest go first when there are more.
function queue(dir: string, add: Report[]) {
  const file = join(dir, 'outbox.jsonl')
  const kept = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
  const all = [...kept, ...add.map((r) => JSON.stringify(r))].slice(-50)
  if (!all.length) return
  writeFileSync(`${file}.tmp`, all.join('\n') + '\n')
  renameSync(`${file}.tmp`, file)
}
