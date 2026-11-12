import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, totalmem } from 'node:os'
import { join } from 'node:path'
import type { LocalSetup, Pull } from '../shared/types'
import { env, isWin, launch, which } from './system'
import { PROVIDERS } from './agents/http'

const DOWNLOAD: Record<string, string> = {
  ollama: 'https://ollama.com/download',
  lmstudio: 'https://lmstudio.ai',
  llamacpp: 'https://github.com/ggml-org/llama.cpp',
}

// Desktop apps that bring their own server. Linux installs are plain binaries, found on PATH.
function appPath(id: string) {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const places: Record<string, string[]> = {
    ollama: process.platform === 'darwin'
      ? ['/Applications/Ollama.app', join(homedir(), 'Applications/Ollama.app')]
      : isWin ? [join(local, 'Programs', 'Ollama', 'ollama app.exe')] : [],
    lmstudio: process.platform === 'darwin'
      ? ['/Applications/LM Studio.app', join(homedir(), 'Applications/LM Studio.app')]
      : isWin ? [join(local, 'Programs', 'LM Studio', 'LM Studio.exe'), join(local, 'Programs', 'lm-studio', 'LM Studio.exe')] : [],
  }
  return (places[id] ?? []).find((p) => existsSync(p)) ?? ''
}

// The largest model that leaves room for everything else open on the machine. Sizes are the
// download as Ollama lists it.
export function suggest(): { model: string; size: string } {
  const gb = totalmem() / 2 ** 30
  if (gb <= 13) return { model: 'qwen3.5:4b', size: '3.3 GB' }
  if (gb <= 24) return { model: 'qwen3.5:9b', size: '6.6 GB' }
  if (gb <= 40) return { model: 'qwen3.6:27b', size: '17 GB' }
  return { model: 'qwen3-coder:30b', size: '19 GB' }
}

export async function localSetup(id: string, bin: string): Promise<LocalSetup> {
  const app = appPath(id)
  const cli = await which(bin)
  return { installed: !!(app || cli), running: false, app: !!app, download: DOWNLOAD[id], suggest: id === 'ollama' ? suggest() : undefined }
}

async function up(id: string, ms: number) {
  const base = PROVIDERS[id].base
  const probe = id === 'ollama' ? `${base}/tags` : `${base}/models`
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 400))) {
    if (await fetch(probe, { signal: AbortSignal.timeout(800) }).then((r) => r.ok, () => false)) return true
  }
  return false
}

// Starts the server the way its maker intends: the desktop app where there is one, otherwise the
// command line server, detached so it outlives Lunchbox like it would from a terminal.
export async function start(id: string): Promise<{ ok: boolean; error?: string }> {
  const app = appPath(id)
  const detached = { detached: true, stdio: 'ignore' as const, env: await env(), windowsHide: true }
  if (id === 'lmstudio') {
    const lms = (await which('lms')) || join(homedir(), '.lmstudio', 'bin', isWin ? 'lms.exe' : 'lms')
    if (existsSync(lms)) launch(lms, ['server', 'start'], detached).unref()
    else if (app) open(app)
    else return { ok: false, error: 'LM Studio is not installed' }
    return (await up(id, 20000)) ? { ok: true } : { ok: false, error: 'LM Studio opened, but its server is off. Turn it on under Developer, or run: lms server start' }
  }
  if (id === 'ollama') {
    if (app) open(app)
    else {
      const bin = await which('ollama')
      if (!bin) return { ok: false, error: 'Ollama is not installed' }
      launch(bin, ['serve'], detached).unref()
    }
    return (await up(id, 15000)) ? { ok: true } : { ok: false, error: 'Ollama did not start. Try opening it yourself once.' }
  }
  return { ok: false, error: 'Start llama-server with a model, for example: llama-server -hf ggml-org/gemma-3-4b-it-GGUF' }
}

function open(app: string) {
  if (process.platform === 'darwin') spawn('open', ['-a', app], { detached: true, stdio: 'ignore' }).unref()
  else spawn(app, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

const pulls = new Map<string, AbortController>()

// Ollama streams pull progress one layer at a time; the biggest layer is the model itself, so
// its numbers are the ones worth showing.
export async function pull(model: string, report: (p: Pull) => void) {
  if (pulls.has(model)) return
  const ctl = new AbortController()
  pulls.set(model, ctl)
  const state: Pull = { agent: 'ollama', model, status: 'Starting', done: 0, total: 0 }
  let last = 0
  const send = (force = false) => {
    if (!force && Date.now() - last < 120) return
    last = Date.now()
    report({ ...state })
  }
  try {
    const res = await fetch(`${PROVIDERS.ollama.base}/pull`, { method: 'POST', body: JSON.stringify({ model, stream: true }), signal: ctl.signal })
    if (!res.ok || !res.body) throw new Error(`Ollama said ${res.status}`)
    const reader = res.body.getReader()
    const text = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += text.decode(value, { stream: true })
      let at
      while ((at = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, at).trim()
        buf = buf.slice(at + 1)
        if (!line) continue
        const o = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string }
        if (o.error) throw new Error(o.error)
        state.status = o.status ?? state.status
        if (o.total && o.total >= state.total) {
          state.total = o.total
          state.done = o.completed ?? state.done
        }
        send()
      }
    }
    state.finished = true
    state.status = 'Ready'
  } catch (e) {
    state.error = ctl.signal.aborted ? 'Stopped' : (e as Error).message
  } finally {
    pulls.delete(model)
    send(true)
  }
}

export const cancelPull = (model: string) => pulls.get(model)?.abort()
