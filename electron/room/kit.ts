import type { AgentInfo, Block, Every, FlowStep } from '../../shared/types'
import type { Tool } from '../hands'

export type Host = {
  me: AgentInfo
  crew: AgentInfo[]
  ready: AgentInfo[]
  nested: boolean
  canWrite: boolean
  consult(to: string, ask: string): Promise<string>
  bring(to: string, job: string, context?: string): Promise<string>
  image(prompt: string, file?: string, size?: string): Promise<string>
  memory(): Block[]
  remember(title: string, text: string): void
  offerFlow(flow: { name: string; steps: FlowStep[]; every?: Every; at?: string; day?: number }, why: string): string
  lead: boolean
}

const SEARCHERS = { x: ['grok'], web: ['gemini', 'grok'] }
const str = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} is required`)
  return v.trim()
}

// The abilities one agent can borrow from the others during its own turn. An agent answering a
// question gets the read-only part, so a question cannot start a chain of further questions.
export function kit(h: Host): Tool[] {
  const tools: Tool[] = []
  const mates = h.crew.filter((a) => a.id !== h.me.id)
  const other = (ids: string[]) => ids.map((id) => h.ready.find((a) => a.id === id)).find((a) => a && a.id !== h.me.id)

  if (!h.nested && mates.length) {
    tools.push({
      name: 'ask_crewmate',
      description: [
        'Ask another agent in this room and wait for its answer. Use it when a crewmate is clearly better placed than you, then carry on with what they say.',
        'Crew:',
        ...mates.map((a) => `- ${a.id}: ${a.short} (${a.maker}). ${a.good}.${a.tools ? '' : ' Text only.'}`),
      ].join('\n'),
      input: {
        agent: { type: 'string', enum: mates.map((a) => a.id), description: 'Who to ask' },
        question: { type: 'string', description: 'The question, complete enough to answer without the rest of your turn' },
      },
      // The list above is only advice to the model; anyone outside the crew is refused here.
      run: async (a) => {
        const to = str(a.agent, 'agent')
        if (!mates.some((m) => m.id === to)) throw new Error(`${to} is not in this room's crew. Ask one of: ${mates.map((m) => m.id).join(', ')}`)
        return h.consult(to, str(a.question, 'question'))
      },
    })
  }

  if (!h.nested && mates.length) {
    tools.push({
      name: 'bring_in',
      description: [
        'Bring a crewmate into the room for one piece of work, such as building a page, writing tests or reviewing a change, and wait until it is done. It works in the room as itself and steps out when finished; you get its report.',
        'It does not see this conversation, only the brief, the shared memory and the files changed so far. Put everything else it needs in task and context. For a quick question use ask_crewmate instead.',
      ].join('\n'),
      input: {
        agent: { type: 'string', enum: mates.map((a) => a.id), description: 'Who to bring in' },
        task: { type: 'string', description: 'What to do, complete enough to start on' },
        context: { type: 'string', description: 'Decisions, constraints or findings it needs that are not in the shared memory' },
      },
      required: ['agent', 'task'],
      run: async (a) => {
        const to = str(a.agent, 'agent')
        if (!mates.some((m) => m.id === to)) throw new Error(`${to} is not in this room's crew. Bring in one of: ${mates.map((m) => m.id).join(', ')}`)
        return h.bring(to, str(a.task, 'task'), typeof a.context === 'string' && a.context.trim() ? a.context.trim() : undefined)
      },
    })
  }

  const x = other(SEARCHERS.x)
  if (!h.nested && x) {
    tools.push({
      name: 'search_x',
      description: `Live search of posts on X, done by ${x.short}. Returns what people are saying right now, with handles, dates and links.`,
      input: { query: { type: 'string', description: 'What to look for' } },
      run: (a) => h.consult(x.id, `Search X for: ${str(a.query, 'query')}\n\nReport what people are saying right now: the main points, then the most telling posts with @handle, date and link. Keep it short and only report what you found.`),
    })
  }

  const web = other(SEARCHERS.web)
  if (!h.nested && web) {
    tools.push({
      name: 'search_web',
      description: `Current web search, done by ${web.short}. Returns a short answer with source links.`,
      input: { query: { type: 'string', description: 'What to find out' } },
      run: (a) => h.consult(web.id, `Search the web for: ${str(a.query, 'query')}\n\nAnswer briefly from current sources and list the links you used.`),
    })
  }

  if (!h.nested && h.canWrite && (h.ready.some((a) => a.id === 'openai-api') || other(['codex']))) {
    tools.push({
      name: 'make_image',
      description: 'Generate an image and save it in the room\'s folder. Returns the saved path. Describe subject, style, composition and any text exactly.',
      input: {
        prompt: { type: 'string', description: 'A full description of the image' },
        file: { type: 'string', description: 'Optional path inside the folder, for example public/hero.png' },
        size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536'], description: 'Optional, square by default' },
      },
      required: ['prompt'],
      run: (a) => h.image(str(a.prompt, 'prompt'), typeof a.file === 'string' ? a.file : undefined, typeof a.size === 'string' ? a.size : undefined),
    })
  }

  // Only the agent leading the room offers flows, and only one per room (the engine refuses more).
  if (!h.nested && h.lead) {
    tools.push({
      name: 'propose_flow',
      description: [
        'Offer the person a Lunchbox flow: work that runs by itself on a schedule, with one or more steps, each a message to the crew. It appears as a card they accept or dismiss.',
        'Use it only when the person wants something that clearly repeats (a daily digest, a weekly check, watching a page) or asks for automation. Never for one-off work, and never more than once in a room.',
      ].join('\n'),
      input: {
        name: { type: 'string', description: 'A short name, such as "Weekly competitor check"' },
        why: { type: 'string', description: 'One sentence on what it saves the person' },
        steps: { type: 'array', items: { type: 'object', properties: { text: { type: 'string', description: 'The message for this step. {{date}} is today, {{last}} the previous run\'s result, {{previous}} the previous step\'s.' } }, required: ['text'] }, description: 'One to five steps, run in order' },
        every: { type: 'string', enum: ['hour', 'day', 'weekday', 'week', 'manual'], description: 'How often it runs; manual runs only when started' },
        at: { type: 'string', description: 'Time of day as HH:MM, 24 hour. Default 09:00' },
        day: { type: 'number', description: 'For weekly flows, 0 is Sunday and 1 is Monday' },
      },
      required: ['name', 'steps', 'every'],
      run: async (a) => {
        const steps = (Array.isArray(a.steps) ? a.steps : []).map((s) => (typeof s === 'string' ? s : (s as { text?: unknown })?.text)).filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, 5).map((text) => ({ text: text.trim() }))
        if (!steps.length) throw new Error('A flow needs at least one step')
        const every = ['hour', 'day', 'weekday', 'week'].includes(String(a.every)) ? (a.every as Every) : undefined
        const at = typeof a.at === 'string' && /^\d{1,2}:\d{2}$/.test(a.at) ? a.at.padStart(5, '0') : undefined
        const day = typeof a.day === 'number' && a.day >= 0 && a.day <= 6 ? Math.floor(a.day) : undefined
        return h.offerFlow({ name: str(a.name, 'name').slice(0, 60), steps, every, at, day }, typeof a.why === 'string' ? a.why.trim().slice(0, 240) : '')
      },
    })
  }

  // Alone, the agent is sent the whole memory with each message and nobody else reads what it
  // would save, so the two memory tools would only be definitions carried on every step.
  if (!mates.length && !h.nested) return tools

  tools.push({
    name: 'room_memory',
    description: 'Read the room\'s shared memory in full: the brief, decisions, answers between agents, changed files and anything pinned.',
    input: {},
    run: async () => h.memory().map((b) => `## ${b.title}\n${b.text}`).join('\n\n') || 'The shared memory is empty.',
  })

  if (!h.nested) {
    tools.push({
      name: 'remember',
      description: 'Save a fact, decision or finding to the room\'s shared memory so every agent has it from now on.',
      input: { title: { type: 'string', description: 'A few words' }, text: { type: 'string', description: 'What to keep' } },
      run: async (a) => { h.remember(str(a.title, 'title'), str(a.text, 'text')); return 'Saved to shared memory.' },
    })
  }
  return tools
}
