import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Access, Kind, Verdict } from '../shared/types'

const RANK: Kind[] = ['read', 'write', 'network', 'outside', 'danger', 'blocked']

// Never run, whatever the access level. These end machines, not projects.
const BLOCKED = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*\s+(-[a-z]+\s+)*("|')?(\/|~|\$HOME)\/?\*?("|')?(\s|$)/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b[^|;&]*\bof=\/dev\//,
  /\bformat\s+[a-z]:/i,
  /\b(rd|rmdir)\s+\/s\b[^|;&]*\s[a-z]:\\?\s*$/i,
  /\bremove-item\b[^|;&]*-recurse[^|;&]*\s[a-z]:\\?\s*$/i,
]

const DANGER: [RegExp, string][] = [
  [/\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, 'deletes files without the bin'],
  [/\bsudo\b/, 'asks for administrator rights'],
  [/\bgit\s+push\b[^;&|]*(--force|\s-f\b|--force-with-lease)/, 'rewrites history on a remote'],
  [/\bgit\s+reset\s+--hard\b/, 'throws away uncommitted work'],
  [/\bgit\s+clean\s+-[a-z]*f/, 'deletes untracked files'],
  [/\bgit\s+checkout\s+(--\s+)?\.(\s|$)/, 'throws away uncommitted work'],
  [/\b(chmod|chown)\s+-R\b/, 'changes permissions recursively'],
  [/\b(curl|wget)\b[^|;]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/, 'runs a script straight from the internet'],
  [/\b(killall|pkill|shutdown|reboot|launchctl)\b/, 'touches the system'],
  [/\bdefaults\s+write\b/, 'changes system settings'],
  [/\bosascript\b/, 'controls other apps'],
  [/\bsecurity\s+(find|dump|delete)/, 'reads the keychain'],
  [/\b(del|erase)\s+(\/[a-z]\s+)*\/[sq]\b|\b(rd|rmdir)\s+\/s\b|\bremove-item\b[^|;&]*-recurse/i, 'deletes files without the bin'],
  [/\b(taskkill|stop-process|reg\s+(add|delete)|set-executionpolicy)\b/i, 'touches the system'],
  [/\b(iwr|invoke-webrequest|irm|invoke-restmethod)\b[^|;]*\|\s*iex\b/i, 'runs a script straight from the internet'],
]

const NETWORK = /\b(curl|wget|ssh|scp|rsync|nc|ftp|git\s+(push|pull|fetch|clone)|npm\s+(i|install|ci|publish|add|update)|npx\s|pnpm\s+(i|install|add)|yarn(\s+add|\s+install|\s*$)|bun\s+(add|install)|pip3?\s+install|uv\s+(add|pip)|brew\s+(install|upgrade)|gh\s|vercel\b|docker\s+(pull|push)|invoke-webrequest|iwr\s|invoke-restmethod|winget\s+install|choco\s+install|scoop\s+install)/i

const READ = new Set(['ls', 'cat', 'pwd', 'head', 'tail', 'wc', 'grep', 'rg', 'which', 'echo', 'printf', 'du', 'df', 'file', 'stat', 'tree', 'date', 'whoami', 'uname', 'env', 'less', 'diff', 'sort', 'uniq', 'cut', 'jq', 'true', 'type', 'command', 'basename', 'dirname', 'realpath', 'sw_vers', 'uptime', 'dir', 'where', 'findstr', 'ver', 'get-childitem', 'gci', 'get-content', 'gc', 'get-location'])
const READ_GIT = /^git\s+(status|diff|log|show|branch|remote\s+-v|rev-parse|ls-files|blame|describe|tag\s*$)/
const VERSION = /^\S+\s+(-v|--version|-V|version)\s*$/

function segments(command: string) {
  return command.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean)
}

function isRead(segment: string) {
  if (/[^>]>[^&]|^>|>>/.test(segment)) return false
  if (READ_GIT.test(segment) || VERSION.test(segment)) return true
  const [first, ...rest] = segment.split(/\s+/)
  const head = first.toLowerCase()
  if (head === 'find') return !rest.some((a) => /^-(delete|exec|execdir|ok)$/.test(a))
  if (head === 'sed') return !rest.some((a) => /^-i/.test(a))
  return READ.has(head)
}

// Paths the command names that resolve outside the workspace. Reading them is fine; writing is not.
function outside(segment: string, cwd: string, root: string) {
  const home = homedir()
  return segment.split(/\s+/).slice(1)
    .map((t) => t.replace(/^["']|["']$/g, '').replace(/^~(?=\/|$)/, home).replace(/^\$HOME/, home))
    .filter((t) => t.startsWith('/') || t.startsWith('..') || t.startsWith(home) || /^[a-z]:[\\/]/i.test(t))
    .some((t) => {
      const rel = relative(root, resolve(cwd, t))
      return rel.startsWith('..') || isAbsolute(rel)
    })
}

export function classify(command: string, cwd: string, root: string): { kind: Kind; reason: string } {
  if (BLOCKED.some((r) => r.test(command))) return { kind: 'blocked', reason: 'would wipe a disk or your home folder' }
  for (const [r, reason] of DANGER) if (r.test(command)) return { kind: 'danger', reason }
  let kind: Kind = 'read'
  let reason = 'only reads'
  const bump = (k: Kind, why: string) => { if (RANK.indexOf(k) > RANK.indexOf(kind)) { kind = k; reason = why } }
  const cwdOut = relative(root, cwd).startsWith('..')
  for (const s of segments(command)) {
    if (NETWORK.test(s)) bump('network', 'reaches the internet')
    else if (!isRead(s)) {
      if (cwdOut || outside(s, cwd, root)) bump('outside', 'writes outside the workspace')
      else bump('write', 'changes files in the workspace')
    }
  }
  return { kind, reason }
}

const AUTO: Record<Access, Kind[]> = {
  plan: ['read'],
  ask: ['read'],
  workspace: ['read', 'write'],
  full: ['read', 'write', 'network', 'outside'],
}

export function decide(access: Access, command: string, cwd: string, root: string, remembered: Set<string>): Verdict {
  const { kind, reason } = classify(command, cwd, root)
  if (kind === 'blocked') return { kind, decision: 'deny', reason }
  if (access === 'plan' && kind !== 'read') return { kind, decision: 'deny', reason: `${reason}, and Plan only reads` }
  if (AUTO[access].includes(kind) || (kind !== 'danger' && remembered.has(prefix(command)))) return { kind, decision: 'allow', reason }
  return { kind, decision: 'ask', reason }
}

// "Always" remembers the command's first two words, so `npm test` covers `npm test -- --watch` but not `npm publish`.
export const prefix = (command: string) => command.trim().split(/\s+/).slice(0, 2).join(' ')
