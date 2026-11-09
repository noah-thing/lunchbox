import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, parse, resolve, sep } from 'node:path'
import { env, which } from './system'

// Checkpoints live in a git repository of their own, outside the folder, so they never touch the
// project's history. Files the project ignores are skipped, and so are the usual heavy folders.
const SKIP = ['node_modules/', '.git/', '.venv/', 'venv/', '__pycache__/', '.next/', '.nuxt/', 'target/', '.gradle/', '.DS_Store', '*.log', '.lunchbox/attachments/']
const SAFE_FILES = 20000
const PATCH_CAP = 120_000

export type FileChange = {
  path: string; from?: string; status: 'added' | 'modified' | 'deleted' | 'renamed'
  added: number; removed: number; binary: boolean; patch: string; cut: boolean
}

type Git = (args: string[], timeout?: number) => Promise<string>

export class Snapshots {
  private git: string | null | undefined
  private locks = new Map<string, Promise<unknown>>()

  constructor(private dir: string) {}

  async available() {
    if (this.git === undefined) this.git = (await which('git')) || null
    return !!this.git
  }

  // Too broad to snapshot: a home folder or a drive root would mean copying the whole disk.
  static fits(workspace: string) {
    const ws = resolve(workspace)
    return ws !== resolve(homedir()) && ws !== parse(ws).root && existsSync(ws)
  }

  private repo(workspace: string) {
    return join(this.dir, createHash('sha1').update(resolve(workspace)).digest('hex').slice(0, 16))
  }

  private async runner(workspace: string): Promise<Git> {
    const gitDir = this.repo(workspace)
    const e = await env({ GIT_DIR: gitDir, GIT_WORK_TREE: resolve(workspace), GIT_TERMINAL_PROMPT: '0' })
    const git: Git = (args, timeout = 30000) =>
      new Promise((done, fail) =>
        execFile(this.git!, ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', ...args], { cwd: workspace, env: e, timeout, maxBuffer: 32 << 20, windowsHide: true }, (err, out, stderr) =>
          err ? fail(new Error(String(stderr || err.message).trim().split('\n')[0])) : done(String(out))),
      )
    if (!existsSync(join(gitDir, 'HEAD'))) {
      mkdirSync(gitDir, { recursive: true })
      await git(['init', '-q'])
      await git(['config', 'user.name', 'Lunchbox'])
      await git(['config', 'user.email', 'checkpoints@lunchbox.local'])
      await git(['config', 'gc.auto', '256'])
      mkdirSync(join(gitDir, 'info'), { recursive: true })
      writeFileSync(join(gitDir, 'info', 'exclude'), SKIP.join('\n') + '\n')
    }
    return git
  }

  private serial<T>(workspace: string, job: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(workspace) ?? Promise.resolve()
    const next = prev.then(job, job)
    this.locks.set(workspace, next.catch(() => {}))
    return next
  }

  // Records the folder as it is now. Returns null when it cannot or should not be done.
  take(workspace: string, label: string): Promise<{ ref: string } | null> {
    return this.serial(workspace, async () => {
      if (!(await this.available()) || !Snapshots.fits(workspace)) return null
      try {
        const git = await this.runner(workspace)
        await git(['add', '-A', '--ignore-errors'], 60000).catch(() => {})
        const staged = await git(['ls-files', '--cached'], 20000)
        if (staged.split('\n').length > SAFE_FILES) {
          rmSync(this.repo(workspace), { recursive: true, force: true })
          return null
        }
        await git(['commit', '-q', '--allow-empty', '--no-verify', '-m', label.slice(0, 200)])
        return { ref: (await git(['rev-parse', 'HEAD'])).trim() }
      } catch {
        return null
      }
    })
  }

  // Files that differ between a checkpoint and the folder as it is now.
  changed(workspace: string, ref: string): Promise<string[]> {
    return this.serial(workspace, async () => {
      if (!(await this.available())) return []
      const git = await this.runner(workspace)
      await git(['add', '-A', '--ignore-errors'], 60000).catch(() => {})
      const out = await git(['diff', '--cached', '--name-only', ref]).catch(() => '')
      return out.split('\n').filter(Boolean)
    })
  }

  // What changed between two checkpoints, or between one and the folder as it is now: one entry per
  // file with its line counts and patch. Patches are capped so a generated file cannot flood the view.
  diff(workspace: string, from: string, to?: string): Promise<FileChange[]> {
    return this.serial(workspace, async () => {
      if (!(await this.available())) return []
      const git = await this.runner(workspace)
      let range = [from, ...(to ? [to] : [])]
      if (!to) {
        await git(['add', '-A', '--ignore-errors'], 60000).catch(() => {})
        range = ['--cached', from]
      }
      const [status, counts, patch] = await Promise.all([
        git(['diff', '--name-status', '-M', ...range]).catch(() => ''),
        git(['diff', '--numstat', '-M', ...range]).catch(() => ''),
        git(['diff', '--no-color', '--no-ext-diff', '-M', '-U3', ...range], 30000).catch(() => ''),
      ])
      const patches = new Map<string, string>()
      for (const part of patch.split(/^(?=diff --git )/m)) {
        const head = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part)
        if (head) patches.set(head[2], part.slice(part.indexOf('\n') + 1))
      }
      const lines = counts.split('\n').filter(Boolean).map((l) => l.split('\t'))
      return status.split('\n').filter(Boolean).map((l, i): FileChange => {
        const [code, a, b] = l.split('\t')
        const path = b ?? a
        const [add, del] = lines[i] ?? []
        const text = patches.get(path) ?? ''
        return {
          path, from: b ? a : undefined,
          status: code[0] === 'A' ? 'added' : code[0] === 'D' ? 'deleted' : code[0] === 'R' ? 'renamed' : 'modified',
          added: add === '-' ? 0 : Number(add) || 0, removed: del === '-' ? 0 : Number(del) || 0,
          binary: add === '-',
          patch: text.length > PATCH_CAP ? text.slice(0, PATCH_CAP) : text,
          cut: text.length > PATCH_CAP,
        }
      })
    })
  }

  // Puts the folder back the way it was at `ref`. What is there now is kept as a checkpoint first,
  // so a rewind can itself be undone.
  async restore(workspace: string, ref: string) {
    const undo = await this.take(workspace, 'Before rewind')
    if (!undo) throw new Error('Could not record the folder before rewinding, so nothing was changed.')
    return this.serial(workspace, async () => {
      const git = await this.runner(workspace)
      const added = (await git(['diff', '--name-only', '--diff-filter=A', ref, undo.ref])).split('\n').filter(Boolean)
      const root = resolve(workspace) + sep
      for (const f of added) {
        const abs = resolve(workspace, f)
        if (abs.startsWith(root)) rmSync(abs, { force: true })
      }
      if ((await git(['ls-tree', '--name-only', ref])).trim()) await git(['checkout', ref, '--', '.'])
      await git(['reset', '-q', undo.ref])
      return { undo: undo.ref, removed: added.length }
    })
  }
}
