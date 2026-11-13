// What an agent is doing right now, from the step its tool reports. Every CLI names a shell
// command differently, so they all become "$ <command>" here before anything reads them.

export type Search = { source: 'X' | 'the web'; query: string; filters: string[] }
export type Step = { verb: string; text: string; search?: Search }

const SHELL = /^(?:\$|run_terminal_command|run_shell_command|Bash|shell|exec_command)\s+/

export function searchOf(now: string): Search | null {
  const s = now.replace(SHELL, '').replace(/^mcp__lunchbox__/, '')
  // Commands quote the query; the room's own tools pass it bare, so a bare query runs to the first flag.
  const m = s.match(/^(x[ _-]?search:?|x_keyword_search|search_x|web[-_]?search|websearch|google_web_search|search_web)(?:\s+(?:"([^"]+)"|([^-][^]*?)))?(\s+--.*|)\s*$/i)
  if (!m) return null
  const filters: string[] = []
  // X's own operators: since:2026-11-02 reads as a filter, not part of the words searched.
  let query = (m[2] ?? m[3] ?? '').trim()
  const date = query.match(/\bsince:(\d{4}-\d{2}-\d{2})\b/)
  if (date) {
    query = query.replace(date[0], '').trim()
    filters.push(`since ${new Date(`${date[1]}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`)
  }
  m[4] = m[4] ?? ''
  if (/--top\b/.test(m[4])) filters.push('Top posts')
  if (/--latest\b/.test(m[4])) filters.push('Latest posts')
  const since = m[4].match(/--since\s+(\d+)([dhw])/)
  if (since) filters.push(`last ${since[1]} ${{ d: 'days', h: 'hours', w: 'weeks' }[since[2] as 'd' | 'h' | 'w']}`)
  return { source: /^x|_x$/i.test(m[1]) ? 'X' : 'the web', query, filters }
}

// Tools by what they do, worded as the step a person would describe.
const VERBS: Record<string, string> = {
  Read: 'Reading', read_file: 'Reading', view: 'Reading', Write: 'Writing', write_file: 'Writing', create_file: 'Writing',
  Edit: 'Editing', MultiEdit: 'Editing', NotebookEdit: 'Editing', edit_file: 'Editing', replace: 'Editing', search_replace: 'Editing',
  Grep: 'Searching the code for', grep: 'Searching the code for', search_file_content: 'Searching the code for', Glob: 'Finding files', glob: 'Finding files',
  LS: 'Looking through', list_directory: 'Looking through', WebFetch: 'Reading', web_fetch: 'Reading', TodoWrite: 'Updating its plan', Skill: 'Using the skill',
  ToolSearch: 'Loading tools', ask_crewmate: 'Asking a crewmate', bring_in: 'Bringing in a crewmate', remember: 'Saving to room memory', room_memory: 'Reading room memory',
  propose_flow: 'Suggesting a flow', expert_look: 'Looking at', expert_audit: 'Auditing', expert_states: 'Checking hover and focus on', expert_view: 'Viewing',
}
const QUIET = new Set(['TodoWrite', 'ToolSearch', 'ask_crewmate', 'bring_in', 'remember', 'room_memory', 'propose_flow'])

// Paths are long and the folder is known; the last few parts say which file it is.
const short = (text: string) => /^\/\S+\/\S+\/\S+\/\S+$/.test(text) ? '…/' + text.split('/').slice(-3).join('/') : text

export function stepOf(now: string): Step {
  if (now.startsWith('~')) return { verb: now.slice(1), text: '' }
  const search = searchOf(now)
  if (search) return { verb: `Searching ${search.source}`, text: search.query, search }
  if (SHELL.test(now)) return { verb: 'Running', text: now.replace(SHELL, '') }
  const s = now.replace(/^mcp__lunchbox__/, '')
  if (s.startsWith('make_image')) return { verb: 'Waiting for the image', text: '' }
  const [tool, ...rest] = s.split(' ')
  const verb = VERBS[tool]
  if (verb) return { verb, text: QUIET.has(tool) ? '' : short(rest.join(' ')) }
  // Another server's tool, mcp__github__create_issue: "Using github create issue".
  const mcp = tool.match(/^mcp__(.+?)__(.+)$/)
  if (mcp) return { verb: `Using ${mcp[1]}`, text: mcp[2].replace(/_/g, ' ') }
  return { verb: tool.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), text: rest.join(' ') }
}

// The same step as a sentence for the status line: "Grok is searching X for hackathon".
export function sentence(who: string, now: string) {
  const s = stepOf(now)
  if (s.search) return `${who} is searching ${s.search.source} for “${s.search.query}”`
  const verb = s.verb.replace(/^./, (c) => c.toLowerCase())
  // A phrase the agent wrote itself may not start with a verb: "Codex: fix plan".
  if (now.startsWith('~') && !/ing\b/.test(verb.split(' ')[0])) return `${who}: ${s.verb}`.slice(0, 110)
  return `${who} is ${/ing\b/.test(verb.split(' ')[0]) ? '' : 'using '}${verb}${s.text ? ` ${s.text}` : ''}`.slice(0, 110)
}
