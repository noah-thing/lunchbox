import { execSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../electron/store'
import { Engine } from '../../electron/room/engine'
import { Hands } from '../../electron/hands'
import { detect, run } from '../../electron/agents'
import type { Act, Usage } from '../../shared/types'
// @ts-expect-error a plain script, shared with the command line
import { writeRepo } from './repo.mjs'

// The saving benchmark: the same multi-step tasks, with the same model, in plain Claude Code and
// in a Lunchbox room, on a fresh copy of the scratch project each time. Real agents, real usage.
//
//   node scripts/bench.mjs                      every task, plain and room, once, on Haiku
//   BENCH_MODEL=sonnet BENCH_REPS=2 node scripts/bench.mjs
//   BENCH_ARMS=plain,room,before BENCH_TASKS=fix node scripts/bench.mjs
//
// plain is Claude Code on its own: `claude -p`, resumed for the second message, with the access
// a room in Auto gives it. room is a Lunchbox room in Auto. before is the same room with the
// saving switched off, which is what a room cost before it existed. flow is the room run as a
// flow, with nobody waiting on it. lean is the room started with only Lunchbox's own tools.
// low is the room with Claude's effort set to low.
// Each run adds a line to BENCH_OUT (bench-results.jsonl in the temp folder unless set).

type Task = { name: string; fixed: boolean; messages: string[]; check(dir: string, answers: string[]): { ok: boolean; notes: string[] } }

const sh = (dir: string, command: string) => spawnSync(command, { cwd: dir, shell: true, encoding: 'utf8', timeout: 120000 })
const passed = (dir: string) => {
  const r = sh(dir, 'node --test')
  const n = Number(`${r.stdout}`.match(/^ℹ pass (\d+)/m)?.[1] ?? 0)
  return { ok: r.status === 0, n }
}

const COUPON_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as tillr from '../src/index.js'
const { addItem, createCart, totals, applyCoupon } = tillr
const filled = () => addItem(addItem(addItem(createCart('SE'), { sku: 'TEA-001', name: 'Green tea', price: 4900, category: 'food' }, 2), { sku: 'MUG-010', name: 'Mug', price: 12900 }), { sku: 'BOOK-100', name: 'Tea handbook', price: 19900, category: 'books' })
const after = (code) => { const c = filled(); applyCoupon(c, code); return totals(c).discount }
test('WELCOME10', () => assert.equal(after('WELCOME10'), 4260))
test('FIKA50', () => assert.equal(after('FIKA50'), 5000))
test('TEA2FOR1', () => assert.equal(after('TEA2FOR1'), 4900))
test('unknown code', () => assert.throws(() => applyCoupon(filled(), 'NOPE'), RangeError))
test('same code twice', () => { const c = filled(); applyCoupon(c, 'WELCOME10'); assert.throws(() => applyCoupon(c, 'WELCOME10'), Error) })
`

const TASKS: Task[] = [
  {
    name: 'fix', fixed: false,
    messages: [
      'The test suite in this project is failing. Find the causes and fix the source code, not the tests, until `npm test` passes. Then tell me briefly what was wrong.',
      'Add an `applyCoupon(cart, code)` function to src/cart.js. Codes: WELCOME10 adds a 10 percent rule, FIKA50 adds a fixed 5000 off rule, TEA2FOR1 adds a bogo rule for TEA-001. An unknown code throws a RangeError, and applying the same code twice to one cart throws an Error. Make sure it is exported from the package, add tests for it in test/cart.test.js, and run the whole suite and the build.',
    ],
    check(dir) {
      const notes: string[] = []
      const suite = passed(dir)
      if (!suite.ok) notes.push('the suite fails')
      if (suite.n < 382) notes.push(`only ${suite.n} tests pass`)
      if (sh(dir, 'git diff --quiet HEAD -- test/money.test.js test/tax.test.js test/dates.test.js test/discount.test.js test/invoice.test.js test/report.test.js').status !== 0) notes.push('existing tests were changed')
      writeFileSync(join(dir, 'test', 'zz-hidden.test.js'), COUPON_TEST)
      const hidden = sh(dir, 'node --test test/zz-hidden.test.js')
      rmSync(join(dir, 'test', 'zz-hidden.test.js'))
      if (hidden.status !== 0) notes.push('applyCoupon does not do what was asked')
      if (sh(dir, 'npm run build').status !== 0) notes.push('the build fails')
      return { ok: !notes.length, notes }
    },
  },
  {
    name: 'tour', fixed: true,
    messages: [
      'I am new to this codebase. How is the total of a cart worked out when it has discounts and lines with different VAT rates? Name the functions and files involved, in the order they run. Keep it short.',
      'Rename `calcTax` to `lineTax` everywhere: source, tests and anything else. Keep the behaviour the same. Then run the lint, the build and the tests, and fix whatever fails. The lint reports problems today; fix those too.',
    ],
    check(dir, answers) {
      const notes: string[] = []
      const named = ['totals', 'lineDiscounts', 'calcTax', 'cart.js', 'discount.js', 'tax.js'].filter((w) => answers[0]?.includes(w))
      if (named.length < 5) notes.push(`the explanation names ${named.length} of 6 parts`)
      if (sh(dir, 'grep -rn calcTax src test scripts README.md').status === 0) notes.push('calcTax is still there')
      if (sh(dir, 'grep -rn lineTax src/tax.js').status !== 0) notes.push('lineTax is missing')
      const suite = passed(dir)
      if (!suite.ok || suite.n < 382) notes.push(`the suite: ${suite.n} pass${suite.ok ? '' : ', some fail'}`)
      if (sh(dir, 'npm run lint').status !== 0) notes.push('the lint fails')
      if (sh(dir, 'npm run build').status !== 0) notes.push('the build fails')
      return { ok: !notes.length, notes }
    },
  },
  // One step and nothing to do: what is left is what each side sends before any work starts.
  {
    name: 'idle', fixed: true,
    messages: ['Reply with the single word ok. Do not use any tools.'],
    check: (_dir, answers) => ({ ok: /\bok\b/i.test(answers[0] ?? ''), notes: [] }),
  },
]

type Row = { input: number; written: number; cached: number; output: number; cost: number; steps: number; ms: number; cut: number; commands: string[] }
const zero = (): Row => ({ input: 0, written: 0, cached: 0, output: 0, cost: 0, steps: 0, ms: 0, cut: 0, commands: [] })
const add = (a: Row, u: Usage | undefined, acts: Act[], ms: number) => {
  if (!u) return
  a.input += u.input - (u.written ?? 0); a.written += u.written ?? 0; a.cached += u.cached; a.output += u.output; a.cost += u.cost; a.steps += acts.length; a.ms += ms; a.cut += u.cut ?? 0
  for (const x of acts) if (x.t === 'cmd') a.commands.push(x.command.slice(0, 160))
}

function project(task: Task) {
  // The real path, because macOS reaches its temp folder through a link and Claude Code names
  // the project by where it really is.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `lunchbox-bench-${task.name}-`)))
  writeRepo(dir, { fixed: task.fixed })
  execSync('git init -q && git add -A && git -c user.name=bench -c user.email=bench@example.com commit -qm start', { cwd: dir })
  return dir
}

const model = process.env.BENCH_MODEL || 'haiku'

async function plain(task: Task) {
  const dir = project(task)
  const total = zero()
  const answers: string[] = []
  let session: string | undefined
  let meter
  for (const text of task.messages) {
    const r = await run('claude', { prompt: text, system: '', fresh: false, cwd: dir, access: 'workspace', model, session, meter }, {}, () => {}).done
    if (r.error) console.error(`  plain ${task.name}: ${r.error}`)
    add(total, r.usage, r.acts, r.ms)
    answers.push(r.text)
    session = r.session
    meter = r.meter
  }
  return { dir, total, answers }
}

async function room(task: Task, arm: string) {
  const saving = arm !== 'before'
  const dir = project(task)
  const data = mkdtempSync(join(tmpdir(), 'lunchbox-bench-data-'))
  const store = new Store(data, { seal: (t) => t, open: (t) => t })
  // Checkpoints are left out, and so is keeping warm except in a flow, where it is what picks
  // the five minute lifetime and never pings: neither changes what these turns cost.
  store.saveSettings({ models: { claude: model }, snapshots: false, saving: { trim: saving, warm: arm === 'flow', lean: arm === 'lean' }, effort: arm === 'low' ? { claude: 'low' } : undefined })
  const hands = new Hands()
  await hands.start()
  const engine = new Engine(store, { emit: () => {}, notify: () => {}, packs: () => [] }, hands)
  await engine.refresh()
  const made = engine.create({ crew: ['claude'], workspace: dir, flow: arm === 'flow' ? 'bench' : undefined })
  const total = zero()
  const answers: string[] = []
  let seen = 0
  for (const text of task.messages) {
    engine.send(made.id, text, 'workspace')
    await engine.idle(made.id)
    const events = store.events(made.id).slice(seen)
    seen += events.length
    for (const e of events) {
      if (e.kind === 'say') { add(total, e.usage, e.acts, e.ms ?? 0); if (e.error) console.error(`  room ${task.name}: ${e.error}`) }
      if (e.kind === 'hands') add(total, e.usage, e.acts, e.ms ?? 0)
    }
    answers.push(events.filter((e) => e.kind === 'say').map((e) => (e.kind === 'say' ? e.text : '')).join('\n'))
  }
  engine.stopAll()
  hands.stop()
  store.flush()
  rmSync(data, { recursive: true, force: true })
  return { dir, total, answers }
}

const out = process.env.BENCH_OUT || join(tmpdir(), 'bench-results.jsonl')
const arms = (process.env.BENCH_ARMS || 'plain,room').split(',')
const tasks = TASKS.filter((t) => (process.env.BENCH_TASKS || 'fix,tour').split(',').includes(t.name))
const reps = Number(process.env.BENCH_REPS || 1)
const k = (n: number) => `${(n / 1000).toFixed(1)}k`.padStart(8)

await detect({}, {}, {})
console.log(`model ${model}, results in ${out}`)
console.log(`${'task'.padEnd(6)}${'arm'.padEnd(8)}${'fresh'.padStart(8)}${'written'.padStart(8)}${'cached'.padStart(8)}${'output'.padStart(8)}${'cost'.padStart(9)}${'steps'.padStart(6)}${'min'.padStart(6)}  result`)
for (let rep = 0; rep < reps; rep++) {
  for (const task of tasks) {
    for (const arm of arms) {
      const r = arm === 'plain' ? await plain(task) : await room(task, arm)
      const check = task.check(r.dir, r.answers)
      const t = r.total
      console.log(`${task.name.padEnd(6)}${arm.padEnd(8)}${k(t.input)}${k(t.written)}${k(t.cached)}${k(t.output)}${`$${t.cost.toFixed(4)}`.padStart(9)}${String(t.steps).padStart(6)}${(t.ms / 60000).toFixed(1).padStart(6)}  ${check.ok ? 'pass' : `FAIL: ${check.notes.join('; ')}`}${t.cut ? `  (${k(t.cut).trim()} tokens shortened)` : ''}`)
      appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), model, task: task.name, arm, ...t, ok: check.ok, notes: check.notes }) + '\n')
      if (!process.env.BENCH_KEEP) rmSync(r.dir, { recursive: true, force: true })
      else console.log(`  kept ${r.dir}`)
    }
  }
}
process.exit(0)
