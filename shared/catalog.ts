// Open source MCP servers worth having one switch away. Lunchbox runs each one itself and hands
// its tools to every agent in a room, so they work the same in Claude Code, Codex, Grok and Gemini.

export type Secret = { id: string; label: string; env?: string; arg?: string; hint?: string; url?: string; optional?: boolean }

export type CatalogTool = {
  id: string
  name: string
  line: string
  repo: string
  group: 'Build' | 'Know' | 'Search' | 'Data' | 'Work' | 'Design'
  run: 'npx' | 'uvx'
  args: string[]
  secrets?: Secret[]
  // Some servers take their path or URL as the last argument.
  input?: { id: string; label: string; placeholder: string; default?: string }
}

export const CATALOG: CatalogTool[] = [
  {
    id: 'playwright', name: 'Playwright', group: 'Build', repo: 'microsoft/playwright-mcp', run: 'npx',
    line: 'A real headless browser for testing flows end to end: forms, logins, screenshots.',
    args: ['-y', '@playwright/mcp@latest', '--headless', '--isolated'],
  },
  {
    id: 'devtools', name: 'Chrome DevTools', group: 'Build', repo: 'ChromeDevTools/chrome-devtools-mcp', run: 'npx',
    line: 'Performance traces, network requests and console errors from a live Chrome.',
    args: ['-y', 'chrome-devtools-mcp@latest', '--headless', '--isolated'],
  },
  {
    id: 'context7', name: 'Context7', group: 'Know', repo: 'upstash/context7', run: 'npx',
    line: 'Current docs and examples for thousands of libraries, so agents stop guessing old APIs.',
    args: ['-y', '@upstash/context7-mcp@latest'],
    secrets: [{ id: 'key', label: 'API key', arg: '--api-key', optional: true, hint: 'Optional, raises the rate limit', url: 'https://context7.com/dashboard' }],
  },
  {
    id: 'github', name: 'GitHub', group: 'Work', repo: 'modelcontextprotocol/servers-archived', run: 'npx',
    line: 'Issues, pull requests, reviews and code search across your repositories.',
    args: ['-y', '@modelcontextprotocol/server-github'],
    secrets: [{ id: 'token', label: 'Personal access token', env: 'GITHUB_PERSONAL_ACCESS_TOKEN', hint: 'ghp_… or github_pat_…', url: 'https://github.com/settings/personal-access-tokens/new' }],
  },
  {
    id: 'shadcn', name: 'shadcn/ui', group: 'Design', repo: 'shadcn-ui/ui', run: 'npx',
    line: 'Browse, search and install shadcn/ui components and blocks into the project.',
    args: ['-y', 'shadcn@latest', 'mcp'],
  },
  {
    id: 'magic', name: '21st.dev Magic', group: 'Design', repo: '21st-dev/magic-mcp', run: 'npx',
    line: 'Polished React components generated from a description, in the project\'s style.',
    args: ['-y', '@21st-dev/magic@latest'],
    secrets: [{ id: 'key', label: 'API key', env: 'API_KEY', url: 'https://21st.dev/magic/console' }],
  },
  {
    id: 'figma', name: 'Figma', group: 'Design', repo: 'GLips/Figma-Context-MCP', run: 'npx',
    line: 'Layout, styles and assets from a Figma link, for building designs one to one.',
    args: ['-y', 'figma-developer-mcp', '--stdio'],
    secrets: [{ id: 'key', label: 'Personal access token', arg: '--figma-api-key', url: 'https://help.figma.com/hc/en-us/articles/8085703771159' }],
  },
  {
    id: 'firecrawl', name: 'Firecrawl', group: 'Search', repo: 'firecrawl/firecrawl-mcp-server', run: 'npx',
    line: 'Scrape, crawl and extract whole sites as clean markdown.',
    args: ['-y', 'firecrawl-mcp'],
    secrets: [{ id: 'key', label: 'API key', env: 'FIRECRAWL_API_KEY', hint: 'fc-…', url: 'https://www.firecrawl.dev/app/api-keys' }],
  },
  {
    id: 'exa', name: 'Exa', group: 'Search', repo: 'exa-labs/exa-mcp-server', run: 'npx',
    line: 'Neural web search for papers, companies and code, with full page contents.',
    args: ['-y', 'exa-mcp-server'],
    secrets: [{ id: 'key', label: 'API key', env: 'EXA_API_KEY', url: 'https://dashboard.exa.ai/api-keys' }],
  },
  {
    id: 'brave', name: 'Brave Search', group: 'Search', repo: 'brave/brave-search-mcp-server', run: 'npx',
    line: 'Private web, news and image search from an independent index.',
    args: ['-y', '@brave/brave-search-mcp-server', '--transport', 'stdio'],
    secrets: [{ id: 'key', label: 'API key', env: 'BRAVE_API_KEY', url: 'https://api-dashboard.search.brave.com/app/keys' }],
  },
  {
    id: 'fetch', name: 'Fetch', group: 'Search', repo: 'modelcontextprotocol/servers', run: 'uvx',
    line: 'Any URL as readable markdown, for agents without their own web access.',
    args: ['mcp-server-fetch'],
  },
  {
    id: 'memory', name: 'Knowledge graph', group: 'Know', repo: 'modelcontextprotocol/servers', run: 'npx',
    line: 'Long term memory as a graph of people, projects and facts that outlives rooms.',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  },
  {
    id: 'thinking', name: 'Sequential thinking', group: 'Know', repo: 'modelcontextprotocol/servers', run: 'npx',
    line: 'Structured step by step reasoning with revisions, for hard problems.',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  },
  {
    id: 'postgres', name: 'Postgres', group: 'Data', repo: 'modelcontextprotocol/servers-archived', run: 'npx',
    line: 'Read only SQL and schema inspection on a Postgres database.',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    input: { id: 'url', label: 'Connection URL', placeholder: 'postgresql://localhost/mydb' },
  },
  {
    id: 'sqlite', name: 'SQLite', group: 'Data', repo: 'modelcontextprotocol/servers-archived', run: 'uvx',
    line: 'Query and analyse a SQLite file, with a running memo of insights.',
    args: ['mcp-server-sqlite', '--db-path'],
    input: { id: 'path', label: 'Database file', placeholder: '~/data/app.db' },
  },
  {
    id: 'supabase', name: 'Supabase', group: 'Data', repo: 'supabase-community/supabase-mcp', run: 'npx',
    line: 'Tables, migrations, edge functions and logs of your Supabase projects.',
    args: ['-y', '@supabase/mcp-server-supabase@latest', '--read-only'],
    secrets: [{ id: 'token', label: 'Access token', env: 'SUPABASE_ACCESS_TOKEN', hint: 'sbp_…', url: 'https://supabase.com/dashboard/account/tokens' }],
  },
  {
    id: 'stripe', name: 'Stripe', group: 'Work', repo: 'stripe/agent-toolkit', run: 'npx',
    line: 'Customers, products, payment links and invoices. Use a restricted or test key.',
    args: ['-y', '@stripe/mcp', '--tools=all'],
    secrets: [{ id: 'key', label: 'Secret key', arg: '--api-key', hint: 'rk_test_… or sk_test_…', url: 'https://dashboard.stripe.com/apikeys' }],
  },
  {
    id: 'notion', name: 'Notion', group: 'Work', repo: 'makenotion/notion-mcp-server', run: 'npx',
    line: 'Search, read and write pages and databases in your workspace.',
    args: ['-y', '@notionhq/notion-mcp-server'],
    secrets: [{ id: 'token', label: 'Integration token', env: 'NOTION_TOKEN', hint: 'ntn_…', url: 'https://www.notion.so/profile/integrations' }],
  },
  {
    id: 'slack', name: 'Slack', group: 'Work', repo: 'modelcontextprotocol/servers-archived', run: 'npx',
    line: 'Read channels and threads, post messages and reactions.',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    secrets: [
      { id: 'token', label: 'Bot token', env: 'SLACK_BOT_TOKEN', hint: 'xoxb-…', url: 'https://api.slack.com/apps' },
      { id: 'team', label: 'Workspace ID', env: 'SLACK_TEAM_ID', hint: 'T0…' },
    ],
  },
  {
    id: 'git', name: 'Git', group: 'Build', repo: 'modelcontextprotocol/servers', run: 'uvx',
    line: 'Log, diff, blame and branches as tools, for agents without a shell.',
    args: ['mcp-server-git'],
  },
  {
    id: 'time', name: 'Time', group: 'Know', repo: 'modelcontextprotocol/servers', run: 'uvx',
    line: 'Current time and conversions between time zones.',
    args: ['mcp-server-time'],
  },
]

export const GROUPS: CatalogTool['group'][] = ['Build', 'Design', 'Know', 'Search', 'Data', 'Work']
