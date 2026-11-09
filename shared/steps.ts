// What an agent is doing right now, from the step its tool reports. Every CLI names a shell
// command differently, so they all become "$ <command>" here before anything reads them.

export type Search = { source: 'X' | 'the web'; query: string; filters: string[] }
export type Step = { verb: string; text: string; search?: Search }

const SHELL = /^(?:\$|run_terminal_command|run_shell_command|Bash|shell|exec_command)\s+/

export function searchOf(now: string): Search | null {
  const s = now.replace(SHELL, '').replace(/^mcp__lunchbox__/, '')
  const m = s.match(/^(x[-_]search|search_x|web[-_]?search|search_web)\s+(?:"([^"]+)"|(\S+))(.*)$/i)
  if (!m) return null
  const filters: string[] = []
  if (/--top\b/.test(m[4])) filters.push('Top posts')
  if (/--latest\b/.test(m[4])) filters.push('Latest posts')
  const since = m[4].match(/--since\s+(\d+)([dhw])/)
  if (since) filters.push(`last ${since[1]} ${{ d: 'days', h: 'hours', w: 'weeks' }[since[2] as 'd' | 'h' | 'w']}`)
  return { source: /^x|_x$/i.test(m[1]) ? 'X' : 'the web', query: m[2] ?? m[3], filters }
}

export function stepOf(now: string): Step {
  const search = searchOf(now)
  if (search) return { verb: `Searching ${search.source}`, text: search.query, search }
  if (SHELL.test(now)) return { verb: 'Running', text: now.replace(SHELL, '') }
  const s = now.replace(/^mcp__lunchbox__/, '')
  if (s.startsWith('make_image')) return { verb: 'Waiting for the image', text: '' }
  const [tool, ...rest] = s.split(' ')
  return { verb: tool.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), text: rest.join(' ') }
}

// The same step as a sentence for the status line: "Grok is searching X for hackathon".
export function sentence(who: string, now: string) {
  const s = stepOf(now)
  if (s.search) return `${who} is searching ${s.search.source} for “${s.search.query}”`
  const verb = s.verb.replace(/^./, (c) => c.toLowerCase())
  return `${who} is ${/ing\b/.test(verb.split(' ')[0]) ? '' : 'using '}${verb}${s.text ? ` ${s.text}` : ''}`.slice(0, 110)
}
