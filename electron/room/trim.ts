// Long command output stays in an agent's context for the rest of its session and is read again
// on every step. A test run, a build or an install is mostly lines nobody needs: what matters is
// how it started, how it ended and what went wrong. Those are kept, the rest goes to a file the
// agent can open, so nothing is lost.

// Output this short is passed on as it is.
export const SMALL = 10000
// Claude Code itself moves output past this size to a file and shows a short preview, so a cut
// above it took nothing out of the context that would have been there.
export const NATIVE = 30000
const HEAD = 1500
const SIGNAL = 4000
const TAIL = 3000

const PROBLEM = /\b(error|errors|failed|failure|failures|fail|failing|exception|traceback|panic|panicked|fatal|denied|not ok|unexpected|cannot|can't|unable to|missing|warning|warn|deprecated|timeout|timed out|assert\w*|expected|actual|undefined is not|is not defined|no such file|not found)\b|[✖✗✘×❌]|^\s*(E|FAIL|ERR!|>)\s/i
// A passing line can name the thing it tests: "✔ rejects an unknown rule" is not a problem.
const PASSED = /^\s*(✔|✓|√|ok\b|PASS\b|passed\b|\[debug\])/
// Stack frames inside the runtime or a dependency say nothing about the project's own code.
const INTERNAL = /^\s+at .*(\(node:|node:internal|node_modules[\\/])/

// Colour codes and cursor moves, and progress bars that redraw one line over and over.
export function clean(text: string) {
  const plain = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '')
  if (!plain.includes('\r')) return plain
  return plain.split('\n').map((l) => { const end = l.endsWith('\r') ? l.slice(0, -1) : l; return end.slice(end.lastIndexOf('\r') + 1) }).join('\n')
}

// Commands whose output is a log: tests, builds, installs and linters. Anything that prints
// content an agent asked to see, a file or a diff or a search, is never one of these.
const LOGS = [
  /^(npm|pnpm|yarn|bun)\s+(?!(ls|list|view|info|show|pkg|config|why|bin|root|prefix|whoami|get)\b)/,
  /^(npx|bunx|pnpx)\s/, /^(pnpm|yarn)\s+dlx\s/,
  /^node\s+(--test|.*\s--test)\b/, /^deno\s+(test|lint|check|task)\b/,
  /^(pytest|tox|nox|jest|vitest|mocha|ava|tsc|eslint|biome|prettier|ruff|mypy|pyright|rubocop|rspec|phpunit|phpstan|make|gmake|cmake|ninja|xcodebuild|gradle|mvn|ant|webpack|rollup|vite|turbo|nx|lerna|bazel|ctest|stylelint)\b/,
  /^\.\/(gradlew|mvnw)\b/,
  /^python3?\s+-m\s+(pytest|unittest|pip|build|tox|mypy|ruff)\b/,
  /^(pip3?|uv|poetry|pipenv|conda)\s+(install|sync|add|update|lock|build)\b/, /^uv\s+(run\s+pytest|pip)\b/,
  /^cargo\s+(build|test|check|clippy|bench|doc|install|update|nextest)\b/,
  /^go\s+(test|build|vet|install|mod|generate)\b/,
  /^(dotnet|swift|flutter|dart|mix|stack|cabal|zig)\s+(build|test|restore|publish|pub|analyze|compile|deps)\b/,
  /^(bundle|composer|gem)\s+(install|update|exec\s+(rspec|rake|rubocop))\b/, /^rake\b/,
  /^docker\s+(build|pull|push|compose\s+(build|pull|up))\b/, /^docker-compose\s+(build|pull|up)\b/,
  /^terraform\s+(init|plan|apply|validate)\b/,
  /^(brew|apt|apt-get|dnf|yum|pacman|choco|winget|scoop)\s+(install|upgrade|update|-S)\b/,
]
const CONTENT = /^(cat|head|tail|sed|awk|grep|rg|ag|git|gh|ls|find|fd|tree|jq|yq|curl|wget|diff|less|more|bat|wc|sort|uniq|cut|tr|xxd|hexdump|strings|printenv|env|echo|printf|sqlite3|psql|mysql)\b/

// What a part of a command line really runs, past `cd x`, `FOO=1`, `time` and the like.
function verb(part: string) {
  let s = part.trim().replace(/^[({]\s*/, '')
  for (let prev = ''; prev !== s;) {
    prev = s
    s = s.replace(/^(\w+=("[^"]*"|'[^']*'|\S*)\s+|(time|sudo|command|exec|nice|nohup|env)\s+)/, '')
  }
  return s
}

// Whether a command line is safe and worth shortening: at least one part of it logs, and no part
// prints content. A pipe into grep or tail is the agent already choosing what it wants to see.
export function logs(command: string) {
  if (/<<|\bexit\b|&\s*$|\bwait\b|\$\(|`/.test(command)) return false
  const parts = command.split(/&&|\|\||;|\n/).map(verb).filter(Boolean)
  let found = false
  for (const p of parts) {
    if (/^(cd|pushd|popd|export|set|source|\.|true|:|mkdir|rm|touch|sleep)\b/.test(p)) continue
    // A pipeline is judged by what starts it, unless what follows picks lines out of it.
    const [first, ...rest] = p.split(/\|(?!\|)/).map((x) => x.trim())
    if (rest.some((r) => /^(grep|rg|tail|head|sed|awk|wc|jq|cut|sort|uniq|tee)\b/.test(r))) return false
    if (CONTENT.test(first)) return false
    if (LOGS.some((re) => re.test(first))) found = true
    else return false
  }
  return found
}

const count = (n: number) => n.toLocaleString('en-US')

// The start, the end, and the lines that look like problems with a little around each. `where`
// is the file holding the whole output. cut is how many characters never reach the context,
// counted only where they would have.
export function trim(raw: string, where?: string): { text: string; cut: number } {
  const text = clean(raw)
  const saved = (out: string) => (raw.length > NATIVE ? 0 : Math.max(0, raw.length - out.length))
  if (text.length <= SMALL) return { text, cut: saved(text) }
  const lines = text.split('\n')
  const keep = new Set<number>()
  let size = 0
  for (let i = 0; i < lines.length && size + lines[i].length <= HEAD; i++) { keep.add(i); size += lines[i].length + 1 }
  size = 0
  for (let i = lines.length - 1; i >= 0 && size + lines[i].length <= TAIL; i--) { keep.add(i); size += lines[i].length + 1 }
  // Output that is mostly problems, a long list of compiler errors say, is all worth reading.
  const problem = lines.map((l) => PROBLEM.test(l) && !PASSED.test(l))
  if (problem.filter(Boolean).length > lines.length * 0.3) return { text, cut: saved(text) }
  size = 0
  let more = 0
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i) || !problem[i]) continue
    if (size > SIGNAL) { more++; continue }
    // What follows a problem line usually says what it was: the message, the values, the place.
    for (let k = Math.max(0, i - 1); k <= Math.min(lines.length - 1, i + 4); k++) {
      if (keep.has(k) || INTERNAL.test(lines[k]) || (k !== i && PASSED.test(lines[k]))) continue
      keep.add(k)
      size += Math.min(lines[k].length, 400) + 1
    }
  }
  const out: string[] = []
  let gap = 0
  for (let i = 0; i < lines.length; i++) {
    if (!keep.has(i)) { gap++; continue }
    if (gap) out.push(`[… ${count(gap)} line${gap > 1 ? 's' : ''} not shown …]`)
    gap = 0
    out.push(lines[i].length > 400 ? `${lines[i].slice(0, 400)}…` : lines[i])
  }
  if (gap) out.push(`[… ${count(gap)} line${gap > 1 ? 's' : ''} not shown …]`)
  out.push(
    `[Lunchbox shortened this output to its start, its end and the lines that look like problems: ${count(keep.size)} of ${count(lines.length)} lines.` +
    (more ? ` ${count(more)} more lines that look like problems are not shown.` : '') +
    (where ? ` The whole output is in ${where}; read or search that file when you need more.]` : ']'),
  )
  const short = out.join('\n')
  // Not worth a pointer and a second look when little would be saved.
  if (short.length > text.length * 0.75) return { text, cut: saved(text) }
  return { text: short, cut: saved(short) }
}
