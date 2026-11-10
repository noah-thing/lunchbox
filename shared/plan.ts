import type { Event } from './types'

export type Step = { text: string; done: boolean; who: string }

const ITEM = /^\s*[-*]\s+\[( |x|X)\]\s+(.+?)\s*$/

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32)

// Two step texts are the same step when one starts the other, so "Write the hero" and
// "Write the hero section" match.
const same = (a: string, b: string) => {
  const x = key(a)
  const y = key(b)
  return !!x && !!y && (x.startsWith(y) || y.startsWith(x))
}

// A step that names a crewmate, "Tests for the collector (Codex)" or "@codex: tests", is theirs.
function named(text: string, crew: { id: string; short: string }[]) {
  const tags = [...text.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].toLowerCase())
  const at = text.toLowerCase().match(/@([\w-]+)/)?.[1]
  return crew.find((a) => {
    const name = a.short.toLowerCase().replace(/[^\w ]/g, '').trim()
    return at === a.id.toLowerCase() || (!!name && tags.some((t) => new RegExp(`\\b${name}\\b`).test(t)))
  })?.id
}

// The newest checklist an agent wrote is the plan. Later ticks from anyone update it by matching
// the start of the step, so "- [x] Write the hero" closes "- [ ] Write the hero section".
// A step is credited to the agent who ticked it; an agent posting the whole list again with
// everything ticked does not take over steps that others finished.
export function plan(events: Event[], crew: { id: string; short: string }[] = []): Step[] {
  let steps: Step[] = []
  for (const e of events) {
    if (e.kind !== 'say' && e.kind !== 'hands') continue
    const text = e.kind === 'say' ? e.text : e.answer
    const who = e.kind === 'say' ? e.who : e.to
    const items = checklists(text ?? '')
    if (!items.length) continue
    if (whole(items)) {
      const before = new Map(steps.map((s) => [key(s.text), s]))
      steps = items.map((i) => {
        const prev = before.get(key(i.text))
        const done = !!i.check || !!prev?.done
        const owner = named(i.text, crew) ?? (prev?.done ? prev.who : done ? who : prev?.who ?? who)
        return { text: i.text, done, who: owner }
      })
      continue
    }
    for (const i of items) {
      const hit = steps.find((s) => same(s.text, i.text))
      if (hit && i.check) { hit.done = true; hit.who = who }
    }
  }
  return steps
}

type Item = { text: string; check?: boolean }

// A whole plan rather than a few ticks: three steps or more, or at least two still open.
const whole = (items: Item[]) => items.length >= 3 || items.filter((i) => !i.check).length >= 2

// The checklist of one message: repeated copies of a list fold into one, the way the message shows
// them, and when a message holds different lists the last whole one is the plan, as across messages.
// Blank lines do not end a list; any other line does.
function checklists(text: string): Item[] {
  const lists: Item[][] = []
  let open = false
  for (const line of text.split('\n')) {
    const m = line.match(ITEM)
    if (m) {
      if (!open) lists.push([])
      lists[lists.length - 1].push({ text: m[2], check: m[1] !== ' ' })
      open = true
    } else if (line.trim()) open = false
  }
  const folded = foldChecklists(lists, (l) => l)
  return folded.filter(whole).pop() ?? folded.pop() ?? []
}

// Agents post their checklist again as they work, with more steps ticked. Within one message the
// first copy stays where it is and takes each later state: a list whose steps are all in it ticks
// them, a fuller list that shares most of its steps replaces it, and either later copy is dropped.
// A list about something else is left alone.
export function foldChecklists<B>(blocks: B[], itemsOf: (b: B) => Item[] | undefined): B[] {
  const out: B[] = []
  const kept: Item[][] = []
  for (const b of blocks) {
    const items = itemsOf(b)
    if (!items?.length || items.some((i) => i.check === undefined)) {
      out.push(b)
      continue
    }
    const shared = (into: Item[]) => items.filter((i) => into.some((j) => same(i.text, j.text))).length
    const covered = kept.find((into) => shared(into) === items.length)
    if (covered) {
      for (const i of items) {
        const hit = covered.find((j) => same(j.text, i.text))
        if (hit) hit.check = i.check
      }
      continue
    }
    const fuller = kept.find((into) => shared(into) >= 2 && shared(into) * 2 >= into.length)
    if (fuller) {
      fuller.splice(0, fuller.length, ...items.map((i) => ({ ...i })))
      continue
    }
    kept.push(items)
    out.push(b)
  }
  return out
}

// A line that starts with a crewmate's handle is a request to them: "@grok: what is trending".
export function asks(text: string, handles: string[]) {
  const out: { to: string; ask: string }[] = []
  const rest: string[] = []
  let fenced = false
  for (const line of text.split('\n')) {
    // Only "@handle:" asks. "@codex, thanks" is talk, and a line inside a code block is code.
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const m = fenced ? null : line.match(/^\s*@([a-z][\w-]*)\s*:\s*(.+)$/i)
    const to = m && handles.find((h) => h.toLowerCase() === m[1].toLowerCase())
    if (m && to) out.push({ to, ask: m[2].trim() })
    else rest.push(line)
  }
  return { asks: out, text: rest.join('\n').trim() }
}
