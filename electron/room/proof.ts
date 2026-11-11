import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Event, Proof } from '../../shared/types'

// A claim is settled by a command that exited 0 after the last edit, or for looks by an image
// of the work made after the last edit: a screenshot, a render, or the agent opening one.
type Claim = { id: string; label: string; said: RegExp; ran: RegExp; looked?: boolean }

// What an agent says against what actually ran. A claim counts as proved only when a matching
// command exited 0 after the last file edit in the room.
export const CLAIMS: Claim[] = [
  { id: 'tests', label: 'the tests pass', said: /\b(all\s+)?(the\s+)?(unit\s+|e2e\s+)?tests?\b[^.\n]{0,40}\b(pass(es|ed|ing)?|green|succeed(s|ed)?)\b|\b\d+\s+(tests?\s+)?passed\b/i, ran: /\b(test|tests|jest|vitest|mocha|pytest|rspec|phpunit|ava|tap)\b|cargo test|go test|playwright test/i },
  { id: 'build', label: 'the build works', said: /\bbuild(s|ing)?\b[^.\n]{0,30}\b(pass(es|ed)?|succeed(s|ed)?|works|is clean|green|fine)\b|\bbuilds\s+(cleanly|fine)\b/i, ran: /\bbuild\b|\btsc\b|\bmake\b|cargo build|go build/i },
  { id: 'types', label: 'the types check', said: /\b(type ?check(s|ing)?|types?)\b[^.\n]{0,30}\b(pass(es)?|clean|no errors)\b/i, ran: /\btsc\b|typecheck|mypy|pyright|vue-tsc/i },
  { id: 'lint', label: 'lint is clean', said: /\blint(s|ing|er)?\b[^.\n]{0,30}\b(pass(es)?|clean|no (errors|warnings))\b/i, ran: /\blint\b|eslint|ruff|flake8|clippy|biome|golangci/i },
  { id: 'pushed', label: 'it is pushed', said: /\b(i(?:'ve| have)?\s+)?pushed\b(?![^.\n]{0,20}\b(yet|later|soon)\b)|\bis (now )?(on|up on) (github|gitlab|the remote)\b/i, ran: /\bgit\b(?![^|;&\n]*--dry-run)[^|;&\n]*\bpush\b/i },
  { id: 'looks', label: 'it looks right', looked: true, said: /\b(the|this|your|my)\s+(page|site|website|design|layout|ui|screen|hero|header|footer|landing page|poster|logo|icon|banner|graphic|render|model|scene|deck|slides?)\s+(now\s+)?(looks|is looking)\s+(good|great|right|clean|polished|correct|sharp|perfect|professional|consistent)\b|\bpixel[- ]perfect\b|\bvisually (checked|verified|correct)\b/i, ran: /\bscreen(shot|capture)\b|--screenshot|\bplaywright\b[^|;&\n]*\bscreenshot\b|\bblender\b[^|;&\n]*\s-(f|a|b)\b|\brender\b/i },
  { id: 'lighthouse', label: 'the Lighthouse score', said: /\blighthouse\b[^.\n]{0,40}\b(\d{2,3}|perfect|green|pass(es)?)\b/i, ran: /lighthouse|lhci/i },
]

type Step = { seq: number; command?: string; exit?: number | null; edit?: boolean; look?: string }

// Tools that produce or open an image of the work: Lunchbox's own look and screenshot tools,
// a render, or reading a picture file.
const LOOK_TOOL = /studio_look|screenshot|render/i
const IMAGE = /\.(png|jpe?g|webp|gif|avif)\b/i

export function history(events: Event[]) {
  const steps: Step[] = []
  let seq = 0
  for (const e of events) {
    if (e.kind === 'run') steps.push({ seq: seq++, command: e.command, exit: e.code })
    if (e.kind === 'say' || e.kind === 'hands') {
      for (const a of e.acts) {
        if (a.t === 'cmd') steps.push({ seq: seq++, command: a.command, exit: a.exit })
        if (a.t === 'edit') steps.push({ seq: seq++, edit: true })
        if (a.t === 'tool' && a.ok !== false && (LOOK_TOOL.test(a.name) || (/^(read|view|image)/i.test(a.name.replace(/^mcp__\w+__/, '')) && IMAGE.test(a.detail)))) steps.push({ seq: seq++, look: `${a.name} ${a.detail}`.trim() })
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
    if (c.looked) {
      const looks = steps.filter((s) => s.look || (s.command && c.ran.test(s.command) && s.exit === 0))
      const seen = looks.filter((s) => s.seq > lastEdit).pop()
      if (seen) out.push({ claim: c.label, ok: true, text: `looked at after the last edit: ${(seen.look ?? `\`${seen.command}\``).slice(0, 120)}` })
      else out.push({ claim: c.label, ok: false, text: looks.length ? 'the last screenshot or render was taken before the latest edit' : 'no screenshot or render of it was made in this room' })
      continue
    }
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
