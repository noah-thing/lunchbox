import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { WorkshopChange, WorkshopState } from '../shared/types'
import { capture, env, isWin, launch, which } from './system'

// The Workshop is the person's own copy of Lunchbox's source: the release they run, checked out
// on a branch called mine, where their agents add what they want. Their changes are commits on
// top of the release tag, so a new release is the same commits moved onto the new tag. Lunchbox
// can open their build in place of itself, and falls back to itself whenever that build fails.

const REPO = process.env.LB_WORKSHOP_REPO || 'https://github.com/noah-thing/lunchbox.git'
const BRANCH = 'mine'
// How long the standard app waits for the person's build to show a window before it takes over.
const START_WAIT = 25_000

type Saved = { base?: string; use?: boolean; start?: { at: number; ok: boolean }; failed?: string }

const MINE = !!process.env.LUNCHBOX_WORKSHOP
const tagOf = (version: string) => process.env.LB_WORKSHOP_REF || `v${version}`

export class Workshop {
  readonly dir: string
  private file: string
  private saved: Saved
  private busy: WorkshopState['busy']
  // The idea waiting for the first setup to finish, and the room it then started in.
  waiting?: string
  launched?: { room: string; at: number }
  private child: ReturnType<typeof launch> | null = null

  constructor(private data: string, private emit: (state: WorkshopState) => void) {
    this.dir = process.env.LB_WORKSHOP_DIR || join(data, 'workshop')
    this.file = join(data, 'workshop.json')
    this.saved = read(this.file)
  }

  private save(patch: Partial<Saved>) {
    this.saved = { ...this.saved, ...patch }
    writeFileSync(this.file, JSON.stringify(this.saved, null, 2))
  }

  isReady() {
    return this.ready()
  }

  private ready() {
    return existsSync(join(this.dir, '.git')) && existsSync(join(this.dir, 'node_modules')) && !!this.saved.base
  }

  private built() {
    return existsSync(join(this.dir, 'out', 'main.cjs')) && !!electronIn(this.dir)
  }

  async state(): Promise<WorkshopState> {
    const ready = this.ready()
    const [git, node, npm] = await Promise.all([tool('git'), tool('node'), tool('npm')])
    return {
      ready,
      dir: this.dir,
      base: this.saved.base,
      current: tagOf(app.getVersion()),
      mine: MINE,
      use: !!this.saved.use,
      built: ready && this.built(),
      changes: ready ? await this.changes() : [],
      needs: { git, node, npm },
      busy: this.busy,
      failed: this.saved.failed,
      waiting: this.waiting,
      launched: this.launched,
    }
  }

  private async push() {
    this.emit(await this.state())
  }

  // Everything that differs from the release: committed on mine, edited, or new and not yet added.
  async changes(): Promise<WorkshopChange[]> {
    const base = this.saved.base
    if (!base) return []
    const e = await env()
    const git = await which('git')
    const stat = await capture(git, ['-C', this.dir, 'diff', '--numstat', base, '--', '.', ':(exclude)package-lock.json'], 15000, e)
    const out: WorkshopChange[] = stat.split('\n').flatMap((l) => {
      const m = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
      return m ? [{ file: m[3], added: Number(m[1]) || 0, removed: Number(m[2]) || 0 }] : []
    })
    const fresh = await capture(git, ['-C', this.dir, 'ls-files', '--others', '--exclude-standard'], 15000, e)
    for (const f of fresh.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (!out.some((c) => c.file === f)) out.push({ file: f, added: 0, removed: 0, fresh: true })
    }
    return out
  }

  // Runs one step of a longer job and keeps the last lines it printed, so the page can show what
  // is happening and, when it fails, why.
  private async step(label: string, file: string, args: string[]) {
    this.busy = { step: label, log: [], at: Date.now() }
    void this.push()
    const e = await env({ CI: '1', npm_config_fund: 'false', npm_config_audit: 'false', npm_config_update_notifier: 'false' })
    await new Promise<void>((done, fail) => {
      const p = launch(file, args, { cwd: existsSync(this.dir) ? this.dir : this.data, env: e, stdio: ['ignore', 'pipe', 'pipe'] })
      this.child = p
      const add = (b: Buffer) => {
        const lines = b.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n|\r/).map((l) => l.trimEnd()).filter(Boolean)
        if (!lines.length || !this.busy) return
        this.busy.log = [...this.busy.log, ...lines].slice(-12)
        void this.push()
      }
      p.stdout?.on('data', add)
      p.stderr?.on('data', add)
      p.on('error', fail)
      p.on('close', (code) => {
        this.child = null
        if (code === 0) done()
        else fail(new Error(`${label} stopped (exit ${code}). ${this.busy?.log.at(-1) ?? ''}`.trim()))
      })
    })
  }

  private async job(run: () => Promise<void>) {
    if (this.busy && !this.busy.error) throw new Error('The Workshop is already busy')
    try {
      await run()
      this.busy = undefined
    } catch (e) {
      this.busy = { ...(this.busy ?? { step: 'Workshop', log: [], at: Date.now() }), error: (e as Error).message }
    }
    await this.push()
    return this.state()
  }

  private async needs() {
    const [git, npm] = await Promise.all([which('git'), which('npm')])
    if (!git) throw new Error('Git is needed. Install it from git-scm.com, then try again.')
    if (!npm) throw new Error('Node.js is needed. Install the LTS version from nodejs.org, then try again.')
    return { git, npm }
  }

  private async install(npm: string) {
    await this.step('Installing what it needs', npm, [existsSync(join(this.dir, 'package-lock.json')) ? 'ci' : 'install', '--no-audit', '--no-fund'])
  }

  private async build(npm: string) {
    await this.step('Building your version', npm, ['run', 'build'])
  }

  setup() {
    return this.job(async () => {
      const { git, npm } = await this.needs()
      const tag = tagOf(app.getVersion())
      if (!existsSync(join(this.dir, '.git'))) {
        await this.step(`Copying Lunchbox ${app.getVersion()}`, git, ['clone', '--branch', tag, REPO, this.dir])
        await this.step('Making your branch', git, ['-C', this.dir, 'checkout', '-b', BRANCH])
      }
      await this.install(npm)
      this.save({ base: tag })
      await this.build(npm)
    })
  }

  // Changes the agents left uncommitted become one commit, so moving and sending them is exact.
  private async commit(git: string, message: string) {
    const e = await env()
    const named = (await capture(git, ['-C', this.dir, 'config', 'user.email'], 4000, e)).trim()
    const who = named ? [] : ['-c', 'user.name=Lunchbox Workshop', '-c', 'user.email=workshop@lunchbox.local']
    await capture(git, ['-C', this.dir, 'add', '-A'], 15000, e)
    const staged = await capture(git, ['-C', this.dir, 'diff', '--cached', '--name-only'], 15000, e)
    if (staged.trim()) await this.step('Saving your changes', git, [...who, '-C', this.dir, 'commit', '-q', '-m', message])
  }

  // Builds the person's version and hands over to it.
  open() {
    return this.job(async () => {
      const { npm } = await this.needs()
      if (!this.ready()) throw new Error('Set up the Workshop first')
      if (this.saved.base !== tagOf(app.getVersion())) throw new Error('Bring your changes to this version of Lunchbox first')
      await this.build(npm)
      this.save({ use: true, failed: undefined })
      this.busy = { step: 'Opening your version', log: [], at: Date.now() }
      await this.push()
      if (!(await this.handover())) throw new Error(this.saved.failed ?? 'Your version did not open')
    })
  }

  // In the person's own build: back to the standard app, which stays standard from now on.
  back() {
    this.save({ use: false })
    // The standard app this build was started from, or where an installer puts it when this build
    // was started some other way.
    const standard = process.env.LUNCHBOX_STANDARD ?? [
      '/Applications/Lunchbox.app/Contents/MacOS/Lunchbox',
      join(homedir(), 'Applications', 'Lunchbox.app', 'Contents', 'MacOS', 'Lunchbox'),
      join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Lunchbox', 'Lunchbox.exe'),
    ].find((p) => process.platform !== 'linux' && existsSync(p))
    if (!standard || !existsSync(standard)) throw new Error('The standard Lunchbox could not be found from here. Quit this one and open Lunchbox again, and the standard one opens.')
    app.releaseSingleInstanceLock()
    spawn(standard, [], { detached: true, stdio: 'ignore', env: withoutMine() }).unref()
    app.quit()
    return true
  }

  // Called by the standard app as it starts. True when the person's build took over, in which case
  // this process quits; false to carry on as usual. A build that failed to show a window last time
  // is not tried again until the person asks.
  async takeOver() {
    if (MINE || !this.saved.use) return false
    if (this.saved.start && !this.saved.start.ok) {
      this.save({ use: false, failed: 'Your version did not open last time, so the standard Lunchbox opened instead.' })
      return false
    }
    if (!this.ready() || !this.built() || this.saved.base !== tagOf(app.getVersion())) return false
    return this.handover()
  }

  private async handover() {
    const electron = electronIn(this.dir)
    if (!electron) return false
    this.save({ start: { at: Date.now(), ok: false } })
    app.releaseSingleInstanceLock()
    const child = spawn(electron, [this.dir], {
      detached: true,
      stdio: 'ignore',
      // From the person's own build, the way back is still the standard app it was started from.
      env: { ...process.env, LUNCHBOX_WORKSHOP: '1', LUNCHBOX_STANDARD: process.env.LUNCHBOX_STANDARD || process.execPath, LUNCHBOX_USER_DATA: app.getPath('userData') },
    })
    child.unref()
    const exited = new Promise<boolean>((done) => child.once('exit', () => done(false)))
    const shown = new Promise<boolean>((done) => {
      const t0 = Date.now()
      const tick = () => {
        if (read(this.file).start?.ok) return done(true)
        if (Date.now() - t0 > START_WAIT) return done(true)
        setTimeout(tick, 250)
      }
      tick()
    })
    if (await Promise.race([shown, exited])) {
      app.exit(0)
      return true
    }
    // It quit before showing a window: this app keeps the profile and says so.
    app.requestSingleInstanceLock()
    this.save({ use: false, start: undefined, failed: 'Your version closed before it opened a window. The standard Lunchbox is open instead; ask an agent in the Workshop to fix it.' })
    await this.push()
    return false
  }

  // The person's build reports that it is up, so the standard app can step aside.
  started() {
    if (MINE) this.save({ start: { at: Date.now(), ok: true } })
  }

  dismiss() {
    this.save({ failed: undefined })
    return this.state()
  }

  stopUsing() {
    this.save({ use: false })
    return this.state()
  }

  // Back to the release exactly as it shipped. The person confirms this in the app first.
  reset() {
    return this.job(async () => {
      const { git } = await this.needs()
      const base = this.saved.base
      if (!base) throw new Error('Set up the Workshop first')
      await this.step('Undoing your changes', git, ['-C', this.dir, 'reset', '--hard', base])
      await this.step('Removing new files', git, ['-C', this.dir, 'clean', '-fd'])
      this.save({ use: false })
    })
  }

  // Moves the person's commits onto the release they now run. When the two disagree, the move is
  // undone and the caller hands the job to an agent instead.
  update() {
    let conflict = false
    return this.job(async () => {
      const { git, npm } = await this.needs()
      const from = this.saved.base
      const to = tagOf(app.getVersion())
      if (!from) throw new Error('Set up the Workshop first')
      if (from === to) return
      await this.commit(git, 'Workshop changes')
      await this.step(`Fetching Lunchbox ${app.getVersion()}`, git, ['-C', this.dir, 'fetch', '--no-tags', REPO, `refs/tags/${to}:refs/tags/${to}`])
      try {
        await this.step('Moving your changes over', git, ['-C', this.dir, 'rebase', '--onto', to, from, BRANCH])
      } catch {
        await capture(git, ['-C', this.dir, 'rebase', '--abort'], 15000, await env())
        conflict = true
        throw new Error(`Some of your changes touch code that changed in ${to}. An agent can bring them over by hand.`)
      }
      this.save({ base: to })
      await this.install(npm)
      await this.build(npm)
    }).then((s) => ({ ...s, conflict }))
  }

  // What goes with a suggestion: a summary of the files and the change itself.
  async patch(): Promise<{ stat: string; diff: string }> {
    const { git } = await this.needs()
    const base = this.saved.base
    if (!base) throw new Error('Set up the Workshop first')
    await this.commit(git, 'Workshop changes')
    this.busy = undefined
    const e = await env()
    const scope = ['--', '.', ':(exclude)package-lock.json']
    const stat = await capture(git, ['-C', this.dir, 'diff', '--stat', base, BRANCH, ...scope], 15000, e)
    const diff = await capture(git, ['-C', this.dir, 'diff', base, BRANCH, ...scope], 15000, e)
    void this.push()
    return { stat: stat.trim(), diff }
  }

  stop() {
    if (this.child?.pid) {
      if (isWin) spawn('taskkill', ['/pid', String(this.child.pid), '/t', '/f'], { windowsHide: true })
      else try { process.kill(-this.child.pid, 'SIGTERM') } catch {}
    }
  }
}

function read(file: string): Saved {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} }
}

// The Electron binary npm put in the copy, started directly so no Node is needed to run it.
function electronIn(dir: string) {
  try {
    const rel = readFileSync(join(dir, 'node_modules', 'electron', 'path.txt'), 'utf8').trim()
    const bin = join(dir, 'node_modules', 'electron', 'dist', rel)
    return existsSync(bin) ? bin : ''
  } catch {
    return ''
  }
}

async function tool(bin: string) {
  const path = await which(bin)
  if (!path) return ''
  return (await capture(path, ['--version'], 6000, await env())).match(/\d+\.\d+(\.\d+)?/)?.[0] ?? 'installed'
}

function withoutMine() {
  const e = { ...process.env }
  delete e.LUNCHBOX_WORKSHOP
  delete e.LUNCHBOX_STANDARD
  delete e.LUNCHBOX_USER_DATA
  return e
}
