import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Usage } from '../shared/types'

const SIZES = new Set(['1024x1024', '1536x1024', '1024x1536', 'auto'])

// Where an image goes: the path the agent asked for if it stays inside the folder, otherwise
// images/<words from the prompt>.png, numbered so nothing is overwritten.
export function target(root: string, prompt: string, asked?: string) {
  if (asked) {
    const full = resolve(root, asked)
    const rel = relative(root, full)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${asked} is outside the room's folder`)
    return /\.(png|jpe?g|webp)$/i.test(full) ? full : `${full}.png`
  }
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').filter(Boolean).slice(0, 6).join('-') || 'image'
  let path = join(root, 'images', `${slug}.png`)
  for (let n = 2; existsSync(path); n++) path = join(root, 'images', `${slug}-${n}.png`)
  return path
}

export async function openaiImage(key: string, prompt: string, path: string, size = '1024x1024', signal?: AbortSignal) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-1', prompt, size: SIZES.has(size) ? size : '1024x1024', n: 1 }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error?.message ?? `OpenAI images returned ${res.status}`)
  const b64 = body.data?.[0]?.b64_json
  if (!b64) throw new Error('OpenAI returned no image')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.from(b64, 'base64'))
  const u = body.usage ?? {}
  // gpt-image-1: $5 per million text input tokens, $40 per million image output tokens.
  const usage: Usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cached: 0, cost: (u.input_tokens ?? 0) * 5e-6 + (u.output_tokens ?? 0) * 40e-6 }
  return usage
}
