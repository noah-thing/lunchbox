import { copyFileSync, readFileSync } from 'node:fs'
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

export function importPack(file: string, dir: string): Pack {
  const p = JSON.parse(readFileSync(file, 'utf8'))
  if (!valid(p)) throw new Error('That file is not a Lunchbox pack. It needs an id, a name, a brief and a list of ideas.')
  copyFileSync(file, join(dir, basename(`${p.id}.json`)))
  return { ...p, source: 'user' }
}
