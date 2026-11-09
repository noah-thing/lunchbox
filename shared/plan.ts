import type { Event } from './types'

export type Step = { text: string; done: boolean; who: string }

const ITEM = /^\s*[-*]\s+\[( |x|X)\]\s+(.+?)\s*$/

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32)

// The newest checklist an agent wrote is the plan. Later ticks from anyone update it by matching
// the start of the step, so "- [x] Write the hero" closes "- [ ] Write the hero section".
export function plan(events: Event[]): Step[] {
  let steps: Step[] = []
  for (const e of events) {
    if (e.kind !== 'say' && e.kind !== 'hands') continue
    const text = e.kind === 'say' ? e.text : e.answer
    const who = e.kind === 'say' ? e.who : e.to
    const items = text.split('\n').map((l) => l.match(ITEM)).filter((m): m is RegExpMatchArray => !!m)
    if (!items.length) continue
    const open = items.filter((m) => m[1] === ' ').length
    if (open >= 2 || items.length >= 3) {
      const before = new Map(steps.map((s) => [key(s.text), s]))
      steps = items.map((m) => ({ text: m[2], done: m[1] !== ' ' || !!before.get(key(m[2]))?.done, who }))
      continue
    }
    for (const m of items) {
      const k = key(m[2])
      const hit = steps.find((s) => key(s.text).startsWith(k) || k.startsWith(key(s.text)))
      if (hit && m[1] !== ' ') { hit.done = true; hit.who = who }
    }
  }
  return steps
}

// A line that starts with a crewmate's handle is a request to them: "@grok: what is trending".
export function asks(text: string, handles: string[]) {
  const out: { to: string; ask: string }[] = []
  const rest: string[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*@([a-z][\w-]*)\s*[:,]\s*(.+)$/i)
    const to = m && handles.find((h) => h.toLowerCase() === m[1].toLowerCase())
    if (m && to) out.push({ to, ask: m[2].trim() })
    else rest.push(line)
  }
  return { asks: out, text: rest.join('\n').trim() }
}
