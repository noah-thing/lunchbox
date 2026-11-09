import type { Every, Flow, FlowStep } from './types'

export const EVERY: { id: Every; name: string }[] = [
  { id: 'hour', name: 'Every hour' },
  { id: 'day', name: 'Every day' },
  { id: 'weekday', name: 'Weekdays' },
  { id: 'week', name: 'Every week' },
]

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// The first time after `from` that the schedule fires, in local time. Hourly flows fire at the
// minute of `at`; the others at its hour and minute.
export function nextRun(f: Pick<Flow, 'every' | 'at' | 'day'>, from = Date.now()): number | undefined {
  if (!f.every) return undefined
  const [h, m] = (f.at ?? '09:00').split(':').map((n) => Number(n) || 0)
  const t = new Date(from)
  t.setSeconds(0, 0)
  if (f.every === 'hour') {
    t.setMinutes(m)
    if (t.getTime() <= from) t.setHours(t.getHours() + 1)
    return t.getTime()
  }
  t.setHours(h, m, 0, 0)
  for (let i = 0; i < 8; i++) {
    const ok =
      f.every === 'day' ||
      (f.every === 'weekday' && t.getDay() >= 1 && t.getDay() <= 5) ||
      (f.every === 'week' && t.getDay() === (f.day ?? 1))
    if (ok && t.getTime() > from) return t.getTime()
    t.setDate(t.getDate() + 1)
  }
  return undefined
}

export function describe(f: Pick<Flow, 'every' | 'at' | 'day'>) {
  if (!f.every) return 'When you run it'
  const at = f.at ?? '09:00'
  if (f.every === 'hour') return `Every hour at :${at.split(':')[1] ?? '00'}`
  if (f.every === 'day') return `Every day at ${at}`
  if (f.every === 'weekday') return `Weekdays at ${at}`
  return `${DAYS[f.day ?? 1]}s at ${at}`
}

// {{date}} is today, {{last}} is what the previous run ended with, so a flow can say
// "what changed since {{last}}" and pick up where it stopped.
export function fill(text: string, vars: { date: string; last?: string }) {
  return text.replace(/\{\{\s*date\s*\}\}/g, vars.date).replace(/\{\{\s*last\s*\}\}/g, vars.last?.trim() || 'nothing yet, this is the first run')
}

export type Template = { id: string; name: string; line: string; steps: FlowStep[]; every?: Every; at?: string; day?: number; pack?: string; crew: string[] }

export const TEMPLATES: Template[] = [
  {
    id: 'x-digest', name: 'Morning X digest', line: 'What your corner of X talked about overnight',
    every: 'day', at: '08:00', crew: ['grok', 'claude'], pack: 'research',
    steps: [
      { to: 'grok', text: 'Search X for the most discussed posts in the last 24 hours about AI agents, developer tools and anything else in the brief. List the ten that matter with links and why.' },
      { to: 'claude', text: 'Turn that into a five minute morning read: three themes, the posts behind each, and one thing worth replying to. Compare with the last digest: {{last}}' },
    ],
  },
  {
    id: 'nightly-check', name: 'Nightly health check', line: 'Tests, types and dependencies, fixed before you wake up',
    every: 'weekday', at: '02:00', crew: ['codex', 'claude'], pack: 'software',
    steps: [
      { to: 'codex', text: 'Run the project\'s tests, type check and linter. Fix anything that fails with the smallest change, and run the check again to prove it.' },
      { text: 'List outdated or vulnerable dependencies. Upgrade the safe ones, run the tests again, and write a short note of what changed and what still needs a person.' },
    ],
  },
  {
    id: 'seo-week', name: 'Weekly SEO check', line: 'Rankings, broken links and quick wins',
    every: 'week', day: 1, at: '09:00', crew: ['claude', 'gemini', 'grok'], pack: 'seo',
    steps: [
      { text: 'Audit the site in this folder: titles, descriptions, headings, broken links, missing alt text and structured data. Rank the issues by impact.' },
      { to: 'grok', text: 'What are people searching for and saying this week about the topics this site covers? Five opportunities with evidence.' },
      { text: 'Fix the three highest impact issues and write the week\'s report. Last week\'s report for comparison: {{last}}' },
    ],
  },
  {
    id: 'standup', name: 'Standup notes', line: 'Yesterday\'s commits as a readable update',
    every: 'weekday', at: '09:30', crew: ['claude'],
    steps: [{ text: 'Read the git log and diffs from the last working day in this folder. Write a standup update: what shipped, what is in progress, what is blocked. Plain words, no commit hashes.' }],
  },
  {
    id: 'competitors', name: 'Competitor watch', line: 'What the competition shipped this week',
    every: 'week', day: 5, at: '16:00', crew: ['grok', 'gemini', 'claude'], pack: 'research',
    steps: [
      { to: 'grok', text: 'What did the competitors named in the brief announce or ship this week? Check X and the web, with links.' },
      { text: 'Summarise what matters for us and what we should do about it. Last week: {{last}}' },
    ],
  },
]
