// Habits the person can turn on for every room. Each is one instruction added to what every agent
// is told, so they change how the crew works without changing what it is asked. All start off:
// some people want terse answers, others want plans, and the choice is theirs.
export type Habit = { id: string; name: string; line: string; rule: string }

export const HABITS: Habit[] = [
  { id: 'prove', name: 'Prove it', line: 'Run the check before saying it works, and show the result.', rule: 'Never say something works without running the check that proves it in this turn. Quote the command and the line of output that shows it passed.' },
  { id: 'needs', name: 'Say what you need from me', line: 'End every turn with what is done, what is next and what needs you.', rule: 'End every turn with three short lines: "Done:", "Next:" and "Needs you:" (write "nothing" when nothing does).' },
  { id: 'loops', name: 'No loops', line: 'After two failed tries at the same thing, stop and explain.', rule: 'If the same approach fails twice, stop. Explain what you tried, what you think the cause is, and what you would try next, then wait.' },
  { id: 'plan', name: 'Plan first', line: 'Start larger work with a short plan and wait for a yes.', rule: 'Before work that touches more than three files or takes more than a few steps, write a short plan as a checklist and wait for the person to agree.' },
  { id: 'small', name: 'Small changes', line: 'Change only what the task needs. No refactors on the side.', rule: 'Change only what the task needs. No unrelated refactors, renames or formatting changes. Mention anything else worth fixing instead of fixing it.' },
  { id: 'tidy', name: 'Tidy folder', line: 'Keep files organised and clean up anything temporary.', rule: 'Keep the folder organised: put new files where they belong, and delete any temporary or scratch files you created before you finish.' },
  { id: 'unsure', name: 'Ask when unsure', line: 'One short question before starting, when a request is unclear.', rule: 'When a request could reasonably mean two different things, ask one short question before starting instead of guessing.' },
  { id: 'sources', name: 'Cite sources', line: 'Link every fact found on the web or on X.', rule: 'For every fact that came from the web or X, give the link or the @handle and date right after it. Say plainly when something could not be confirmed.' },
  { id: 'plain', name: 'Plain words', line: 'Short answers without filler or hype.', rule: 'Answer in plain words. Lead with the answer, keep it short, no filler, no hype, no apologies.' },
]

export const habitRules = (ids: string[] = []) => HABITS.filter((h) => ids.includes(h.id)).map((h) => `- ${h.rule}`)
