import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Pack } from '../shared/types'

export const BUILTIN: Pack[] = [
  {
    id: 'software', name: 'Software', line: 'Build, test and ship code',
    brief: 'This room builds software. Read the code before changing it, keep changes small, and run the project\'s own tests or build before saying something works.',
    ideas: ['Review this repo for bugs and fix the worst one', 'Add tests for the code that has none', 'Find out why the build is slow'],
    checks: [{ label: 'Run the tests', command: 'npm test' }, { label: 'Type check', command: 'npx tsc --noEmit' }],
  },
  {
    id: 'research', name: 'Research', line: 'Answers with sources',
    brief: 'This room researches. Every factual claim needs a source with a link or a file path. Say how sure you are and what would change your mind. Prefer primary sources and recent ones.',
    ideas: ['What are people on X saying about this today', 'Compare the three best options with sources', 'Summarise the latest papers on a topic'],
  },
  {
    id: 'seo', name: 'SEO', line: 'Audit and improve a site for search',
    brief: 'This room works on search visibility. Check titles, meta descriptions, headings, internal links, structured data, page speed and crawlability. Back each recommendation with the page and the evidence, and rank fixes by impact.',
    ideas: ['Audit the site in this folder for SEO issues', 'Write titles and meta descriptions for every page', 'Find keywords competitors rank for and we do not'],
    checks: [{ label: 'Lighthouse', command: 'npx --yes @lhci/cli autorun --collect.staticDistDir=.' }],
  },
  {
    id: 'writing', name: 'Writing', line: 'Draft, edit and fact check',
    brief: 'This room writes. Keep the person\'s voice. One agent drafts, another edits for clarity and cuts, and claims of fact get checked. Prefer short sentences and concrete words.',
    ideas: ['Draft a launch post from the notes in this folder', 'Edit this document for clarity and length', 'Turn this thread into a newsletter'],
  },
  {
    id: 'data', name: 'Data', line: 'Analyse files and chart what matters',
    brief: 'This room works with data. Load the files with real code, never estimate numbers by eye. Show the query or script behind every figure, say how many rows it covers, and flag missing or odd values before drawing conclusions. Save charts as PNG files in the folder.',
    ideas: ['Explore the CSV files here and tell me what stands out', 'Chart the trend in this data and explain it', 'Find the outliers and say whether they are errors'],
    checks: [{ label: 'Python available', command: 'python3 --version' }],
  },
  {
    id: 'design', name: 'Design', line: 'Interfaces, brand and images',
    brief: 'This room designs. Start from the person\'s goal and audience, propose two or three distinct directions before polishing one, and keep a short list of the decisions made. Use make_image for visuals and save them in the folder. Prefer fewer colours, clear hierarchy and real content over lorem ipsum.',
    ideas: ['Propose three directions for a landing page for this product', 'Make an app icon in three styles', 'Review this UI for hierarchy, spacing and contrast'],
  },
  {
    id: 'growth', name: 'Growth', line: 'Launches, posts and what people say',
    brief: 'This room grows an audience. Use live X and web search to see what the audience talks about right now, write in the person\'s voice, and give every post a reason to exist: a hook, one idea, a clear ask. Keep drafts short and offer variants instead of one long version.',
    ideas: ['What is my niche on X talking about this week', 'Write five launch posts for the project in this folder', 'Find ten accounts worth replying to today and draft replies'],
    crew: ['grok', 'claude'],
  },
  {
    id: 'security', name: 'Security review', line: 'Find the holes before someone else does',
    brief: 'This room reviews security. Look for injection, secrets in code or history, unsafe deserialisation, missing auth checks, weak crypto and vulnerable dependencies. Report each finding with the file and line, how it could be exploited and the smallest fix. Do not run exploits against anything outside this folder.',
    ideas: ['Review this repo for security issues, worst first', 'Check the dependencies for known vulnerabilities', 'Search the git history for leaked secrets'],
    checks: [{ label: 'npm audit', command: 'npm audit --omit=dev' }],
  },
  {
    id: 'learn', name: 'Learning', line: 'Understand anything, step by step',
    brief: 'This room teaches. Find out what the person already knows, explain one idea at a time with a concrete example, and check understanding with a short question before moving on. Link to good sources for going deeper.',
    ideas: ['Teach me how this codebase is put together', 'Explain a topic from scratch with examples', 'Quiz me on what we covered last time'],
  },
]

const valid = (p: Partial<Pack>): p is Pack =>
  typeof p.id === 'string' && /^[a-z0-9-]{2,40}$/.test(p.id) && typeof p.name === 'string' && typeof p.brief === 'string' && Array.isArray(p.ideas)

export function loadPacks(files: string[]): Pack[] {
  const user: Pack[] = []
  for (const file of files) {
    try {
      const p = JSON.parse(readFileSync(file, 'utf8'))
      if (valid(p)) user.push({ ...p, line: p.line ?? '', ideas: p.ideas.slice(0, 6), source: 'user' })
    } catch {}
  }
  const ids = new Set(user.map((p) => p.id))
  return [...BUILTIN.filter((p) => !ids.has(p.id)).map((p) => ({ ...p, source: 'builtin' as const })), ...user]
}

const NOT_A_PACK = 'That is not a Lunchbox pack. It needs an id, a name, a brief and a list of ideas.'

export function importPack(file: string, dir: string): Pack {
  const p = JSON.parse(readFileSync(file, 'utf8'))
  if (!valid(p)) throw new Error(NOT_A_PACK)
  copyFileSync(file, join(dir, basename(`${p.id}.json`)))
  return { ...p, source: 'user' }
}

// Packs are shared as plain links: a gist, a raw GitHub file, any https URL that returns the JSON.
export async function fetchPack(url: string, dir: string): Promise<Pack> {
  let u: URL
  try { u = new URL(url.trim()) } catch { throw new Error('That does not look like a link') }
  if (u.protocol !== 'https:') throw new Error('Only https links are accepted')
  if (u.hostname === 'github.com' && u.pathname.includes('/blob/')) u = new URL(`https://raw.githubusercontent.com${u.pathname.replace('/blob/', '/')}`)
  if (u.hostname === 'gist.github.com' && !u.pathname.endsWith('/raw')) u = new URL(`https://gist.githubusercontent.com${u.pathname}/raw`)
  const res = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json, text/plain' } })
  if (!res.ok) throw new Error(`The link answered ${res.status}`)
  const text = await res.text()
  if (text.length > 200_000) throw new Error('That file is too large to be a pack')
  let p: Partial<Pack>
  try { p = JSON.parse(text) } catch { throw new Error(NOT_A_PACK) }
  if (!valid(p)) throw new Error(NOT_A_PACK)
  const clean: Pack = { id: p.id, name: p.name.slice(0, 40), line: (p.line ?? '').slice(0, 80), brief: p.brief.slice(0, 4000), ideas: p.ideas.filter((i) => typeof i === 'string').slice(0, 6), crew: p.crew, checks: p.checks?.filter((c) => c && typeof c.command === 'string' && typeof c.label === 'string').slice(0, 6) }
  writeFileSync(join(dir, `${clean.id}.json`), JSON.stringify(clean, null, 2))
  return { ...clean, source: 'user' }
}

export function removePack(id: string, dir: string) {
  if (!/^[a-z0-9-]{2,40}$/.test(String(id))) return
  rmSync(join(dir, `${id}.json`), { force: true })
}

export function packJson(p: Pack) {
  const { source: _, ...rest } = p
  return JSON.stringify(rest, null, 2) + '\n'
}
