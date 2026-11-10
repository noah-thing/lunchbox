import { execFile, spawn, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export const isWin = process.platform === 'win32'

const comspec = () => process.env.ComSpec || 'cmd.exe'
const isBatch = (file: string) => isWin && /\.(cmd|bat)$/i.test(file)

// Never rejects: a tool that is missing, broken or a .cmd Node refuses to start reads as no output.
export function capture(file: string, args: string[], timeout = 6000, env = process.env) {
  const [cmd, argv] = isBatch(file) ? [comspec(), ['/d', '/s', '/c', `"${cmdLine(file, args)}"`]] : [file, args]
  return new Promise<string>((done) => {
    try {
      execFile(cmd, argv, { timeout, maxBuffer: 1 << 20, env, windowsHide: true, windowsVerbatimArguments: cmd !== file }, (_e, out, err) => done(String(out || err || '')))
    } catch {
      done('')
    }
  })
}

// Apps started from the Dock or a desktop launcher never see the PATH a shell profile sets up,
// which is where npm, Homebrew and ~/.local/bin usually come from. Ask the user's shell once.
let cached: Promise<string> | null = null
// Check again looks afresh, so a tool installed while the app was open is found.
export function resetPath() { cached = null }
export function loginPath() { return (cached ??= findPath()) }

async function findPath() {
  const first = process.env.LUNCHBOX_PATH?.split(delimiter) ?? []
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (isWin) {
    // Installers write the user's PATH to the registry, which this process never rereads, so the
    // usual per-user install folders are added by hand.
    const app = process.env.APPDATA, local = process.env.LOCALAPPDATA, prog = process.env.ProgramFiles
    const extra = [
      app && join(app, 'npm'), home && join(home, '.local', 'bin'), home && join(home, '.bun', 'bin'), home && join(home, '.cargo', 'bin'),
      home && join(home, 'scoop', 'shims'), local && join(local, 'pnpm'), local && join(local, 'Volta', 'bin'), local && join(local, 'Programs', 'Ollama'), prog && join(prog, 'nodejs'),
    ]
    return unique([...first, ...(process.env.Path || process.env.PATH || '').split(delimiter), ...extra])
  }
  const sh = process.env.SHELL || '/bin/zsh'
  // Interactive too, since nvm, fnm, volta, asdf, bun and pnpm set PATH up in ~/.zshrc or ~/.bashrc.
  // The marker skips whatever the rc files print; a shell that hangs falls back to a login one.
  const ask = async (flags: string, ms: number) => {
    const out = await capture(sh, [flags, 'printf "__PATH__%s__END__" "$PATH"'], ms)
    return out.match(/__PATH__(.*?)__END__/s)?.[1].trim() ?? ''
  }
  const found = (await ask('-ilc', 8000)) || (await ask('-lc', 4000))
  const extra = ['.local/bin', '.npm-global/bin', '.bun/bin', '.cargo/bin', '.volta/bin'].map((d) => `${home}/${d}`)
  return unique([...first, ...(found || process.env.PATH || '').split(delimiter), ...extra, '/opt/homebrew/bin', '/usr/local/bin'])
}

const unique = (dirs: (string | undefined | '')[]) => [...new Set(dirs.filter(Boolean))].join(delimiter)

export async function env(extra: Record<string, string> = {}) {
  return { ...process.env, PATH: await loginPath(), NO_COLOR: '1', FORCE_COLOR: '0', ...extra }
}

// The first line of `command -v` or where.exe output that is a real path. Both print other things
// too: where.exe its "INFO: Could not find files" note, the shell a builtin's bare name.
export function firstPath(out: string, win = isWin) {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => (win ? /^([a-z]:\\|\\\\)/i : /^\//).test(l))
  // npm puts an extensionless shell shim first on Windows, which cannot be started directly.
  return (win && lines.find((l) => /\.(exe|cmd|bat|com)$/i.test(l))) || lines[0] || ''
}

export async function which(bin: string) {
  if (!/^[\w.@+-]+$/.test(bin)) return ''
  const e = await env()
  if (isWin) return searchWin(bin, e.PATH) || firstPath(await capture('where.exe', [bin], 4000, e))
  return firstPath(await capture('/bin/sh', ['-c', `command -v ${bin}`], 4000, e))
}

// The search where.exe does, done here: where.exe prints in the console's code page, which mangles
// a user folder with letters outside it, while PATH arrives in Node intact.
function searchWin(bin: string, path: string) {
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter((x) => /^\.(com|exe|bat|cmd)$/i.test(x))
  const names = /\.(com|exe|bat|cmd)$/i.test(bin) ? [bin] : exts.map((x) => bin + x.toLowerCase())
  for (const dir of path.split(delimiter)) {
    const d = dir.replace(/^"|"$/g, '')
    if (!d) continue
    for (const n of names) if (existsSync(join(d, n))) return join(d, n)
  }
  return ''
}

export async function version(path: string) {
  const out = await capture(path, ['--version'], 6000, await env())
  return out.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? ''
}

// The user's own shell for `!` commands, so aliases and profiles behave as they do in a terminal.
export function shellFor(command: string) {
  // cmd.exe reads the line itself. Left to Node, every " in the command would arrive as \".
  if (isWin) return { file: comspec(), args: ['/d', '/s', '/c', `"${command}"`], raw: true }
  return { file: process.env.SHELL || '/bin/sh', args: ['-lc', command], raw: false }
}

// A .cmd or .bat line for cmd.exe. Each argument is quoted the way the program's C runtime splits
// them, then every character cmd.exe treats specially gets a caret, quotes included, so cmd never
// enters a quoted stretch where carets stop counting. It gets carets twice: an npm shim hands its
// arguments on with %*, and cmd parses them a second time there. Newlines cannot be carried at
// all, which is why connectors put long or multi-line requests in a file.
const META = /([()\][%!^"`<>&|;, *?])/g
export function cmdLine(path: string, args: string[]) {
  const arg = (s: string) => {
    const quoted = `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
    return quoted.replace(META, '^$1').replace(META, '^$1')
  }
  return [path.replace(META, '^$1'), ...args.map(arg)].join(' ')
}

// npm installs CLIs on Windows as .cmd shims, which only cmd.exe can start.
export function launch(path: string, args: string[], options: SpawnOptions) {
  if (isBatch(path)) {
    return spawn(comspec(), ['/d', '/s', '/c', `"${cmdLine(path, args)}"`], { ...options, windowsVerbatimArguments: true, windowsHide: true })
  }
  return spawn(path, args, { ...options, windowsHide: true })
}

// Stop asks politely, then insists: a process that ignores SIGTERM, or left children behind, is
// killed after three seconds so nothing keeps running or holds the room's queue.
export function stop(child: { pid?: number; exitCode?: number | null; kill: (s?: NodeJS.Signals) => boolean }) {
  if (isWin && child.pid) return void spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
  child.kill('SIGTERM')
  setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 3000).unref?.()
}
