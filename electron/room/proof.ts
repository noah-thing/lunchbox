import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Event, Proof } from '../../shared/types'

type Claim = { id: string; label: string; said: RegExp; ran: RegExp }

// What an agent says against what actually ran. A claim counts as proved only when a matching
// command exited 0 after the last file edit in the room.
export const CLAIMS: Claim[] = [
  { id: 'tests', label: 'the tests pass', said: /\b(all\s+)?(the\s+)?(unit\s+|e2e\s+)?tests?\b[^.\n]{0,40}\b(pass(es|ed|ing)?|green|succeed(s|ed)?)\b|\b\d+\s+(tests?\s+)?passed\b/i, ran: /\b(test|tests|jest|vitest|mocha|pytest|rspec|phpunit|ava|tap)\b|cargo test|go test|playwright test/i },
  { id: 'build', label: 'the build works', said: /\bbuild(s|ing)?\b[^.\n]{0,30}\b(pass(es|ed)?|succeed(s|ed)?|works|is clean|green|fine)\b|\bbuilds\s+(cleanly|fine)\b/i, ran: /\bbuild\b|\btsc\b|\bmake\b|cargo build|go build/i },
  { id: 'types', label: 'the types check', said: /\b(type ?check(s|ing)?|types?)\b[^.\n]{0,30}\b(pass(es)?|clean|no errors)\b/i, ran: /\btsc\b|typecheck|mypy|pyright|vue-tsc/i },
  { id: 'lint', label: 'lint is clean', said: /\blint(s|ing|er)?\b[^.\n]{0,30}\b(pass(es)?|clean|no (errors|warnings))\b/i, ran: /\blint\b|eslint|ruff|flake8|clippy|biome|golangci/i },
  { id: 'pushed', label: 'it is pushed', said: /\b(i(?:'ve| have)?\s+)?pushed\b(?![^.\n]{0,20}\b(yet|later|soon)\b)|\bis (now )?(on|up on) (github|gitlab|the remote)\b/i, ran: /\bgit\b(?![^|;&\n]*--dry-run)[^|;&\n]*\bpush\b/i },
  { id: 'lighthouse', label: 'the Lighthouse score', said: /\blighthouse\b[^.\n]{0,40}\b(\d{2,3}|perfect|green|pass(es)?)\b/i, ran: /lighthouse|lhci/i },
]

type Step = { seq: number; command?: string; exit?: number | null; edit?: boolean }

export function history(events: Event[]) {
  const steps: Step[] = []
  let seq = 0
  for (const e of events) {
    if (e.kind === 'run') steps.push({ seq: seq++, command: e.command, exit: e.code })
    if (e.kind === 'say' || e.kind === 'hands') {
      for (const a of e.acts) {
        if (a.t === 'cmd') steps.push({ seq: seq++, command: a.command, exit: a.exit })
        if (a.t === 'edit') steps.push({ seq: seq++, edit: true })
      }
    }
  }
  return steps
}

// "I couldn't get the tests to pass" or "haven't pushed yet" is not a claim.
const DENIED = /(\bnot|n't|\bnever|\bcould not|\bcannot|\bunable|\bfail(s|ed)? to|\byet to|\bno longer)\b[^.\n]{0,40}$/i

export function check(text: string, events: Event[]): Proof[] {
  const steps = history(events)
  const lastEdit = steps.filter((s) => s.edit).pop()?.seq ?? -1
  const out: Proof[] = []
  for (const c of CLAIMS) {
    const hit = text.match(c.said)
    if (!hit || DENIED.test(text.slice(Math.max(0, hit.index! - 60), hit.index!)) || /^\S*\s*pushed (back|through|aside|out)\b/i.test(text.slice(hit.index!, hit.index! + 30))) continue
    const runs = steps.filter((s) => s.command && c.ran.test(s.command))
    const after = runs.filter((s) => s.seq > lastEdit)
    const passed = after.filter((s) => s.exit === 0).pop()
    if (passed) out.push({ claim: c.label, ok: true, text: `\`${passed.command}\` ran after the last edit, exit 0`, command: passed.command })
    else if (after.length) {
      const last = after[after.length - 1]
      out.push({ claim: c.label, ok: false, text: `\`${last.command}\` exited ${last.exit ?? 'without a code'}`, command: last.command })
    } else if (runs.length) out.push({ claim: c.label, ok: false, text: 'the last matching command ran before the latest edit' })
    else out.push({ claim: c.label, ok: false, text: 'no matching command has run in this room' })
  }
  return out
}

// The command that would settle a claim in this folder, if the project says how.
export function suggest(claim: string, cwd: string): string | null {
  const id = CLAIMS.find((c) => c.label === claim)?.id
  const has = (f: string) => existsSync(join(cwd, f))
  let scripts: Record<string, string> = {}
  try { scripts = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).scripts ?? {} } catch {}
  const npm = (name: string) => (scripts[name] && !/no test specified/.test(scripts[name]) ? (name === 'test' ? 'npm test' : `npm run ${name}`) : null)
  switch (id) {
    case 'tests': return npm('test') ?? (has('Cargo.toml') ? 'cargo test' : has('go.mod') ? 'go test ./...' : has('pyproject.toml') || has('pytest.ini') ? 'pytest' : null)
    case 'build': return npm('build') ?? (has('Cargo.toml') ? 'cargo build' : has('go.mod') ? 'go build ./...' : has('Makefile') ? 'make' : null)
    case 'types': return npm('typecheck') ?? (has('tsconfig.json') ? 'npx tsc --noEmit' : null)
    case 'lint': return npm('lint')
    default: return null
  }
}
