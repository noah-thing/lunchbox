import type { Access, Act, AgentInfo, Event, Pack, RoomMeta } from '../../shared/types'

const ACCESS: Record<Access, string> = {
  plan: 'Plan. Read only: do not edit files or run commands that change anything. Investigate and propose.',
  ask: 'Ask. You may read freely. Edits and commands need the person\'s approval; if a tool is refused, say exactly what you need and why.',
  workspace: 'Auto. Edit files and run commands inside the folder. Ask before anything outside it.',
  full: 'Full access. Still avoid anything destructive or irreversible without saying so first.',
}

const TOOL_LINES: Record<string, string> = {
  ask_crewmate: 'ask_crewmate asks a crewmate and gives you the answer without ending your turn.',
  search_x: 'search_x reads live posts on X.',
  search_web: 'search_web finds current information with sources.',
  make_image: 'make_image creates an image and saves it in the folder.',
  remember: 'remember saves a finding to the shared memory.',
  browser_open: 'browser_open, browser_click and browser_type drive the Lunchbox browser the person is watching; use it to check what you build on localhost and take browser_screenshot to show it.',
}

// Connected MCP servers are named after their id: "github_create_issue" comes from GitHub.
const connected = (tools: string[]) => {
  const own = new Set([...Object.keys(TOOL_LINES), 'room_memory'])
  const groups = new Set(tools.filter((t) => !own.has(t) && !t.startsWith('browser_')).map((t) => t.split('_')[0]))
  return groups.size ? `Connected tools from: ${[...groups].join(', ')}. Use them when they fit better than guessing.` : ''
}

export function protocol(meta: RoomMeta, me: AgentInfo, crew: AgentInfo[], access: Access, pack?: Pack, tools: string[] = []) {
  const mates = crew
    .filter((a) => a.id !== me.id)
    .map((a) => `- @${a.id}  ${a.short} (${a.maker}): ${a.good}${a.tools ? '' : '. Text only, no files or commands'}`)
  const borrowed = [...tools.map((t) => TOOL_LINES[t]).filter(Boolean), connected(tools)].filter(Boolean)
  return [
    `You are ${me.short}, one of several AI agents working with one person in a shared room in Lunchbox.`,
    `Room: ${meta.name}. Folder: ${meta.workspace}. Access: ${ACCESS[access]}`,
    me.tools ? '' : 'You cannot read files or run commands yourself. When that is needed, ask a crewmate who can.',
    mates.length ? `Your crew:\n${mates.join('\n')}` : 'You are working alone in this room.',
    borrowed.length ? `The lunchbox tools lend you your crewmates' abilities mid-turn. ${borrowed.join(' ')} Prefer them to an @handle line when you need the answer to keep working.` : '',
    [
      'How the room works:',
      mates.length ? '- To get something from a crewmate, put a line on its own: "@handle: what you need". Their answer comes back to you before you finish. Ask only when they are clearly better placed, at most two at a time.' : '',
      '- When the work has several steps, keep a short checklist with "- [ ] step" lines, and tick them with "- [x] step" as they get done.',
      '- Claims like "the tests pass" or "the build works" are checked against the commands that actually ran in this room after the last edit. Run the check before claiming it.',
      '- Write for the person: short and plain. Do not repeat what others already said.',
    ].filter(Boolean).join('\n'),
    pack ? `Room focus, ${pack.name}: ${pack.brief}` : '',
  ].filter(Boolean).join('\n\n')
}

function acts(list: Act[]) {
  const parts = list.slice(-8).map((a) => (a.t === 'cmd' ? `ran \`${a.command}\` (exit ${a.exit ?? '?'})` : a.t === 'edit' ? `edited ${a.path}` : `${a.name} ${a.detail}`.trim()))
  return parts.length ? `\n  [${parts.join('; ')}]` : ''
}

export function line(e: Event, name: (id: string) => string): string | null {
  switch (e.kind) {
    case 'you': return `Person: ${e.text}${e.files?.length ? `\n  [attached: ${e.files.join(', ')}. Read them before answering.]` : ''}`
    case 'say': return e.error && !e.text ? null : `${name(e.who)}: ${e.text}${acts(e.acts)}`
    case 'hands': return `${name(e.to)}, answering ${name(e.from)} ("${e.ask}"): ${e.answer}${acts(e.acts)}`
    case 'wall': return `[${name(e.from)} stopped (${e.reason}); ${e.to ? `${name(e.to)} took over` : 'nobody could take over'}]`
    case 'run': return `[${e.who === 'you' ? 'Person' : name(e.who)} ran \`${e.command}\`, ${e.code === null ? e.how : `exit ${e.code}`}]${e.out ? `\n${e.out.slice(-800)}` : ''}`
    case 'image': return `[${name(e.by)} made an image for ${name(e.for)}, saved as ${e.path}: ${e.prompt.slice(0, 200)}]`
    case 'chose': return `[Person chose: ${e.label}]`
    case 'pick': return `[Person picked ${name(e.who)}'s answer]`
    default: return null
  }
}

const BUDGET = 24000
// Older turns leave the window in steps of this many events, not one at a time, so the start of
// the conversation stays byte for byte the same for many turns and provider caches keep hitting.
const STEP = 12

// The conversation first, oldest to newest, because it only ever grows at the end: that makes it
// the cacheable prefix. Shared memory and the task change every turn, so they come last.
// An agent with a resumed session already holds everything up to its last turn and gets only
// what changed; any other agent gets the whole memory every turn.
export function prompt(meta: RoomMeta, events: Event[], me: string, task: string, name: (id: string) => string, resumed: boolean) {
  const seen = meta.seen[me] ?? {}
  const given = resumed ? meta.blocks.filter((b) => b.v > (seen[b.id] ?? 0)) : meta.blocks
  const memory = given.map((b) => `## ${b.title}\n${b.text.slice(0, 6000)}`).join('\n\n')
  const from = resumed ? meta.heard[me] ?? 0 : 0
  const lines = events.slice(from).map((e) => line(e, name))
  let start = lines.length
  for (let size = 0; start > 0; start--) {
    const l = lines[start - 1]
    if (!l) continue
    if (size + l.length > BUDGET && size > 0) break
    size += l.length
  }
  if (start > 0) start = Math.min(lines.length, Math.ceil(start / STEP) * STEP)
  const history = lines.slice(start).filter((l): l is string => !!l)
  const head = history.length ? `${resumed ? 'Since your last turn' : start ? 'The conversation so far, latest part' : 'The conversation so far'}:` : ''
  const tail = [
    memory ? `Shared memory, ${resumed ? 'changed since you last looked' : 'everything the room knows'}:\n\n${memory}` : '',
    task,
  ].filter(Boolean).join('\n\n---\n\n')
  const sent = given.reduce((n, b) => n + Math.min(b.text.length, 6000), 0)
  const full = meta.blocks.reduce((n, b) => n + Math.min(b.text.length, 6000), 0)
  return {
    text: [head && `${head}\n\n${history.join('\n\n')}`, tail].filter(Boolean).join('\n\n---\n\n'),
    history: head ? [head, ...history] : [],
    tail,
    sent,
    full,
    seen: Object.fromEntries(meta.blocks.map((b) => [b.id, b.v])),
  }
}
