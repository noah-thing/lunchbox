import type { Event } from './types'

// A turn's text split where each piece of help was asked for, at the paragraph break at or just
// before each point, so no sentence is cut in two.
export function cut(text: string, marks: number[]): string[] {
  const out: string[] = []
  let from = 0
  for (const m of marks) {
    let at = Math.min(Math.max(m, from), text.length)
    const near = text.indexOf('\n\n', Math.max(from, at - 2))
    if (near >= 0 && near <= at + 2) at = near
    else {
      const back = text.lastIndexOf('\n\n', at)
      if (back >= from) at = back
    }
    out.push(text.slice(from, at).trim())
    from = at
  }
  out.push(text.slice(from).trim())
  return out
}

// The room in reading order for exports: help a turn called for while it ran sits inside that
// turn, where it was asked for, instead of before the whole turn. The turn's acts and proof stay
// with its last piece.
export function weave(events: Event[]): Event[] {
  const hosts = new Set(events.flatMap((e) => (e.kind === 'say' && e.turn ? [e.turn] : [])))
  const inner = new Map<string, Event[]>()
  for (const e of events) if (e.inside && hosts.has(e.inside.turn)) inner.set(e.inside.turn, [...(inner.get(e.inside.turn) ?? []), e])
  const out: Event[] = []
  for (const e of events) {
    if (e.inside && hosts.has(e.inside.turn)) continue
    const list = e.kind === 'say' && e.turn ? inner.get(e.turn) : undefined
    if (e.kind !== 'say' || !list) { out.push(e); continue }
    const parts = cut(e.text, list.map((h) => h.inside!.mark))
    list.forEach((h, i) => {
      if (parts[i]) out.push({ ...e, id: `${e.id}:${i}`, text: parts[i], acts: [], proof: undefined, usage: undefined, error: undefined })
      out.push(h)
    })
    out.push({ ...e, text: parts[parts.length - 1] })
  }
  return out
}
