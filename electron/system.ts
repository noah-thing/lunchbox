import { execFile, spawn, type SpawnOptions } from 'node:child_process'
import { delimiter } from 'node:path'

export const isWin = process.platform === 'win32'

function capture(file: string, args: string[], timeout = 6000, env = process.env) {
  return new Promise<string>((done) =>
    execFile(file, args, { timeout, maxBuffer: 1 << 20, env, windowsHide: true }, (_e, out, err) => done(String(out || err || ''))),
  )
}

// Apps started from the Dock or a desktop launcher never see the PATH a shell profile sets up,
// which is where npm, Homebrew and ~/.local/bin usually come from. Ask a login shell once.
let cached = ''
export async function loginPath() {
  if (cached) return cached
  const first = process.env.LUNCHBOX_PATH?.split(delimiter) ?? []
  if (isWin) return (cached = [...first, process.env.Path || process.env.PATH || ''].filter(Boolean).join(delimiter))
  const sh = process.env.SHELL || '/bin/zsh'
  const out = await capture(sh, ['-lc', 'printf "__PATH__%s" "$PATH"'])
  const found = out.split('__PATH__').pop()?.trim()
  const extra = [`${process.env.HOME}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin']
  const parts = new Set([...first, ...(found || process.env.PATH || '').split(delimiter), ...extra].filter(Boolean))
  return (cached = [...parts].join(delimiter))
}

export async function env(extra: Record<string, string> = {}) {
  return { ...process.env, PATH: await loginPath(), NO_COLOR: '1', FORCE_COLOR: '0', ...extra }
}

export async function which(bin: string) {
  const e = await env()
  const out = isWin ? await capture('where.exe', [bin], 4000, e) : await capture('/bin/sh', ['-c', `command -v ${bin}`], 4000, e)
  return out.split(/\r?\n/)[0]?.trim() || ''
}

export async function version(path: string) {
  const out = await capture(path, ['--version'], 6000, await env())
  return out.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? ''
}

// The user's own shell for `!` commands, so aliases and profiles behave as they do in a terminal.
export function shellFor(command: string) {
  if (isWin) return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
  return { file: process.env.SHELL || '/bin/sh', args: ['-lc', command] }
}

const quoteWin = (s: string) => (/^[\w./:=@-]+$/.test(s) ? s : `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`)

// npm installs CLIs on Windows as .cmd shims, which only cmd.exe can start.
export function launch(path: string, args: string[], options: SpawnOptions) {
  if (isWin && /\.(cmd|bat)$/i.test(path)) {
    const line = [path, ...args].map(quoteWin).join(' ')
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true, windowsHide: true })
  }
  return spawn(path, args, { ...options, windowsHide: true })
}

export function stop(child: { pid?: number; kill: (s?: NodeJS.Signals) => boolean }) {
  if (isWin && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
  else child.kill('SIGTERM')
}
