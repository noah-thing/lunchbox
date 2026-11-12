import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { Access, Act } from '../../shared/types'
import type { Tool } from '../hands'

// What an agent that talks over HTTP works with: the room's folder, read and changed through the
// same rules the command line agents live under. A CLI brings its own file tools; a model behind
// an API has none, so these are its hands.
export type Bench = {
  root: string
  access: Access
  // Runs a command under the room's mode. The room asks the person when the mode says to.
  run(command: string): Promise<{ code: number | null; out: string; how: string; reason: string }>
  // Asks the person before a change in Ask mode. False when they say no.
  confirm(what: string): Promise<boolean>
}

export type Done = { text: string; ok: boolean; act?: Act }

const SKIP = new Set(['.git', 'node_modules', '.lunchbox', '.next', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out', 'target', '.cache', '.turbo'])
const READ_MAX = 16000
const LIST_MAX = 200
const HITS_MAX = 50
const OUT_MAX = 6000

// A path the model named, as a real place inside the room's folder. Links are followed first, so
// one that points out of the folder is refused like any other path outside it.
export function inside(root: string, path: string) {
  const base = realpathSync(resolve(root))
  const abs = resolve(base, String(path || '.').replace(/^~[\\/]/, ''))
  let at = abs
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at)
  const real = join(realpathSync(at), relative(at, abs))
  if (real !== base && !real.startsWith(base + sep)) throw new Error(`${path} is outside the room's folder. Paths are relative to the folder.`)
  if (existsSync(abs) && lstatSync(abs).isSymbolicLink() && !realpathSync(abs).startsWith(base + sep)) throw new Error(`${path} links to a place outside the room's folder.`)
  return real
}

const rel = (root: string, abs: string) => relative(realpathSync(resolve(root)), abs).split(sep).join('/') || '.'
const binary = (buf: Buffer) => buf.subarray(0, 8000).includes(0)

function list(root: string, path: string, depth: number) {
  const top = inside(root, path)
  if (!existsSync(top)) throw new Error(`There is no ${path} in the folder.`)
  if (!statSync(top).isDirectory()) return rel(root, top)
  const out: string[] = []
  const walk = (dir: string, level: number) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const e of entries) {
      if (out.length >= LIST_MAX) return
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        out.push(`${rel(root, full)}/`)
        if (level < depth && !SKIP.has(e.name)) walk(full, level + 1)
      } else out.push(rel(root, full))
    }
  }
  walk(top, 1)
  if (!out.length) return 'The folder is empty.'
  return out.join('\n') + (out.length >= LIST_MAX ? `\n(More than ${LIST_MAX} entries. List a subfolder to see the rest.)` : '')
}

function read(root: string, path: string, start: number, count: number) {
  const file = inside(root, path)
  if (!existsSync(file)) throw new Error(`There is no ${path} in the folder. Use list_directory to see what is there.`)
  if (statSync(file).isDirectory()) throw new Error(`${path} is a folder. Use list_directory.`)
  const buf = readFileSync(file)
  if (binary(buf)) return `${path} is a binary file, ${buf.length} bytes.`
  const lines = buf.toString('utf8').split('\n')
  const from = Math.max(1, Math.floor(start) || 1)
  let size = 0
  const shown: string[] = []
  for (let i = from - 1; i < lines.length && shown.length < (count > 0 ? count : Infinity); i++) {
    size += lines[i].length + 1
    if (size > READ_MAX && shown.length) break
    shown.push(lines[i])
  }
  const last = from + shown.length - 1
  const more = last < lines.length ? `\n(Lines ${from} to ${last} of ${lines.length}. Read on with start ${last + 1}.)` : ''
  return shown.join('\n') + more
}

function search(root: string, query: string, path: string) {
  if (!query.trim()) throw new Error('search_file_content needs the text to look for.')
  const top = inside(root, path)
  const needle = query.toLowerCase()
  const hits: string[] = []
  let files = 0
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (hits.length >= HITS_MAX || files > 5000) return
      const full = join(dir, e.name)
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full); continue }
      if (!e.isFile()) continue
      let buf: Buffer
      try { if (statSync(full).size > 1_000_000) continue; buf = readFileSync(full) } catch { continue }
      files++
      if (binary(buf)) continue
      const lines = buf.toString('utf8').split('\n')
      for (let i = 0; i < lines.length && hits.length < HITS_MAX; i++) {
        if (lines[i].toLowerCase().includes(needle)) hits.push(`${rel(root, full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
      }
    }
  }
  if (statSync(top).isDirectory()) walk(top)
  else return read(root, path, 1, 0).split('\n').flatMap((l, i) => (l.toLowerCase().includes(needle) ? [`${path}:${i + 1}: ${l.trim().slice(0, 200)}`] : [])).slice(0, HITS_MAX).join('\n') || 'No matches.'
  return hits.length ? hits.join('\n') + (hits.length >= HITS_MAX ? `\n(First ${HITS_MAX} matches. Narrow the search or the path.)` : '') : 'No matches.'
}

// One exact replacement. A model that copies the text slightly wrong is told so and reads again,
// instead of the file changing somewhere it did not mean.
export function replace(text: string, find: string, to: string, all: boolean) {
  if (!find) throw new Error('edit_file needs the exact text to replace in "find".')
  const n = text.split(find).length - 1
  if (!n) {
    // Models often drop or add trailing spaces and blank edges; one more try without them.
    const loose = find.trim()
    const m = loose ? text.split(loose).length - 1 : 0
    if (m === 1) return text.replace(loose, () => to.trim())
    throw new Error('The text in "find" is not in the file. Read the file again and copy the lines exactly, with their indentation.')
  }
  if (n > 1 && !all) throw new Error(`The text in "find" appears ${n} times. Include more of the lines around it so it is unique, or set all to true.`)
  return all ? text.split(find).join(to) : text.replace(find, () => to)
}

const PLAN = 'The room is in Plan mode, which only reads. Describe the change instead, and the person can switch the mode.'

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))

// Runs one tool. Never throws: what went wrong is the result, so the model can try again.
export async function use(b: Bench, name: string, a: Record<string, unknown>): Promise<Done> {
  const path = str(a.path ?? a.file ?? a.file_path ?? a.filename)
  try {
    switch (name) {
      case 'list_directory':
        return { ok: true, text: list(b.root, path || '.', Math.min(4, Number(a.depth) || 2)), act: { t: 'tool', name, detail: path || '.', ok: true } }
      case 'read_file':
        return { ok: true, text: read(b.root, path, Number(a.start) || 1, Number(a.lines) || 0), act: { t: 'tool', name, detail: path, ok: true } }
      case 'search_file_content': {
        const query = str(a.query ?? a.text ?? a.pattern)
        return { ok: true, text: search(b.root, query, path || '.'), act: { t: 'tool', name, detail: query, ok: true } }
      }
      case 'write_file':
      case 'edit_file': {
        if (b.access === 'plan') return { ok: false, text: PLAN }
        const file = inside(b.root, path)
        if (!path) throw new Error(`${name} needs a path.`)
        if (existsSync(file) && statSync(file).isDirectory()) throw new Error(`${path} is a folder.`)
        let next: string
        if (name === 'write_file') next = str(a.content ?? a.text)
        else {
          if (!existsSync(file)) throw new Error(`There is no ${path} to edit. Use write_file to create it.`)
          next = replace(readFileSync(file, 'utf8'), str(a.find ?? a.old ?? a.old_string ?? a.search), str(a.replace ?? a.new ?? a.new_string), a.all === true || a.all === 'true')
        }
        const shown = rel(b.root, file)
        if (b.access === 'ask' && !(await b.confirm(`${name === 'write_file' ? (existsSync(file) ? 'Rewrite' : 'Create') : 'Edit'} ${shown}`))) return { ok: false, text: `The person declined the change to ${shown}. Ask them what they want instead.` }
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, next)
        return { ok: true, text: `${name === 'write_file' ? 'Wrote' : 'Edited'} ${shown} (${next.split('\n').length} lines).`, act: { t: 'edit', path: shown, change: name === 'write_file' ? 'write' : 'edit' } }
      }
      case 'run_command': {
        const command = str(a.command ?? a.cmd).trim()
        if (!command) throw new Error('run_command needs a command.')
        const r = await b.run(command)
        if (r.code === null) return { ok: false, text: r.how === 'declined' ? 'The person declined that command.' : `That command was not run: it ${r.reason}.`, act: { t: 'cmd', command, exit: null } }
        const out = r.out.length > OUT_MAX ? `(earlier output cut)\n${r.out.slice(-OUT_MAX)}` : r.out
        return { ok: r.code === 0, text: `${out.trim() || '(no output)'}\nexit code ${r.code}`, act: { t: 'cmd', command, exit: r.code, out: r.out.slice(-1500) } }
      }
      default:
        return { ok: false, text: `There is no tool called ${name}. The tools are: ${names(b.access).join(', ')}.` }
    }
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : String(e), act: name === 'run_command' ? undefined : { t: 'tool', name, detail: path, ok: false } }
  }
}

type Spec = Pick<Tool, 'name' | 'description' | 'input' | 'required'>

const SPECS: Spec[] = [
  { name: 'list_directory', description: 'List the files and folders in the room\'s folder, two levels deep. Start here to see what exists.', input: { path: { type: 'string', description: 'A folder inside the room\'s folder. Leave out for the top.' } }, required: [] },
  { name: 'read_file', description: 'Read a text file in the room\'s folder. Long files come in parts; the result says where to read on from.', input: { path: { type: 'string', description: 'Path relative to the room\'s folder' }, start: { type: 'number', description: 'First line to read, from 1' }, lines: { type: 'number', description: 'How many lines to read' } }, required: ['path'] },
  { name: 'search_file_content', description: 'Find text in the files of the room\'s folder. Returns path, line number and the line for each match.', input: { query: { type: 'string', description: 'The text to look for, matched without regard to case' }, path: { type: 'string', description: 'A folder or file to search in. Leave out for the whole folder.' } }, required: ['query'] },
  { name: 'write_file', description: 'Create a file or replace its whole content. For a small change to an existing file use edit_file.', input: { path: { type: 'string', description: 'Path relative to the room\'s folder' }, content: { type: 'string', description: 'The complete content of the file' } }, required: ['path', 'content'] },
  { name: 'edit_file', description: 'Change part of a file: replaces the exact text in find with the text in replace. Read the file first and copy find from it exactly.', input: { path: { type: 'string', description: 'Path relative to the room\'s folder' }, find: { type: 'string', description: 'The exact text to replace, with enough lines around it to be unique' }, replace: { type: 'string', description: 'The text to put in its place' }, all: { type: 'boolean', description: 'Replace every occurrence instead of one' } }, required: ['path', 'find', 'replace'] },
  { name: 'run_command', description: 'Run a shell command in the room\'s folder and get its output and exit code: tests, builds, git, installs. It finishes before you continue, so never start a server that keeps running.', input: { command: { type: 'string', description: 'The command line' } }, required: ['command'] },
]

const READS = new Set(['list_directory', 'read_file', 'search_file_content', 'run_command'])

// Plan mode sees the tools that read. run_command stays, since the room refuses anything in it
// that is not a read.
export const specs = (access: Access) => (access === 'plan' ? SPECS.filter((s) => READS.has(s.name)) : SPECS)
export const names = (access: Access) => specs(access).map((s) => s.name)
