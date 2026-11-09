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

export type Group = 'code' | 'research' | 'writing' | 'business' | 'personal'
export const GROUPS: { id: Group; name: string }[] = [
  { id: 'code', name: 'Code' },
  { id: 'research', name: 'Research' },
  { id: 'writing', name: 'Writing' },
  { id: 'business', name: 'Business' },
  { id: 'personal', name: 'Personal' },
]

export type Template = { id: string; name: string; line: string; group: Group; steps: FlowStep[]; every?: Every; at?: string; day?: number; pack?: string; crew: string[] }

// Every template works on the folder the flow runs in. Steps without `to` go to whoever the room
// routes them to. {{last}} carries the previous run's ending, so weekly flows compare themselves.
export const TEMPLATES: Template[] = [
  // Code
  {
    id: 'nightly-check', group: 'code', name: 'Nightly health check', line: 'Tests, types and lint, fixed before you wake up',
    every: 'weekday', at: '02:00', crew: ['codex', 'claude'], pack: 'software',
    steps: [
      { to: 'codex', text: 'Run the project\'s tests, type check and linter. Fix anything that fails with the smallest change, then run the check again to prove it.' },
      { to: 'claude', text: 'Review the fixes as a strict senior engineer. Undo anything that hides a problem instead of solving it, and say what a person should look at.' },
    ],
  },
  {
    id: 'deps', group: 'code', name: 'Dependency upgrades', line: 'Safe upgrades applied, risky ones explained',
    every: 'week', day: 1, at: '07:00', crew: ['codex', 'claude'], pack: 'software',
    steps: [
      { to: 'codex', text: 'List outdated and vulnerable dependencies. Apply patch and minor upgrades, run the tests after each group, and revert any group that breaks them.' },
      { to: 'claude', text: 'For each major upgrade left, read its changelog and write two lines: what breaks for us and how long the move takes. Last week: {{last}}' },
    ],
  },
  {
    id: 'standup', group: 'code', name: 'Standup notes', line: 'Yesterday\'s commits as a readable update',
    every: 'weekday', at: '09:30', crew: ['claude'],
    steps: [{ text: 'Read the git log and diffs from the last working day in this folder. Write a standup update: what shipped, what is in progress, what is blocked. Plain words, no commit hashes.' }],
  },
  {
    id: 'changelog', group: 'code', name: 'Weekly changelog', line: 'What changed this week, written for users',
    every: 'week', day: 5, at: '15:00', crew: ['claude'],
    steps: [{ text: 'Read this week\'s commits and merged changes. Write a changelog entry for users, grouped as New, Improved and Fixed. Leave out internal refactors. Append it to CHANGELOG.md at the top.' }],
  },
  {
    id: 'todo-sweep', group: 'code', name: 'TODO sweep', line: 'Finds stale TODOs and fixes the easy ones',
    every: 'week', day: 3, at: '10:00', crew: ['codex', 'claude'], pack: 'software',
    steps: [
      { to: 'codex', text: 'Find every TODO, FIXME and HACK comment. Fix the ones that take under ten minutes and prove each fix with the tests.' },
      { to: 'claude', text: 'List the rest by risk, with the file and one line on what it would take.' },
    ],
  },
  {
    id: 'security', group: 'code', name: 'Security pass', line: 'Secrets, injection and unsafe input, checked weekly',
    every: 'week', day: 2, at: '03:00', crew: ['claude', 'codex'], pack: 'software',
    steps: [
      { to: 'claude', text: 'Review this codebase for committed secrets, injection, unsafe deserialisation, missing auth checks and unvalidated input. Rank findings by how easy they are to exploit.' },
      { to: 'codex', text: 'Fix the top three findings with tests that fail before the fix and pass after. Compare with last week: {{last}}' },
    ],
  },
  {
    id: 'test-gaps', group: 'code', name: 'Test the untested', line: 'Adds tests where the code has none',
    every: 'week', day: 4, at: '02:00', crew: ['codex', 'claude'], pack: 'software',
    steps: [
      { to: 'claude', text: 'Find the most important code paths with no tests: payments, auth, data writes, anything user facing. Pick three.' },
      { to: 'codex', text: 'Write focused tests for those three paths and run them. If a test finds a real bug, stop and describe it instead of changing the test.' },
    ],
  },
  {
    id: 'site-qa', group: 'code', name: 'Website QA', line: 'Clicks through the site and reports what broke',
    every: 'day', at: '06:30', crew: ['claude'], pack: 'qa',
    steps: [{ text: 'Open the site this folder builds in the Lunchbox browser. Visit every page linked from the home page on desktop and phone sizes. Report console errors, broken links, layout breaks and slow pages, with screenshots.' }],
  },

  // Research
  {
    id: 'x-digest', group: 'research', name: 'Morning X digest', line: 'What your corner of X talked about overnight',
    every: 'day', at: '08:00', crew: ['grok', 'claude'], pack: 'research',
    steps: [
      { to: 'grok', text: 'Search X for the most discussed posts in the last 24 hours about the topics in this folder\'s brief. List the ten that matter, with links and why.' },
      { to: 'claude', text: 'Turn that into a five minute morning read: three themes, the posts behind each, and one thing worth replying to. Compare with the last digest: {{last}}' },
    ],
  },
  {
    id: 'competitors', group: 'research', name: 'Competitor watch', line: 'What the competition shipped this week',
    every: 'week', day: 5, at: '16:00', crew: ['grok', 'gemini', 'claude'], pack: 'research',
    steps: [
      { to: 'grok', text: 'What did the competitors named in this folder\'s brief announce or ship this week? Check X and the web, with links.' },
      { to: 'gemini', text: 'Check their sites, pricing pages and changelogs for changes the posts missed.' },
      { to: 'claude', text: 'Summarise what matters for us and what we should do about it. Last week: {{last}}' },
    ],
  },
  {
    id: 'papers', group: 'research', name: 'New papers', line: 'This week\'s papers in your field, read for you',
    every: 'week', day: 1, at: '08:00', crew: ['gemini', 'claude'], pack: 'research',
    steps: [
      { to: 'gemini', text: 'Find papers from the last seven days on the topics in this folder\'s brief, on arXiv and the main venues. Keep the five with the strongest results.' },
      { to: 'claude', text: 'For each: the claim in one sentence, how they tested it, and whether it changes anything for us. Skip anything already covered: {{last}}' },
    ],
  },
  {
    id: 'releases', group: 'research', name: 'Release radar', line: 'New versions of the tools you depend on',
    every: 'week', day: 2, at: '09:00', crew: ['gemini', 'claude'],
    steps: [
      { to: 'gemini', text: 'Read the dependency files in this folder. Check which of the main libraries and services had releases this week, with links to their notes.' },
      { to: 'claude', text: 'Say which releases matter for this project and why, in one line each.' },
    ],
  },
  {
    id: 'market', group: 'research', name: 'Market pulse', line: 'Prices, launches and talk in one market',
    every: 'weekday', at: '07:30', crew: ['grok', 'claude'], pack: 'research',
    steps: [
      { to: 'grok', text: 'What moved yesterday in the market named in this folder\'s brief: launches, price changes, funding, and what people on X made of it.' },
      { to: 'claude', text: 'Write it as five bullets with sources, then one line on what to watch today.' },
    ],
  },

  // Writing
  {
    id: 'blog-draft', group: 'writing', name: 'Weekly post draft', line: 'One researched draft, ready for your edit',
    every: 'week', day: 2, at: '07:00', crew: ['grok', 'claude'], pack: 'writing',
    steps: [
      { to: 'grok', text: 'What are people in our field arguing about this week? Find one question with real disagreement and the best posts on each side.' },
      { to: 'claude', text: 'Draft a 700 word post that takes a side, using notes and past posts in this folder for voice. Save it to drafts/ with today\'s date: {{date}}.' },
    ],
  },
  {
    id: 'newsletter', group: 'writing', name: 'Newsletter', line: 'The week\'s work turned into an issue',
    every: 'week', day: 4, at: '10:00', crew: ['claude', 'grok'], pack: 'writing',
    steps: [
      { text: 'Collect what happened this week from the notes, commits and documents in this folder.' },
      { to: 'grok', text: 'Add two links from the wider field that readers would want.' },
      { to: 'claude', text: 'Write the issue: a short opening, three sections, the links, one ask. Keep it under 600 words. Last issue for continuity: {{last}}' },
    ],
  },
  {
    id: 'thread', group: 'writing', name: 'Thread from a shipped thing', line: 'Turns what shipped into a post for X',
    crew: ['claude', 'grok'],
    steps: [
      { to: 'claude', text: 'Read what changed in this folder recently and pick the one thing a stranger would care about.' },
      { to: 'grok', text: 'Write it as a thread of at most six posts, the way people who do well on X write: the result first, then how, then proof. Offer two opening posts to choose from.' },
    ],
  },
  {
    id: 'docs', group: 'writing', name: 'Docs that match the code', line: 'README and docs checked against reality',
    every: 'week', day: 5, at: '11:00', crew: ['claude', 'codex'],
    steps: [
      { to: 'codex', text: 'Run every command and code sample in the README and docs. Note which ones fail or print something different.' },
      { to: 'claude', text: 'Fix the docs to match what the code does now, and list anything where the code looks wrong instead.' },
    ],
  },

  // Business
  {
    id: 'seo-week', group: 'business', name: 'Weekly SEO check', line: 'Rankings, broken links and quick wins',
    every: 'week', day: 1, at: '09:00', crew: ['claude', 'gemini', 'grok'], pack: 'seo',
    steps: [
      { text: 'Audit the site in this folder: titles, descriptions, headings, broken links, missing alt text and structured data. Rank the issues by impact.' },
      { to: 'grok', text: 'What are people searching for and saying this week about the topics this site covers? Five opportunities with evidence.' },
      { text: 'Fix the three highest impact issues and write the week\'s report. Last week\'s report for comparison: {{last}}' },
    ],
  },
  {
    id: 'leads', group: 'business', name: 'Lead list', line: 'Ten fresh companies that fit, with a reason each',
    every: 'week', day: 1, at: '08:30', crew: ['gemini', 'grok', 'claude'], pack: 'research',
    steps: [
      { to: 'gemini', text: 'Using the ideal customer in this folder\'s brief, find ten companies that fit and are not already in leads.csv. Website, size, and the signal that makes them a fit now.' },
      { to: 'grok', text: 'Check each on X for recent posts by the company or its founders that would make a good opening line.' },
      { to: 'claude', text: 'Append them to leads.csv and draft a three sentence first message for each. Do not send anything.' },
    ],
  },
  {
    id: 'reviews', group: 'business', name: 'Customer voice', line: 'What customers praised and complained about',
    every: 'week', day: 5, at: '12:00', crew: ['grok', 'claude'], pack: 'research',
    steps: [
      { to: 'grok', text: 'Find this week\'s posts, reviews and threads that mention our product by name. Quote them with links.' },
      { to: 'claude', text: 'Group them into praise, complaints and requests. Name the one fix that would change the most minds. Last week: {{last}}' },
    ],
  },
  {
    id: 'metrics', group: 'business', name: 'Monday numbers', line: 'Last week\'s numbers with the story behind them',
    every: 'week', day: 1, at: '07:30', crew: ['claude'],
    steps: [{ text: 'Read the exports and spreadsheets in this folder. Report last week\'s key numbers against the week before, explain the biggest change, and flag anything that looks like a data error. Previous report: {{last}}' }],
  },
  {
    id: 'pricing', group: 'business', name: 'Pricing check', line: 'Your prices next to the market, monthly',
    every: 'week', day: 1, at: '10:00', crew: ['gemini', 'claude'],
    steps: [
      { to: 'gemini', text: 'Collect the current public pricing of the competitors in this folder\'s brief: plans, limits and what each tier includes.' },
      { to: 'claude', text: 'Put it in a table next to ours and say where we are cheap, expensive or confusing. Changes since last time: {{last}}' },
    ],
  },

  // Personal
  {
    id: 'inbox-notes', group: 'personal', name: 'Notes tidy', line: 'Your week of notes, sorted and linked',
    every: 'week', day: 0, at: '18:00', crew: ['claude'],
    steps: [{ text: 'Read the notes in this folder written this week. Merge duplicates, give each a clear title, link related notes, and write a one page summary of open threads to WEEK.md. Never delete a note.' }],
  },
  {
    id: 'learning', group: 'personal', name: 'Learn one thing', line: 'A short daily lesson that builds on yesterday',
    every: 'weekday', at: '07:00', crew: ['claude', 'gemini'],
    steps: [
      { to: 'gemini', text: 'Read learning.md in this folder for the topic and what was covered so far, and find one good source for the next step.' },
      { to: 'claude', text: 'Write a ten minute lesson with one exercise, building on yesterday: {{last}}. Append a line to learning.md about what this lesson covered.' },
    ],
  },
  {
    id: 'trip', group: 'personal', name: 'Trip planner', line: 'Flights, stays and a day by day plan',
    crew: ['gemini', 'grok', 'claude'],
    steps: [
      { to: 'gemini', text: 'Read trip.md in this folder for where, when and the budget. Find flight options and three places to stay in the best areas, with prices and links.' },
      { to: 'grok', text: 'What are locals and recent visitors recommending right now? Food, things to skip, and anything happening on those dates.' },
      { to: 'claude', text: 'Write a day by day plan inside the budget, with the bookings to make first. Save it to trip-plan.md.' },
    ],
  },
]
