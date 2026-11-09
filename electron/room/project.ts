import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Block, RoomMeta } from '../../shared/types'

const START = '<!-- lunchbox:memory -->'
const END = '<!-- /lunchbox:memory -->'
const FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']
const KEEP = 1600

const rank = (b: Block) => (b.id === 'brief' ? 0 : b.id === 'decisions' ? 1 : b.id.startsWith('pin-') || b.id.startsWith('note-') ? 2 : b.id === 'files' ? 4 : 3)

export function section(meta: RoomMeta) {
  const blocks = [...meta.blocks].sort((a, b) => rank(a) - rank(b) || b.at - a.at).slice(0, 12)
  const body = blocks.map((b) => {
    const text = b.text.length > KEEP ? b.text.slice(0, KEEP).replace(/\s+\S*$/, '') + ' …' : b.text
    return `### ${b.title}\n\n${text.trim()}`
  })
  return [
    START,
    `## What the Lunchbox room "${meta.name}" knows`,
    '',
    'Kept up to date by Lunchbox from the room\'s shared memory. Edit the room, not this section; it is rewritten on every change.',
    '',
    body.join('\n\n'),
    END,
  ].join('\n')
}

// Replaces our section in place and leaves everything else in the file alone.
export function merge(existing: string, block: string) {
  const a = existing.indexOf(START)
  const b = existing.indexOf(END)
  if (a >= 0 && b > a) return existing.slice(0, a) + block + existing.slice(b + END.length)
  if (!existing.trim()) return block + '\n'
  return existing.replace(/\s*$/, '\n\n') + block + '\n'
}

export function strip(existing: string) {
  const a = existing.indexOf(START)
  const b = existing.indexOf(END)
  if (a < 0 || b < a) return existing
  const head = existing.slice(0, a).replace(/\s*$/, '')
  const tail = existing.slice(b + END.length).replace(/^\s*/, '')
  const rest = [head, tail].filter(Boolean).join('\n\n')
  return rest ? rest + '\n' : ''
}

// AGENTS.md always (Codex, Grok and most other tools read it); CLAUDE.md and GEMINI.md only
// when the project already has them, so the folder does not fill up with files.
export function writeMemory(meta: RoomMeta) {
  const block = section(meta)
  const written: string[] = []
  for (const name of FILES) {
    const file = join(meta.workspace, name)
    if (name !== 'AGENTS.md' && !existsSync(file)) continue
    const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const after = merge(before, block)
    if (after !== before) writeFileSync(file, after)
    written.push(name)
  }
  return written
}

export function clearMemory(workspace: string) {
  for (const name of FILES) {
    const file = join(workspace, name)
    if (!existsSync(file)) continue
    const before = readFileSync(file, 'utf8')
    const after = strip(before)
    // A file that held nothing but the room's memory goes away with it.
    if (!after.trim()) rmSync(file, { force: true })
    else if (after !== before) writeFileSync(file, after)
  }
}
