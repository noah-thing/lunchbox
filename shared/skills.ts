// Playbooks that ship with Lunchbox. Each starts a room with a prompt that already knows how good
// work of that kind is done; {{input}} is replaced with what the person types after picking it.

export type Field = 'Build' | 'Fix' | 'Test' | 'Ship' | 'Design' | 'Research' | 'Write' | 'Grow' | 'Data' | 'Security' | 'Learn' | 'Run'

export type Playbook = {
  id: string
  name: string
  field: Field
  line: string
  prompt: string
  ask?: string
  crew?: string[]
  pack?: string
  tools?: string[]
}

export const FIELDS: Field[] = ['Build', 'Fix', 'Test', 'Ship', 'Design', 'Research', 'Write', 'Grow', 'Data', 'Security', 'Learn', 'Run']

export const PLAYBOOKS: Playbook[] = [
  // Build
  {
    id: 'feature', name: 'Build a feature', field: 'Build', line: 'Plan, build, test and show it working', pack: 'software', ask: 'What should it do?',
    prompt: 'Build this: {{input}}\n\nRead the code around it first and write a short checklist plan. Build it in small steps that each leave the project working. Add or update tests, run the project\'s own checks, and finish by showing it working (a command, a test run or a browser screenshot).',
  },
  {
    id: 'mvp', name: 'Zero to working app', field: 'Build', line: 'A small, real app from one sentence', pack: 'software', ask: 'Describe the app',
    prompt: 'Make a working first version of: {{input}}\n\nPick the simplest stack that fits and say why in one line. Scaffold it in this folder, build the core flow end to end before anything else, and add a README with how to run it. Start it, open it in the Lunchbox browser and take a screenshot of the main screen.',
    tools: ['shadcn'],
  },
  {
    id: 'api', name: 'Add an API endpoint', field: 'Build', line: 'Route, validation, tests and docs', pack: 'software', ask: 'What should the endpoint do?',
    prompt: 'Add an API endpoint that {{input}}.\n\nFollow the existing routing, validation and error conventions in this codebase exactly. Validate input at the edge, return useful errors, write tests for the happy path and the two most likely failures, and document it where the other endpoints are documented.',
  },
  {
    id: 'cli', name: 'Write a CLI tool', field: 'Build', line: 'A command with flags, help and tests', pack: 'software', ask: 'What should the command do?',
    prompt: 'Write a command line tool that {{input}}.\n\nGive it --help with examples, sensible exit codes, and output that is readable by people and parseable with --json. Handle bad input with one clear line, not a stack trace. Add tests and a short usage section to the README.',
  },
  {
    id: 'migrate', name: 'Upgrade a dependency', field: 'Build', line: 'Read the changelog, upgrade, fix what breaks', pack: 'software', ask: 'Which package, to which version?',
    prompt: 'Upgrade {{input}}.\n\nRead the official migration guide and changelog first (use the docs tools if connected) and list the breaking changes that touch this codebase. Upgrade, fix each break, run the full test suite and the build, and summarise what changed and anything to watch in production.',
    tools: ['context7'],
  },
  {
    id: 'port', name: 'Port to another stack', field: 'Build', line: 'Same behaviour, new language or framework', pack: 'software', ask: 'From what to what?',
    prompt: 'Port {{input}}.\n\nFirst write down the behaviour that must not change, with tests in the old version if they are missing. Port module by module, keep the same tests passing on the new side, and list anything that could not be carried over one to one.',
  },
  // Fix
  {
    id: 'bug', name: 'Fix a bug', field: 'Fix', line: 'Reproduce, find the cause, fix, prove it', pack: 'software', ask: 'What goes wrong?',
    prompt: 'Fix this bug: {{input}}\n\nReproduce it first with a failing test or a command. Find the root cause, not the symptom, and explain it in two sentences. Make the smallest fix, run the failing test again to prove it passes, then run the rest of the suite.',
  },
  {
    id: 'ci', name: 'Make CI green', field: 'Fix', line: 'Read the logs and fix the real failure', pack: 'software',
    prompt: 'CI is failing. Read the latest CI logs (use the GitHub tools if connected, otherwise run the same steps locally), find the first real failure, and fix it. Do not skip or weaken tests. Run the same commands locally to prove they pass.',
    tools: ['github'],
  },
  {
    id: 'perf', name: 'Make it faster', field: 'Fix', line: 'Measure, find the bottleneck, prove the gain', pack: 'software', ask: 'What is slow?',
    prompt: 'Make this faster: {{input}}\n\nMeasure before touching anything and record the number. Find where the time actually goes with a profiler or timing, fix the biggest cost first, and measure again. Report before and after with the exact commands used.',
    tools: ['devtools'],
  },
  {
    id: 'types', name: 'Fix type errors', field: 'Fix', line: 'Clean type check without any casts', pack: 'software',
    prompt: 'Run the type checker and fix every error. Fix the types properly: no `any`, no `as unknown as`, no ignore comments unless there is truly no other way, and say why when there is not. Run the checker again until it is clean, then run the tests.',
  },
  {
    id: 'crash', name: 'Explain a stack trace', field: 'Fix', line: 'From error to cause to fix', pack: 'software', ask: 'Paste the error',
    prompt: 'This error happened:\n\n{{input}}\n\nFind the code path that produces it, explain what state leads there, and propose the fix. If it can be reproduced locally, write a test that shows it, then fix it.',
  },
  // Test
  {
    id: 'tests', name: 'Add missing tests', field: 'Test', line: 'Cover what matters, not lines', pack: 'software', ask: 'Which part of the code?',
    prompt: 'Add tests for {{input}}.\n\nRead the code and list the behaviours that would hurt most if they broke. Test those, including edge cases and failures, using the project\'s existing test style. Each test should fail if the behaviour breaks; check a few by breaking the code on purpose.',
  },
  {
    id: 'e2e', name: 'End to end test', field: 'Test', line: 'A real browser walking through a flow', pack: 'software', ask: 'Which user flow?',
    prompt: 'Write an end to end test for this flow: {{input}}\n\nStart the app, walk the flow in the Lunchbox browser first to learn the real selectors, then write the test with the project\'s e2e tool (Playwright if there is none). Prefer roles and labels over CSS selectors. Run it until it passes reliably three times in a row.',
    tools: ['playwright'],
  },
  {
    id: 'qa', name: 'QA a website', field: 'Test', line: 'Click through everything and report', ask: 'Which URL?',
    prompt: 'QA {{input}} in the Lunchbox browser. Check every page reachable from the navigation on desktop, then the main pages at phone width. Look for broken links, layout breaks, console errors, missing alt text, slow pages and confusing copy. Take a screenshot of each problem and write a ranked list with steps to reproduce.',
    tools: ['playwright'],
  },
  {
    id: 'flaky', name: 'Fix a flaky test', field: 'Test', line: 'Find the race and remove it', pack: 'software', ask: 'Which test?',
    prompt: 'This test is flaky: {{input}}\n\nRun it in a loop until it fails and capture the failing output. Find the cause (timing, shared state, order, network, randomness) and fix that cause. Sleeps and retries are not a fix. Prove it with 30 passing runs in a row.',
  },
  // Ship
  {
    id: 'review', name: 'Review my changes', field: 'Ship', line: 'A second pair of eyes before you push', pack: 'software', crew: ['claude', 'codex'],
    prompt: 'Review the uncommitted changes and the last commit in this folder as a strict senior reviewer. Look for bugs, missing tests, unclear names, security issues and anything that will be painful later. Give each finding a file and line and a concrete fix. Say clearly what is good to ship.',
  },
  {
    id: 'pr', name: 'Write the pull request', field: 'Ship', line: 'Title, summary, testing notes', pack: 'software',
    prompt: 'Write a pull request for the changes on this branch compared to the main branch. A short title in the imperative, a summary of what and why, how it was tested, and anything the reviewer should look at closely. Open it with the GitHub tools if connected, otherwise print it.',
    tools: ['github'],
  },
  {
    id: 'release', name: 'Release notes', field: 'Ship', line: 'From commits to notes people read', pack: 'writing', ask: 'Since which tag or date?',
    prompt: 'Write release notes for everything since {{input}}. Read the commits and merged pull requests, group them into New, Improved and Fixed, and write each line for users, not developers. Lead with the one change people will care about most.',
  },
  {
    id: 'deploy', name: 'Set up deploys', field: 'Ship', line: 'CI, previews and production', pack: 'software', ask: 'Where should it run?',
    prompt: 'Set up deployment to {{input}} for this project: a CI workflow that runs the checks on every push, preview deploys for pull requests if the host supports it, and production deploys from the main branch. Keep secrets out of the repo and list the ones I need to add.',
  },
  {
    id: 'docs', name: 'Write the README', field: 'Ship', line: 'What it is, how to run it, how it works', pack: 'writing',
    prompt: 'Write or rewrite the README for this project. Open with one sentence on what it is and who it is for, then install and run steps that actually work (run them to check), the main concepts, configuration, and how to contribute. No filler, no badges wall.',
  },
  // Design
  {
    id: 'landing', name: 'Landing page', field: 'Design', line: 'Three directions, then one polished', pack: 'design', ask: 'What is the product?',
    prompt: 'Design a landing page for {{input}}.\n\nPropose three distinct directions in one line each and pick the strongest. Build it with real copy, one clear call to action, a strong first screen and good mobile layout. Check it in the Lunchbox browser at desktop and phone width and screenshot both.',
    tools: ['shadcn', 'magic'],
  },
  {
    id: 'polish', name: 'Polish the UI', field: 'Design', line: 'Spacing, hierarchy, states and motion', pack: 'design',
    prompt: 'Open the app in the Lunchbox browser and review the interface like a senior product designer: hierarchy, spacing rhythm, alignment, contrast, empty and loading states, focus states and motion. Fix the ten most noticeable issues in code, then screenshot before and after.',
  },
  {
    id: 'figma', name: 'Build from Figma', field: 'Design', line: 'A Figma frame to production code', pack: 'design', ask: 'Paste the Figma link',
    prompt: 'Build this Figma design in the project\'s stack: {{input}}\n\nRead the frame\'s layout, tokens and assets with the Figma tools, reuse existing components where they match, and match spacing and type exactly. Compare a screenshot of the result with the design and fix the differences.',
    tools: ['figma'],
  },
  {
    id: 'icon', name: 'App icon', field: 'Design', line: 'Icons in a few styles to choose from', pack: 'design', ask: 'What is the app?',
    prompt: 'Make an app icon for {{input}}. Write three distinct concepts in a line each, then generate each with make_image at 1024x1024 and save them in icons/. Simple shapes that read at 32 px, no text.',
  },
  {
    id: 'a11y', name: 'Accessibility pass', field: 'Design', line: 'Keyboard, contrast, labels, screen readers', pack: 'design',
    prompt: 'Audit this app for accessibility in the Lunchbox browser and in code: keyboard navigation and focus order, contrast, labels and alt text, headings structure, and motion preferences. Fix the issues in code and list anything that needs a design decision.',
  },
  {
    id: 'brand', name: 'Brand basics', field: 'Design', line: 'Name ideas, voice, colours and type', pack: 'design', ask: 'What is it and who is it for?',
    prompt: 'Create brand basics for {{input}}: five name ideas with available-sounding domains, a voice in three adjectives with do and don\'t examples, a palette of at most four colours with hex values and usage, and a type pairing. Keep it restrained.',
  },
  // Research
  {
    id: 'deep', name: 'Deep research', field: 'Research', line: 'A sourced answer, with what is uncertain', pack: 'research', crew: ['claude', 'grok', 'gemini'], ask: 'What do you want to know?',
    prompt: 'Research: {{input}}\n\nSplit it into the three to five questions that decide the answer. Search the web and X for each, prefer primary sources, and note where sources disagree. Write a short answer first, then the evidence with links, then what is still uncertain.',
    tools: ['exa', 'firecrawl'],
  },
  {
    id: 'market', name: 'Market map', field: 'Research', line: 'Who is in the space and how they differ', pack: 'research', ask: 'Which market?',
    prompt: 'Map the market for {{input}}: the main players, what each is best at, pricing, who they serve and recent moves. Put it in one table, then say where the gaps are.',
  },
  {
    id: 'sentiment', name: 'What people say', field: 'Research', line: 'Live opinion on X and the web', pack: 'research', crew: ['grok', 'claude'], ask: 'About what?',
    prompt: 'What are people saying about {{input}} right now? Search X and the web for the last two weeks. Group the opinions into themes with how common each is, quote the most telling posts with links, and separate loud from representative.',
  },
  {
    id: 'paper', name: 'Explain a paper', field: 'Research', line: 'The idea, the evidence and the catch', pack: 'research', ask: 'Link or title',
    prompt: 'Read {{input}} and explain it: the problem, the idea in plain words, how they tested it, the key result, and the weaknesses a sceptical reviewer would raise. End with who should care and why.',
  },
  {
    id: 'compare', name: 'Compare options', field: 'Research', line: 'A decision table and a recommendation', pack: 'research', ask: 'Compare what, for what purpose?',
    prompt: 'Compare {{input}}. Choose the criteria that actually matter for this purpose, score each option with evidence and links, and make a clear recommendation with the conditions under which a different option wins.',
  },
  // Write
  {
    id: 'post', name: 'Blog post', field: 'Write', line: 'One idea, said well', pack: 'writing', ask: 'What is it about?',
    prompt: 'Write a blog post about {{input}}. One idea, a first line that earns the second, concrete examples, and an ending that says something. Around 900 words. Then cut 20 percent.',
  },
  {
    id: 'edit', name: 'Edit my writing', field: 'Write', line: 'Clearer and shorter, same voice', pack: 'writing', ask: 'Paste the text or a file path',
    prompt: 'Edit this for clarity and length while keeping my voice:\n\n{{input}}\n\nCut what does not earn its place, replace vague words with exact ones, and fix the order where it confuses. Show the edited version, then a short list of the biggest changes and why.',
  },
  {
    id: 'email', name: 'Hard email', field: 'Write', line: 'Say no, ask for something, deliver bad news', pack: 'writing', ask: 'What do you need to say, to whom?',
    prompt: 'Write this email: {{input}}\n\nShort, direct and kind. The point in the first two lines, the reason in one, and a clear next step. Give two versions: one warmer, one firmer.',
  },
  {
    id: 'newsletter', name: 'Newsletter', field: 'Write', line: 'This week, worth reading', pack: 'writing', crew: ['grok', 'claude'], ask: 'Topic and audience',
    prompt: 'Write this week\'s newsletter on {{input}}. Find the three most important things that happened this week on the web and X, explain why each matters for the audience, and add one opinion of our own. A subject line under 50 characters.',
  },
  // Grow
  {
    id: 'launch', name: 'Launch kit', field: 'Grow', line: 'Posts, thread, Product Hunt and HN', pack: 'growth', crew: ['grok', 'claude'], ask: 'What are you launching?',
    prompt: 'Make a launch kit for {{input}}: an X thread of 5 to 7 posts with a hook that stops the scroll, a single launch post, a Product Hunt tagline and description, a Show HN title and first comment, and a LinkedIn post. Match how the best launches in this niche on X are written this month.',
  },
  {
    id: 'replies', name: 'Reply guy, but good', field: 'Grow', line: 'Ten posts worth replying to today', pack: 'growth', crew: ['grok', 'claude'], ask: 'Your niche',
    prompt: 'Find ten posts on X from the last 24 hours in {{input}} that are worth replying to: growing, from accounts my audience follows, where a smart reply adds something. Draft a reply for each that adds a fact, a story or a sharp take. No flattery.',
  },
  {
    id: 'seo-audit', name: 'SEO audit', field: 'Grow', line: 'Technical issues and quick wins, ranked', pack: 'seo', ask: 'Which site?',
    prompt: 'Audit {{input}} for SEO. Crawl it in the Lunchbox browser or with the crawl tools: titles, descriptions, headings, canonical tags, sitemap, robots, structured data, broken links, image alt text, Core Web Vitals and internal linking. Rank by impact and fix what is in this folder.',
    tools: ['firecrawl'],
  },
  {
    id: 'keywords', name: 'Content plan', field: 'Grow', line: 'What to write next and why', pack: 'seo', ask: 'Site and topic',
    prompt: 'Build a content plan for {{input}}: twenty article ideas grouped by search intent, each with the main query, why we can rank for it, and the angle competitors miss. Order by effort against payoff.',
  },
  {
    id: 'readme-stars', name: 'GitHub repo glow-up', field: 'Grow', line: 'README, topics and launch for stars', pack: 'growth',
    prompt: 'Make this repository easy to star: a README that shows what it does in the first screen (with a screenshot or GIF), a one-line description and topics, a clear quick start, and an X post and Show HN draft for launch day.',
    tools: ['github'],
  },
  // Data
  {
    id: 'explore', name: 'Explore a dataset', field: 'Data', line: 'Shape, quality and what stands out', pack: 'data', ask: 'Which file or table?',
    prompt: 'Explore {{input}}. Load it with code, report its shape, types, missing and odd values, then the five most interesting patterns with a chart each saved as PNG. Show the code behind every number.',
  },
  {
    id: 'sql', name: 'Answer with SQL', field: 'Data', line: 'A question in, a checked query out', pack: 'data', ask: 'What do you want to know?',
    prompt: 'Answer this from the database: {{input}}\n\nInspect the schema first, write the query, run it, and sanity check the result against a simpler count. Show the query, the result and one sentence on what it means.',
    tools: ['postgres', 'sqlite', 'supabase'],
  },
  {
    id: 'dashboard', name: 'Build a dashboard', field: 'Data', line: 'The five numbers that matter, live', pack: 'data', ask: 'For which data and audience?',
    prompt: 'Build a small dashboard for {{input}}: pick the five numbers that matter for this audience, show each with its trend, and make it run locally with one command. Check it in the Lunchbox browser and screenshot it.',
  },
  {
    id: 'clean', name: 'Clean a spreadsheet', field: 'Data', line: 'Fix types, duplicates and formats', pack: 'data', ask: 'Which file?',
    prompt: 'Clean {{input}}: consistent types and formats, trimmed text, duplicates removed with a log of what was removed, and obvious errors flagged rather than guessed. Save a cleaned copy next to the original and never overwrite it.',
  },
  // Security
  {
    id: 'audit', name: 'Security review', field: 'Security', line: 'Worst holes first, with fixes', pack: 'security', crew: ['claude', 'codex'],
    prompt: 'Review this codebase for security issues: injection, auth and access control, secrets, unsafe deserialisation, SSRF, path traversal, dependency vulnerabilities and insecure defaults. For each finding give file and line, how it could be exploited, severity, and the fix. Fix the critical ones.',
  },
  {
    id: 'secrets', name: 'Find leaked secrets', field: 'Security', line: 'In the code and the git history', pack: 'security',
    prompt: 'Search this repository and its full git history for leaked secrets: API keys, tokens, passwords and private keys. List each with where it was found and whether it is still in the current code. Do not print the secret values in full. Say which ones to rotate.',
  },
  {
    id: 'headers', name: 'Harden a web app', field: 'Security', line: 'Headers, cookies, CSP and rate limits', pack: 'security',
    prompt: 'Harden this web app: security headers, a strict content security policy that does not break the app, cookie flags, CSRF protection, rate limits on auth endpoints, and safe error messages. Check the result in the Lunchbox browser for console errors.',
  },
  // Learn
  {
    id: 'onboard', name: 'Explain this codebase', field: 'Learn', line: 'A map of how it fits together', pack: 'learn',
    prompt: 'Explain this codebase to me as a new team member: what it does, the main parts and how data flows between them, where to start reading, and the five things that would surprise someone new. Draw the architecture as a small ASCII diagram.',
  },
  {
    id: 'teach', name: 'Teach me a topic', field: 'Learn', line: 'Step by step, with checks', pack: 'learn', ask: 'What do you want to learn?',
    prompt: 'Teach me {{input}}. Ask what I already know first. Then one idea at a time, each with a concrete example, and a short question to check I got it before moving on.',
  },
  {
    id: 'interview', name: 'Interview practice', field: 'Learn', line: 'Realistic questions and honest feedback', pack: 'learn', ask: 'Which role?',
    prompt: 'Run a mock interview for {{input}}. Ask one question at a time like a real interviewer, wait for my answer, then give honest feedback and a stronger example answer before the next question.',
  },
  // Run
  {
    id: 'standup', name: 'Standup from commits', field: 'Run', line: 'Yesterday\'s work in plain words',
    prompt: 'Read the git log and diffs in this folder from the last working day and write my standup: what shipped, what is in progress, what is blocked. Plain words, no hashes.',
  },
  {
    id: 'issues', name: 'Triage issues', field: 'Run', line: 'Label, dedupe and prioritise', ask: 'Which repository?',
    prompt: 'Triage the open issues in {{input}}: group duplicates, label each by type and area, flag the ones that are actually urgent, and propose the next five to work on with a reason each. Make the changes with the GitHub tools if connected.',
    tools: ['github'],
  },
  {
    id: 'meeting', name: 'Meeting notes to actions', field: 'Run', line: 'Decisions, owners and dates', ask: 'Paste the notes or transcript',
    prompt: 'Turn these meeting notes into decisions, action items with owners and dates, and open questions:\n\n{{input}}\n\nKeep the wording of decisions exact. Flag any action without an owner.',
  },
  {
    id: 'plan-week', name: 'Plan my week', field: 'Run', line: 'Priorities that fit the hours you have', ask: 'What is on your plate?',
    prompt: 'Help me plan my week. Here is what is on my plate: {{input}}\n\nAsk how many focused hours I have, then pick the three things that matter most, break each into steps that fit a session, and say what to drop or delegate.',
  },
  {
    id: 'invoice', name: 'Customer lookup', field: 'Run', line: 'Payments and plans from Stripe', ask: 'Customer email or name',
    prompt: 'Look up {{input}} in Stripe: their plan, payment history, failed payments and open invoices. Summarise the account in five lines and suggest the next step if something is wrong.',
    tools: ['stripe'],
  },
]

export const fillPlaybook = (p: Playbook, input: string) =>
  p.prompt.includes('{{input}}') ? p.prompt.replace(/\{\{input\}\}/g, input.trim() || 'what I describe next') : input.trim() ? `${p.prompt}\n\n${input.trim()}` : p.prompt
