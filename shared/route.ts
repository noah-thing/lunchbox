export type Category = 'code' | 'live' | 'research' | 'writing' | 'design' | 'data' | 'general'
export type Rating = { r: number; n: number }
export type Ratings = Partial<Record<Category, Record<string, Rating>>>

export const CATEGORIES: { id: Category; name: string }[] = [
  { id: 'code', name: 'Code' },
  { id: 'live', name: 'Live news' },
  { id: 'research', name: 'Research' },
  { id: 'writing', name: 'Writing' },
  { id: 'design', name: 'Design' },
  { id: 'data', name: 'Data' },
  { id: 'general', name: 'General' },
]

const WORDS: [Category, RegExp][] = [
  ['live', /\b(today|right now|this week|trending|latest|breaking|news|tweets?|posts? on x|on x\b|twitter|people (are )?saying|sentiment|viral|launch(ed)? (yesterday|today))\b/i],
  ['code', /\b(bug|fix|refactor|test|tests|build|compile|function|class|api|endpoint|typescript|javascript|python|rust|react|deploy|repo|commit|lint|error|stack ?trace|code|script|cli|database|sql|migration)\b/i],
  ['data', /\b(csv|spreadsheet|excel|dataset|chart|plot|analy[sz]e|statistics|metrics|dashboard|numbers|forecast|pivot|json file)\b/i],
  ['design', /\b(design|layout|ui|ux|figma|logo|colou?rs?|typography|font|landing page|mockup|wireframe|icon|image|illustration|brand)\b/i],
  ['writing', /\b(write|rewrite|draft|essay|blog|post|copy|email|tweet thread|story|article|edit (my|this) text|tone|proofread|summari[sz]e|newsletter)\b/i],
  ['research', /\b(research|compare|find out|sources|papers?|study|studies|market|competitors?|investigate|explain|why does|how does|look into)\b/i],
]

export function classify(text: string): Category {
  let best: Category = 'general'
  let most = 0
  for (const [cat, re] of WORDS) {
    const hits = text.match(new RegExp(re.source, 'gi'))?.length ?? 0
    if (hits > most) { best = cat; most = hits }
  }
  return best
}

// Where each agent starts before you have kept any of its answers: what its maker built it for.
const PRIOR: Record<string, Partial<Record<Category, number>>> = {
  claude: { code: 1060, writing: 1060, design: 1050, research: 1030 },
  codex: { code: 1070, data: 1030 },
  grok: { live: 1120, research: 1030 },
  gemini: { research: 1050, data: 1050, design: 1010 },
  ollama: { general: 980 },
  'claude-api': { writing: 1040, code: 1030 },
  'openai-api': { writing: 1020, data: 1020 },
  'grok-api': { live: 1030 },
  'gemini-api': { research: 1030, data: 1030 },
}

export function rating(ratings: Ratings, cat: Category, id: string): Rating {
  return ratings[cat]?.[id] ?? { r: PRIOR[id]?.[cat] ?? 1000, n: 0 }
}

// Keeping one answer in a side by side is a win over every other answer in it.
export function score(ratings: Ratings, cat: Category, winner: string, losers: string[]): Ratings {
  const next: Ratings = structuredClone(ratings)
  const table = (next[cat] ??= {})
  const w = rating(ratings, cat, winner)
  let gain = 0
  for (const id of losers) {
    if (id === winner) continue
    const l = rating(ratings, cat, id)
    const expect = 1 / (1 + 10 ** ((l.r - w.r) / 400))
    const k = l.n < 10 ? 32 : 20
    const delta = Math.round(k * (1 - expect))
    gain += delta
    table[id] = { r: l.r - delta, n: l.n + 1 }
  }
  table[winner] = { r: w.r + gain, n: w.n + 1 }
  return next
}

export type Candidate = { id: string; paid: boolean; budgetLeft?: number }

// The lead for a message: the best rated agent for this kind of work that can take it now.
// Agents you already pay for by subscription win close calls over pay-per-token ones, and an
// agent close to its daily budget steps back.
export function route(ratings: Ratings, cat: Category, candidates: Candidate[]) {
  const ranked = candidates
    .map((c) => {
      let s = rating(ratings, cat, c.id).r
      if (c.paid) s -= 40
      if (c.budgetLeft !== undefined && c.budgetLeft < 0.2) s -= 80
      return { id: c.id, s }
    })
    .sort((a, b) => b.s - a.s)
  return ranked[0]?.id ?? null
}
