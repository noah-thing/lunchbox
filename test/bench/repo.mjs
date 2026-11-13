// Writes the scratch project the saving benchmark works in: a small point of sale library with a
// few hundred tests, a build that lists every file and a debug log, like most real projects.
// The same call always writes the same files. `fixed` leaves out the three seeded bugs.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const files = {}

files['package.json'] = JSON.stringify({
  name: 'tillr', version: '0.4.0', private: true, type: 'module',
  scripts: { test: 'node --test', build: 'node scripts/build.js', lint: 'node scripts/lint.js' },
}, null, 2) + '\n'

files['README.md'] = `# tillr

A small point of sale library: carts, discounts, tax, invoices and stock.

    npm test        run the tests
    npm run build   copy the checked sources to dist/
    npm run lint    style checks

Amounts are integers in minor units (cents, öre). Never use floats for money.
`

files['src/log.js'] = `// Debug lines go to stderr when LOG_LEVEL=debug.
const on = () => process.env.LOG_LEVEL === 'debug'
export const debug = (scope, msg, data) => { if (on()) console.error(\`[debug] \${scope}: \${msg}\${data === undefined ? '' : ' ' + JSON.stringify(data)}\`) }
export const warn = (scope, msg) => console.error(\`[warn] \${scope}: \${msg}\`)
`

files['src/money.js'] = `import { debug } from './log.js'

// Amounts are integers in minor units.
export function assertAmount(n) {
  if (!Number.isInteger(n)) throw new TypeError(\`amount must be an integer in minor units, got \${n}\`)
  return n
}

export const add = (...parts) => parts.reduce((sum, n) => sum + assertAmount(n), 0)

// Half away from zero, the way a till rounds.
export function roundHalfUp(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

export function percent(amount, rate) {
  assertAmount(amount)
  return roundHalfUp((amount * rate) / 100)
}

// Splits an amount by weights so the parts always add up to the whole. What is left after
// rounding down goes to the largest weights first, one unit each.
export function allocate(amount, weights) {
  assertAmount(amount)
  const total = weights.reduce((a, b) => a + b, 0)
  if (total <= 0) throw new RangeError('weights must add up to more than zero')
  const parts = weights.map((w) => Math.floor((amount * w) / total))
  let left = amount - parts.reduce((a, b) => a + b, 0)
  const order = weights.map((w, i) => [w, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1])
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k][1]]++
  debug('money', 'allocate', { amount, parts })
  return parts
}

export function format(amount, currency = 'SEK') {
  assertAmount(amount)
  const sign = amount < 0 ? '-' : ''
  const abs = Math.abs(amount)
  const whole = String(Math.floor(abs / 100)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ' ')
  return \`\${sign}\${whole}.\${String(abs % 100).padStart(2, '0')} \${currency}\`
}

export function parse(text) {
  const m = String(text).trim().replace(/\\s/g, '').match(/^(-?)(\\d+)(?:[.,](\\d{1,2}))?$/)
  if (!m) throw new SyntaxError(\`not an amount: \${text}\`)
  const minor = Number(m[2]) * 100 + Number((m[3] ?? '0').padEnd(2, '0'))
  return m[1] ? -minor : minor
}
`

files['src/tax.js'] = `import { percent } from './money.js'
import { debug } from './log.js'

// VAT in percent by region and category. A category a region does not list pays its standard rate.
export const RATES = {
  SE: { standard: 25, food: 12, books: 6, transport: 6 },
  DE: { standard: 19, food: 7, books: 7 },
  FR: { standard: 20, food: 5.5, books: 5.5, medicine: 2.1 },
  NO: { standard: 25, food: 15, transport: 12 },
}

export function rateFor(region, category = 'standard') {
  const table = RATES[region]
  if (!table) throw new RangeError(\`unknown region \${region}\`)
  return table[category] ?? table.standard
}

// Tax on one line. Prices are stored without tax.
export function calcTax(line, region) {
  const rate = rateFor(region, line.category)
  const tax = percent(line.price * line.qty, rate)
  debug('tax', 'calcTax', { sku: line.sku, rate, tax })
  return tax
}

// Tax per rate for a list of lines, as an invoice has to show it.
export function taxByRate(lines, region) {
  const out = new Map()
  for (const line of lines) {
    const rate = rateFor(region, line.category)
    out.set(rate, (out.get(rate) ?? 0) + calcTax(line, region))
  }
  return [...out].sort((a, b) => b[0] - a[0]).map(([rate, tax]) => ({ rate, tax }))
}

export const totalTax = (lines, region) => lines.reduce((sum, l) => sum + calcTax(l, region), 0)
`

files['src/discount.js'] = `import { allocate, percent } from './money.js'
import { debug } from './log.js'

// A rule is one of:
//   { type: 'percent', value, category? }   percent off every matching line
//   { type: 'fixed', value }                an amount off the cart, spread over the lines by value
//   { type: 'bogo', sku }                   every second unit of a sku is free
export function lineDiscounts(lines, rules) {
  const off = lines.map(() => 0)
  for (const rule of rules) {
    if (rule.type === 'percent') {
      lines.forEach((l, i) => { if (!rule.category || l.category === rule.category) off[i] += percent(l.price * l.qty - off[i], rule.value) })
    } else if (rule.type === 'bogo') {
      lines.forEach((l, i) => { if (l.sku === rule.sku) off[i] += Math.floor(l.qty / 2) * l.price })
    } else if (rule.type === 'fixed') {
      const left = lines.map((l, i) => l.price * l.qty - off[i])
      const total = left.reduce((a, b) => a + b, 0)
      if (total > 0) allocate(Math.min(rule.value, total), left).forEach((part, i) => { off[i] += part })
    } else throw new TypeError(\`unknown discount type \${rule.type}\`)
  }
  debug('discount', 'lineDiscounts', off)
  // A discount never takes a line below zero.
  return off.map((d, i) => Math.min(d, lines[i].price * lines[i].qty))
}

export const totalDiscount = (lines, rules) => lineDiscounts(lines, rules).reduce((a, b) => a + b, 0)
`

files['src/cart.js'] = `import { lineDiscounts } from './discount.js'
import { calcTax } from './tax.js'
import { assertAmount } from './money.js'
import { debug } from './log.js'

export function createCart(region = 'SE') {
  return { region, lines: [], rules: [] }
}

export function addItem(cart, item, qty = 1) {
  assertAmount(item.price)
  if (!Number.isInteger(qty) || qty < 1) throw new RangeError('qty must be a whole number above zero')
  const line = cart.lines.find((l) => l.sku === item.sku)
  if (line) line.qty += qty
  else cart.lines.push({ sku: item.sku, name: item.name, price: item.price, category: item.category ?? 'standard', qty })
  debug('cart', 'addItem', { sku: item.sku, qty })
  return cart
}

export function removeItem(cart, sku, qty = Infinity) {
  const line = cart.lines.find((l) => l.sku === sku)
  if (!line) return cart
  line.qty -= Math.min(qty, line.qty)
  if (line.qty === 0) cart.lines = cart.lines.filter((l) => l !== line)
  return cart
}

export const addRule = (cart, rule) => { cart.rules.push(rule); return cart }

export const subtotal = (cart) => cart.lines.reduce((sum, l) => sum + l.price * l.qty, 0)

// Discounts come off before tax, and tax is worked out per line on what is left.
export function totals(cart) {
  const off = lineDiscounts(cart.lines, cart.rules)
  const net = cart.lines.map((l, i) => l.price * l.qty - off[i])
  const tax = cart.lines.map((l, i) => calcTax({ ...l, price: net[i], qty: 1 }, cart.region))
  const sum = (list) => list.reduce((a, b) => a + b, 0)
  const out = { subtotal: subtotal(cart), discount: sum(off), net: sum(net), tax: sum(tax), total: sum(net) + sum(tax) }
  debug('cart', 'totals', out)
  return out
}
`

files['src/dates.js'] = `// Dates are plain 'YYYY-MM-DD' strings, handled in UTC so a till in any time zone agrees.
const DAY = 86400000
const toDate = (iso) => {
  const d = new Date(\`\${iso}T00:00:00Z\`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) throw new RangeError(\`not a date: \${iso}\`)
  return d
}
const toIso = (d) => d.toISOString().slice(0, 10)

export const addDays = (iso, n) => toIso(new Date(toDate(iso).getTime() + n * DAY))
export const weekday = (iso) => toDate(iso).getUTCDay()
export const isWeekend = (iso) => weekday(iso) === 0 || weekday(iso) === 6

// The date n business days after iso. Saturdays and Sundays do not count, and neither does the
// day itself.
export function addBusinessDays(iso, n) {
  let day = iso
  for (let left = n; left > 0;) {
    day = addDays(day, 1)
    if (!isWeekend(day)) left--
  }
  return day
}

export function daysBetween(from, to) {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / DAY)
}

// Invoices fall due a number of days after they are issued, moved to Monday when that lands on a weekend.
export function dueDate(issued, terms = 30) {
  let due = addDays(issued, terms)
  while (isWeekend(due)) due = addDays(due, 1)
  return due
}

export const quarter = (iso) => \`\${iso.slice(0, 4)}-Q\${Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1}\`
`

files['src/id.js'] = `// Invoice numbers: a prefix, the year, a running number and a check digit (Luhn).
export function luhn(digits) {
  let sum = 0
  ;[...digits].reverse().forEach((ch, i) => {
    let n = Number(ch)
    if (i % 2 === 0) { n *= 2; if (n > 9) n -= 9 }
    sum += n
  })
  return String((10 - (sum % 10)) % 10)
}

export function invoiceNumber(year, seq, prefix = 'INV') {
  if (!Number.isInteger(seq) || seq < 1) throw new RangeError('seq must be a whole number above zero')
  const body = \`\${year}\${String(seq).padStart(5, '0')}\`
  return \`\${prefix}-\${body}\${luhn(body)}\`
}

export function isValidInvoiceNumber(text) {
  const m = String(text).match(/^[A-Z]{2,4}-(\\d{9})(\\d)$/)
  return !!m && luhn(m[1]) === m[2]
}
`

files['src/invoice.js'] = `import { totals } from './cart.js'
import { taxByRate } from './tax.js'
import { lineDiscounts } from './discount.js'
import { dueDate } from './dates.js'
import { invoiceNumber } from './id.js'
import { format } from './money.js'
import { debug } from './log.js'

export function buildInvoice(cart, customer, { issued, seq, terms = 30, currency = 'SEK' }) {
  if (!cart.lines.length) throw new Error('an invoice needs at least one line')
  const off = lineDiscounts(cart.lines, cart.rules)
  const lines = cart.lines.map((l, i) => ({ ...l, discount: off[i], net: l.price * l.qty - off[i] }))
  const sums = totals(cart)
  const invoice = {
    number: invoiceNumber(Number(issued.slice(0, 4)), seq),
    customer: { name: customer.name, email: customer.email },
    issued,
    due: dueDate(issued, terms),
    currency,
    lines,
    vat: taxByRate(lines.map((l) => ({ ...l, price: l.net, qty: 1 })), cart.region),
    ...sums,
  }
  debug('invoice', 'buildInvoice', { number: invoice.number, total: invoice.total })
  return invoice
}

export function render(invoice) {
  const rows = invoice.lines.map((l) => \`\${String(l.qty).padStart(3)} x \${l.name.padEnd(24)} \${format(l.net, invoice.currency).padStart(16)}\`)
  return [
    \`Invoice \${invoice.number}\`,
    \`\${invoice.customer.name}, issued \${invoice.issued}, due \${invoice.due}\`,
    ...rows,
    ...invoice.vat.map((v) => \`VAT \${v.rate}%\`.padEnd(30) + format(v.tax, invoice.currency).padStart(16)),
    'Total'.padEnd(30) + format(invoice.total, invoice.currency).padStart(16),
  ].join('\\n')
}
`

files['src/inventory.js'] = `import { debug, warn } from './log.js'

export function createStock(levels = {}) {
  return { levels: { ...levels }, reserved: {} }
}

export const available = (stock, sku) => (stock.levels[sku] ?? 0) - (stock.reserved[sku] ?? 0)

export function reserve(stock, sku, qty) {
  if (available(stock, sku) < qty) {
    warn('inventory', \`not enough \${sku}: wanted \${qty}, have \${available(stock, sku)}\`)
    return false
  }
  stock.reserved[sku] = (stock.reserved[sku] ?? 0) + qty
  debug('inventory', 'reserve', { sku, qty })
  return true
}

export function release(stock, sku, qty) {
  stock.reserved[sku] = Math.max(0, (stock.reserved[sku] ?? 0) - qty)
}

// Takes reserved units out of stock for good, when the sale goes through.
export function commit(stock, sku, qty) {
  if ((stock.reserved[sku] ?? 0) < qty) throw new Error(\`\${qty} of \${sku} were never reserved\`)
  stock.reserved[sku] -= qty
  stock.levels[sku] -= qty
}

export const lowStock = (stock, floor = 5) => Object.keys(stock.levels).filter((sku) => available(stock, sku) <= floor).sort()
`

files['src/csv.js'] = `// Just enough CSV for exports: quoted fields, doubled quotes, commas and newlines inside quotes.
export function parseCsv(text) {
  const rows = [[]]
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { rows.at(-1).push(field); field = '' }
    else if (ch === '\\n' || ch === '\\r') {
      if (ch === '\\r' && text[i + 1] === '\\n') i++
      rows.at(-1).push(field); field = ''
      rows.push([])
    } else field += ch
  }
  rows.at(-1).push(field)
  if (rows.at(-1).length === 1 && rows.at(-1)[0] === '') rows.pop()
  return rows
}

const cell = (v) => (/[",\\n\\r]/.test(String(v)) ? \`"\${String(v).replace(/"/g, '""')}"\` : String(v))
export const toCsv = (rows) => rows.map((r) => r.map(cell).join(',')).join('\\n')

export function toObjects(text) {
  const [head, ...rest] = parseCsv(text)
  return rest.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])))
}
`

files['src/validate.js'] = `export const isEmail = (s) => /^[^\\s@]+@[^\\s@]+\\.[a-z]{2,}$/i.test(String(s))
export const isSku = (s) => /^[A-Z]{2,5}-\\d{3,6}$/.test(String(s))

// Swedish organisation numbers: ten digits, the last one a Luhn check digit.
export function isOrgNumber(s) {
  const digits = String(s).replace(/-/g, '')
  if (!/^\\d{10}$/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < 10; i++) {
    let n = Number(digits[i]) * (i % 2 === 0 ? 2 : 1)
    if (n > 9) n -= 9
    sum += n
  }
  return sum % 10 === 0
}

export function validateCustomer(c) {
  const errors = []
  if (!c?.name?.trim()) errors.push('name is required')
  if (!isEmail(c?.email)) errors.push('email is not valid')
  if (c?.org !== undefined && !isOrgNumber(c.org)) errors.push('organisation number is not valid')
  return errors
}
`

files['src/currency.js'] = `import { roundHalfUp } from './money.js'

// Units of each currency for one euro.
export const PER_EUR = { EUR: 1, SEK: 11.2, NOK: 11.6, DKK: 7.46, USD: 1.08, GBP: 0.85 }

export function convert(amount, from, to, table = PER_EUR) {
  if (!(from in table) || !(to in table)) throw new RangeError(\`no rate for \${from} to \${to}\`)
  if (from === to) return amount
  return roundHalfUp((amount / table[from]) * table[to])
}
`

files['src/report.js'] = `import { totals } from './cart.js'
import { quarter } from './dates.js'
import { debug } from './log.js'

// Sales are { date, cart }. One row per day, oldest first.
export function daily(sales) {
  const days = new Map()
  for (const s of sales) {
    const t = totals(s.cart)
    const row = days.get(s.date) ?? { date: s.date, sales: 0, net: 0, tax: 0, total: 0 }
    row.sales++
    row.net += t.net
    row.tax += t.tax
    row.total += t.total
    days.set(s.date, row)
  }
  debug('report', 'daily', { days: days.size })
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date))
}

export function byCategory(sales) {
  const out = {}
  for (const s of sales) for (const l of s.cart.lines) out[l.category] = (out[l.category] ?? 0) + l.price * l.qty
  return out
}

export function byQuarter(sales) {
  const out = {}
  for (const row of daily(sales)) out[quarter(row.date)] = (out[quarter(row.date)] ?? 0) + row.total
  return out
}

export const best = (sales, n = 3) => {
  const qty = {}
  for (const s of sales) for (const l of s.cart.lines) qty[l.sku] = (qty[l.sku] ?? 0) + l.qty
  return Object.entries(qty).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([sku, sold]) => ({ sku, sold }))
}
`

// Small helpers every project grows, with their tests.
files['src/util/strings.js'] = `export const slug = (s) => String(s).normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
export const truncate = (s, n) => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)).trimEnd() + '…')
export const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)
export const camel = (s) => s.replace(/[-_ ]+(\\w)/g, (_, c) => c.toUpperCase())
export const padCenter = (s, n) => { const left = Math.floor((n - s.length) / 2); return n <= s.length ? s : ' '.repeat(left) + s + ' '.repeat(n - s.length - left) }
export const count = (s, needle) => (needle ? s.split(needle).length - 1 : 0)
`
files['src/util/arrays.js'] = `export const chunk = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n))
export const unique = (list) => [...new Set(list)]
export const groupBy = (list, key) => list.reduce((out, x) => { (out[key(x)] ??= []).push(x); return out }, {})
export const sum = (list) => list.reduce((a, b) => a + b, 0)
export const sortBy = (list, key) => [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
export const zip = (a, b) => a.slice(0, Math.min(a.length, b.length)).map((x, i) => [x, b[i]])
export const range = (from, to, step = 1) => Array.from({ length: Math.max(0, Math.ceil((to - from) / step)) }, (_, i) => from + i * step)
`
files['src/util/objects.js'] = `export const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]))
export const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)))
export const mapValues = (o, fn) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fn(v, k)]))
export const isEmpty = (o) => o == null || (typeof o === 'object' ? Object.keys(o).length === 0 : o === '')
export function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  const ka = Object.keys(a), kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]))
}
export const get = (o, path, fallback) => path.split('.').reduce((x, k) => (x == null ? x : x[k]), o) ?? fallback
`
files['src/util/cache.js'] = `// A small least recently used cache.
export function createCache(max = 100) {
  const map = new Map()
  return {
    get(key) {
      if (!map.has(key)) return undefined
      const v = map.get(key)
      map.delete(key)
      map.set(key, v)
      return v
    },
    set(key, value) {
      map.delete(key)
      map.set(key, value)
      if (map.size > max) map.delete(map.keys().next().value)
    },
    has: (key) => map.has(key),
    get size() { return map.size },
    keys: () => [...map.keys()],
  }
}
`
files['src/util/events.js'] = `export function createEmitter() {
  const handlers = new Map()
  return {
    on(name, fn) { (handlers.get(name) ?? handlers.set(name, new Set()).get(name)).add(fn); return () => handlers.get(name)?.delete(fn) },
    once(name, fn) { const off = this.on(name, (...a) => { off(); fn(...a) }); return off },
    emit(name, ...args) { const list = [...(handlers.get(name) ?? [])]; list.forEach((fn) => fn(...args)); return list.length },
    count: (name) => handlers.get(name)?.size ?? 0,
  }
}
`

files['src/index.js'] = `export * from './money.js'
export * from './tax.js'
export * from './discount.js'
export * from './cart.js'
export * from './invoice.js'
export * from './inventory.js'
export * from './dates.js'
export * from './csv.js'
export * from './validate.js'
export * from './currency.js'
export * from './report.js'
export * from './id.js'
`

files['scripts/build.js'] = `// Checks every source file parses, then copies it to dist/ with a header.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))
const started = Date.now()
let bytes = 0
for (const file of walk('src')) {
  const text = readFileSync(file, 'utf8')
  console.log(\`[build] read      \${file} (\${text.length} bytes)\`)
  const exports = [...text.matchAll(/export (?:const|function|async function) (\\w+)/g)].map((m) => m[1])
  for (const name of exports) console.log(\`[build]   export  \${name}\`)
  await import(pathToFileURL(join(process.cwd(), file)).href)
  console.log(\`[build] checked   \${file}\`)
  const out = file.replace(/^src/, 'dist')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, \`// tillr, built from \${file}\\n\${text}\`)
  bytes += text.length
  console.log(\`[build] wrote     \${out}\`)
}
console.log(\`[build] done: \${bytes} bytes in \${Date.now() - started} ms\`)
`

files['scripts/lint.js'] = `// House style: no var, no console.log in src, lines under 220 characters.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))
let problems = 0
for (const file of [...walk('src'), ...walk('test')]) {
  const lines = readFileSync(file, 'utf8').split('\\n')
  lines.forEach((line, i) => {
    const say = (rule) => { problems++; console.log(\`\${file}:\${i + 1}  error  \${rule}\`) }
    if (/\\bvar\\s/.test(line)) say('no-var')
    if (file.startsWith('src') && /console\\.log/.test(line)) say('no-console-log')
    if (line.length > 220) say('max-len')
  })
  console.log(\`checked \${file} (\${lines.length} lines)\`)
}
console.log(problems ? \`\${problems} problem\${problems > 1 ? 's' : ''}\` : 'no problems')
process.exit(problems ? 1 : 0)
`

// Tests. Table driven where the cases are many, so each case is its own named test.
const head = (imports) => `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\n${imports}\n`
const table = (name, call, cases) => `for (const [input, want] of ${JSON.stringify(cases)}) {\n  test(\`${name} \${JSON.stringify(input)}\`, () => assert.deepEqual(${call}, want))\n}\n`

files['test/money.test.js'] = head(`import { add, allocate, assertAmount, format, parse, percent, roundHalfUp } from '../src/money.js'`) + [
  table('roundHalfUp', 'roundHalfUp(input)', [[0.5, 1], [1.5, 2], [2.5, 3], [-0.5, -1], [-1.5, -2], [1.4, 1], [-1.4, -1], [0, 0], [1.49999, 1], [1000000.5, 1000001]]),
  table('percent', 'percent(...input)', [[[1000, 25], 250], [[999, 25], 250], [[1, 50], 1], [[199, 12], 24], [[-1000, 25], -250], [[0, 25], 0], [[333, 6], 20], [[10000, 5.5], 550], [[101, 5.5], 6], [[4999, 19], 950]]),
  table('allocate', 'allocate(...input)', [[[100, [1, 1, 1]], [34, 33, 33]], [[100, [1, 1]], [50, 50]], [[5, [3, 7]], [1, 4]], [[0, [1, 2]], [0, 0]], [[1, [1, 1, 1]], [1, 0, 0]], [[1000, [70, 20, 10]], [700, 200, 100]], [[101, [1, 1]], [51, 50]], [[7, [1, 1, 1, 1]], [2, 2, 2, 1]], [[100, [2, 1]], [67, 33]], [[10, [0, 1]], [0, 10]]]),
  table('allocate keeps the whole', 'allocate(...input).reduce((a, b) => a + b, 0)', [[[100, [1, 1, 1]], 100], [[999, [5, 3, 2, 1]], 999], [[1, [9, 9, 9, 9]], 1], [[123456, [1, 2, 3, 4, 5, 6, 7]], 123456], [[17, [3, 3, 3]], 17]]),
  table('format', 'format(...input)', [[[0], '0.00 SEK'], [[5], '0.05 SEK'], [[1999], '19.99 SEK'], [[100000], '1 000.00 SEK'], [[-250], '-2.50 SEK'], [[123456789], '1 234 567.89 SEK'], [[1999, 'EUR'], '19.99 EUR'], [[100, 'NOK'], '1.00 NOK']]),
  table('parse', 'parse(input)', [['19.99', 1999], ['19,99', 1999], ['5', 500], ['0.5', 50], ['-2.50', -250], ['1 000,00', 100000], [' 12.3 ', 1230], ['0', 0]]),
  `test('parse rejects text', () => assert.throws(() => parse('abc'), SyntaxError))\n`,
  `test('parse rejects three decimals', () => assert.throws(() => parse('1.999'), SyntaxError))\n`,
  `test('assertAmount rejects floats', () => assert.throws(() => assertAmount(1.5), TypeError))\n`,
  `test('add sums amounts', () => assert.equal(add(100, 250, -50), 300))\n`,
  `test('add rejects floats', () => assert.throws(() => add(1, 2.5), TypeError))\n`,
  `test('allocate rejects empty weights', () => assert.throws(() => allocate(100, [0, 0]), RangeError))\n`,
].join('\n')

files['test/tax.test.js'] = head(`import { calcTax, rateFor, taxByRate, totalTax } from '../src/tax.js'`) + [
  table('rateFor', 'rateFor(...input)', [[['SE'], 25], [['SE', 'food'], 12], [['SE', 'books'], 6], [['SE', 'transport'], 6], [['SE', 'toys'], 25], [['DE'], 19], [['DE', 'food'], 7], [['DE', 'transport'], 19], [['FR', 'medicine'], 2.1], [['FR', 'food'], 5.5], [['NO', 'food'], 15], [['NO', 'books'], 25], [['NO', 'transport'], 12]]),
  table('calcTax', 'calcTax(...input)', [[[{ sku: 'A', price: 1000, qty: 1 }, 'SE'], 250], [[{ sku: 'A', price: 1000, qty: 3 }, 'SE'], 750], [[{ sku: 'B', price: 1999, qty: 1, category: 'food' }, 'SE'], 240], [[{ sku: 'C', price: 950, qty: 2, category: 'books' }, 'DE'], 133], [[{ sku: 'D', price: 101, qty: 1, category: 'food' }, 'FR'], 6], [[{ sku: 'E', price: 0, qty: 5 }, 'NO'], 0], [[{ sku: 'F', price: 4999, qty: 1, category: 'medicine' }, 'FR'], 105], [[{ sku: 'G', price: 333, qty: 3, category: 'transport' }, 'NO'], 120]]),
  `test('rateFor rejects an unknown region', () => assert.throws(() => rateFor('XX'), RangeError))\n`,
  `test('taxByRate groups by rate, highest first', () => {
  const lines = [{ sku: 'A', price: 1000, qty: 1 }, { sku: 'B', price: 2000, qty: 1, category: 'food' }, { sku: 'C', price: 500, qty: 2, category: 'books' }, { sku: 'D', price: 300, qty: 1 }]
  assert.deepEqual(taxByRate(lines, 'SE'), [{ rate: 25, tax: 325 }, { rate: 12, tax: 240 }, { rate: 6, tax: 60 }])
})\n`,
  `test('taxByRate merges categories that share a rate', () => {
  const lines = [{ sku: 'A', price: 1000, qty: 1, category: 'books' }, { sku: 'B', price: 1000, qty: 1, category: 'transport' }]
  assert.deepEqual(taxByRate(lines, 'SE'), [{ rate: 6, tax: 120 }])
})\n`,
  `test('totalTax adds every line', () => assert.equal(totalTax([{ sku: 'A', price: 1000, qty: 1 }, { sku: 'B', price: 2000, qty: 1, category: 'food' }], 'SE'), 490))\n`,
  `test('totalTax of nothing is zero', () => assert.equal(totalTax([], 'DE'), 0))\n`,
].join('\n')

files['test/discount.test.js'] = head(`import { lineDiscounts, totalDiscount } from '../src/discount.js'`) + `
const lines = [{ sku: 'TEA-001', price: 4900, qty: 2, category: 'food' }, { sku: 'MUG-010', price: 12900, qty: 1 }, { sku: 'BOOK-100', price: 19900, qty: 1, category: 'books' }]
` + [
  table('percent off everything', "lineDiscounts(lines, [{ type: 'percent', value: input }])", [[10, [980, 1290, 1990]], [50, [4900, 6450, 9950]], [0, [0, 0, 0]], [100, [9800, 12900, 19900]], [15, [1470, 1935, 2985]]]),
  table('percent off one category', "lineDiscounts(lines, [{ type: 'percent', value: 20, category: input }])", [['food', [1960, 0, 0]], ['books', [0, 0, 3980]], ['standard', [0, 0, 0]], ['toys', [0, 0, 0]]]),
  table('fixed amount spread by value', "lineDiscounts(lines, [{ type: 'fixed', value: input }])", [[1000, [230, 302, 468]], [100, [23, 30, 47]], [1, [0, 0, 1]], [42600, [9800, 12900, 19900]], [99999, [9800, 12900, 19900]], [0, [0, 0, 0]]]),
  table('fixed amount adds up', "totalDiscount(lines, [{ type: 'fixed', value: input }])", [[1000, 1000], [333, 333], [1, 1], [42599, 42599], [50000, 42600]]),
  table('every second unit free', "lineDiscounts([{ sku: 'TEA-001', price: 4900, qty: input }], [{ type: 'bogo', sku: 'TEA-001' }])", [[1, [0]], [2, [4900]], [3, [4900]], [4, [9800]], [7, [14700]]]),
  `test('rules stack in order', () => assert.deepEqual(lineDiscounts(lines, [{ type: 'percent', value: 10 }, { type: 'percent', value: 10 }]), [1862, 2451, 3781]))\n`,
  `test('percent then fixed', () => assert.equal(totalDiscount(lines, [{ type: 'percent', value: 10 }, { type: 'fixed', value: 500 }]), 4760))\n`,
  `test('bogo only touches its sku', () => assert.deepEqual(lineDiscounts(lines, [{ type: 'bogo', sku: 'TEA-001' }]), [4900, 0, 0]))\n`,
  `test('a discount never exceeds the line', () => assert.deepEqual(lineDiscounts(lines, [{ type: 'percent', value: 100 }, { type: 'fixed', value: 500 }]), [9800, 12900, 19900]))\n`,
  `test('an unknown rule is refused', () => assert.throws(() => lineDiscounts(lines, [{ type: 'half' }]), TypeError))\n`,
  `test('no rules, no discount', () => assert.equal(totalDiscount(lines, []), 0))\n`,
].join('\n')

files['test/cart.test.js'] = head(`import { addItem, addRule, createCart, removeItem, subtotal, totals } from '../src/cart.js'`) + `
const tea = { sku: 'TEA-001', name: 'Green tea', price: 4900, category: 'food' }
const mug = { sku: 'MUG-010', name: 'Mug', price: 12900 }
const book = { sku: 'BOOK-100', name: 'Tea handbook', price: 19900, category: 'books' }
const filled = (region = 'SE') => addItem(addItem(addItem(createCart(region), tea, 2), mug), book)

test('a new cart is empty', () => assert.deepEqual(createCart(), { region: 'SE', lines: [], rules: [] }))
test('adding the same sku raises its quantity', () => assert.equal(addItem(addItem(createCart(), tea), tea, 2).lines[0].qty, 3))
test('a line without a category is standard', () => assert.equal(addItem(createCart(), mug).lines[0].category, 'standard'))
test('quantity must be whole', () => assert.throws(() => addItem(createCart(), tea, 1.5), RangeError))
test('quantity must be above zero', () => assert.throws(() => addItem(createCart(), tea, 0), RangeError))
test('price must be in minor units', () => assert.throws(() => addItem(createCart(), { ...tea, price: 49.5 }), TypeError))
test('removing some units keeps the line', () => assert.equal(removeItem(filled(), 'TEA-001', 1).lines[0].qty, 1))
test('removing all units drops the line', () => assert.equal(removeItem(filled(), 'TEA-001').lines.length, 2))
test('removing more than there is drops the line', () => assert.equal(removeItem(filled(), 'TEA-001', 9).lines.length, 2))
test('removing an unknown sku changes nothing', () => assert.equal(removeItem(filled(), 'NOPE-000').lines.length, 3))
test('subtotal', () => assert.equal(subtotal(filled()), 42600))
test('subtotal of an empty cart', () => assert.equal(subtotal(createCart()), 0))
` + [
  table('totals by region', 'totals(filled(input))', [['SE', { subtotal: 42600, discount: 0, net: 42600, tax: 5595, total: 48195 }], ['DE', { subtotal: 42600, discount: 0, net: 42600, tax: 4530, total: 47130 }], ['FR', { subtotal: 42600, discount: 0, net: 42600, tax: 4214, total: 46814 }], ['NO', { subtotal: 42600, discount: 0, net: 42600, tax: 9670, total: 52270 }]]),
  table('totals with percent off', "totals(addRule(filled(), { type: 'percent', value: input }))", [[10, { subtotal: 42600, discount: 4260, net: 38340, tax: 5036, total: 43376 }], [50, { subtotal: 42600, discount: 21300, net: 21300, tax: 2798, total: 24098 }], [100, { subtotal: 42600, discount: 42600, net: 0, tax: 0, total: 0 }]]),
  table('totals with a fixed amount off', "totals(addRule(filled(), { type: 'fixed', value: input }))", [[1000, { subtotal: 42600, discount: 1000, net: 41600, tax: 5464, total: 47064 }], [42600, { subtotal: 42600, discount: 42600, net: 0, tax: 0, total: 0 }]]),
  `test('totals with every second tea free', () => assert.deepEqual(totals(addRule(filled(), { type: 'bogo', sku: 'TEA-001' })), { subtotal: 42600, discount: 4900, net: 37700, tax: 5007, total: 42707 }))\n`,
  `test('totals of an empty cart', () => assert.deepEqual(totals(createCart()), { subtotal: 0, discount: 0, net: 0, tax: 0, total: 0 }))\n`,
].join('\n')

files['test/dates.test.js'] = head(`import { addBusinessDays, addDays, daysBetween, dueDate, isWeekend, quarter, weekday } from '../src/dates.js'`) + [
  table('addDays', 'addDays(...input)', [[['2026-01-31', 1], '2026-02-01'], [['2026-02-28', 1], '2026-03-01'], [['2028-02-28', 1], '2028-02-29'], [['2026-12-31', 1], '2027-01-01'], [['2026-03-01', -1], '2026-02-28'], [['2026-06-15', 0], '2026-06-15'], [['2026-03-28', 2], '2026-03-30'], [['2026-10-24', 2], '2026-10-26']]),
  table('weekday', 'weekday(input)', [['2026-11-13', 5], ['2026-11-14', 6], ['2026-11-15', 0], ['2026-11-16', 1], ['2024-02-29', 4]]),
  table('isWeekend', 'isWeekend(input)', [['2026-11-13', false], ['2026-11-14', true], ['2026-11-15', true], ['2026-11-16', false]]),
  table('addBusinessDays', 'addBusinessDays(...input)', [[['2026-11-09', 1], '2026-11-10'], [['2026-11-09', 4], '2026-11-13'], [['2026-11-09', 5], '2026-11-16'], [['2026-11-13', 1], '2026-11-16'], [['2026-11-13', 2], '2026-11-17'], [['2026-11-14', 1], '2026-11-16'], [['2026-11-15', 1], '2026-11-16'], [['2026-11-12', 3], '2026-11-17'], [['2026-11-09', 10], '2026-11-23'], [['2026-11-09', 0], '2026-11-09'], [['2026-12-31', 1], '2027-01-01']]),
  table('daysBetween', 'daysBetween(...input)', [[['2026-01-01', '2026-01-31'], 30], [['2026-01-01', '2027-01-01'], 365], [['2028-01-01', '2029-01-01'], 366], [['2026-03-01', '2026-02-28'], -1], [['2026-06-15', '2026-06-15'], 0]]),
  table('dueDate', 'dueDate(...input)', [[['2026-11-13'], '2026-12-14'], [['2026-11-13', 10], '2026-11-23'], [['2026-11-02', 30], '2026-12-02'], [['2026-11-06', 1], '2026-11-09'], [['2026-11-05', 2], '2026-11-09'], [['2026-11-13', 0], '2026-11-13']]),
  table('quarter', 'quarter(input)', [['2026-01-01', '2026-Q1'], ['2026-03-31', '2026-Q1'], ['2026-04-01', '2026-Q2'], ['2026-09-30', '2026-Q3'], ['2026-12-31', '2026-Q4']]),
  `test('a day that does not exist is refused', () => assert.throws(() => addDays('2026-02-30', 1), RangeError))\n`,
  `test('text is refused', () => assert.throws(() => weekday('tomorrow'), RangeError))\n`,
].join('\n')

files['test/id.test.js'] = head(`import { invoiceNumber, isValidInvoiceNumber, luhn } from '../src/id.js'`) + [
  table('luhn', 'luhn(input)', [['7992739871', '3'], ['202600001', '4'], ['202600002', '2'], ['000000000', '0'], ['1', '8'], ['123456789', '7']]),
  table('invoiceNumber', 'invoiceNumber(...input)', [[[2026, 1], 'INV-2026000014'], [[2026, 2], 'INV-2026000022'], [[2026, 12345], 'INV-2026123451'], [[2027, 1, 'CR'], 'CR-2027000013']]),
  table('isValidInvoiceNumber', 'isValidInvoiceNumber(input)', [['INV-2026000014', true], ['INV-2026000018', false], ['INV-202600001', false], ['inv-2026000014', false], ['CR-2027000013', true], ['', false]]),
  `test('seq must be above zero', () => assert.throws(() => invoiceNumber(2026, 0), RangeError))\n`,
].join('\n')

files['test/invoice.test.js'] = head(`import { buildInvoice, render } from '../src/invoice.js'\nimport { addItem, addRule, createCart } from '../src/cart.js'`) + `
const cart = () => addItem(addItem(addItem(createCart('SE'), { sku: 'TEA-001', name: 'Green tea', price: 4900, category: 'food' }, 2), { sku: 'MUG-010', name: 'Mug', price: 12900 }), { sku: 'BOOK-100', name: 'Tea handbook', price: 19900, category: 'books' })
const customer = { name: 'Fika AB', email: 'hej@fika.example' }
const inv = (rules = [], opts = {}) => buildInvoice(rules.reduce(addRule, cart()), customer, { issued: '2026-11-13', seq: 7, ...opts })

test('number carries the year, the sequence and a check digit', () => assert.equal(inv().number, 'INV-2026000071'))
test('due thirty days on, moved off the weekend', () => assert.equal(inv().due, '2026-12-14'))
test('due with shorter terms', () => assert.equal(inv([], { terms: 10 }).due, '2026-11-23'))
test('totals', () => assert.deepEqual([inv().net, inv().tax, inv().total], [42600, 5595, 48195]))
test('vat per rate', () => assert.deepEqual(inv().vat, [{ rate: 25, tax: 3225 }, { rate: 12, tax: 1176 }, { rate: 6, tax: 1194 }]))
test('vat adds up to the tax', () => assert.equal(inv().vat.reduce((n, v) => n + v.tax, 0), inv().tax))
test('lines carry their discount', () => assert.deepEqual(inv([{ type: 'percent', value: 10 }]).lines.map((l) => l.discount), [980, 1290, 1990]))
test('lines carry their net', () => assert.deepEqual(inv([{ type: 'percent', value: 10 }]).lines.map((l) => l.net), [8820, 11610, 17910]))
test('vat after a discount', () => assert.deepEqual(inv([{ type: 'percent', value: 10 }]).vat, [{ rate: 25, tax: 2903 }, { rate: 12, tax: 1058 }, { rate: 6, tax: 1075 }]))
test('vat after a discount adds up', () => { const i = inv([{ type: 'fixed', value: 1000 }]); assert.equal(i.vat.reduce((n, v) => n + v.tax, 0), i.tax) })
test('customer is copied, not shared', () => assert.notEqual(inv().customer, customer))
test('currency defaults to SEK', () => assert.equal(inv().currency, 'SEK'))
test('an empty cart is refused', () => assert.throws(() => buildInvoice(createCart(), customer, { issued: '2026-11-13', seq: 1 }), /at least one line/))
test('render lists every line and the total', () => {
  const text = render(inv())
  assert.match(text, /Invoice INV-2026000071/)
  assert.match(text, /2 x Green tea\\s+98\\.00 SEK/)
  assert.match(text, /VAT 25%\\s+32\\.25 SEK/)
  assert.match(text, /Total\\s+481\\.95 SEK/)
})
test('render shows the dates', () => assert.match(render(inv()), /issued 2026-11-13, due 2026-12-14/))
`

files['test/inventory.test.js'] = head(`import { available, commit, createStock, lowStock, release, reserve } from '../src/inventory.js'`) + `
const stock = () => createStock({ 'TEA-001': 10, 'MUG-010': 3, 'BOOK-100': 0 })
` + [
  table('available', 'available(stock(), input)', [['TEA-001', 10], ['MUG-010', 3], ['BOOK-100', 0], ['NOPE-000', 0]]),
  table('reserve', 'reserve(stock(), ...input)', [[['TEA-001', 1], true], [['TEA-001', 10], true], [['TEA-001', 11], false], [['BOOK-100', 1], false], [['NOPE-000', 1], false], [['MUG-010', 3], true]]),
  `test('reserving lowers what is available', () => { const s = stock(); reserve(s, 'TEA-001', 4); assert.equal(available(s, 'TEA-001'), 6) })\n`,
  `test('two reservations add up', () => { const s = stock(); reserve(s, 'TEA-001', 4); reserve(s, 'TEA-001', 5); assert.equal(available(s, 'TEA-001'), 1) })\n`,
  `test('a refused reservation changes nothing', () => { const s = stock(); reserve(s, 'MUG-010', 4); assert.equal(available(s, 'MUG-010'), 3) })\n`,
  `test('release gives units back', () => { const s = stock(); reserve(s, 'TEA-001', 4); release(s, 'TEA-001', 3); assert.equal(available(s, 'TEA-001'), 9) })\n`,
  `test('release never goes below zero', () => { const s = stock(); release(s, 'TEA-001', 3); assert.equal(available(s, 'TEA-001'), 10) })\n`,
  `test('commit takes units out for good', () => { const s = stock(); reserve(s, 'TEA-001', 4); commit(s, 'TEA-001', 4); assert.deepEqual([s.levels['TEA-001'], available(s, 'TEA-001')], [6, 6]) })\n`,
  `test('commit needs a reservation', () => assert.throws(() => commit(stock(), 'TEA-001', 1), /never reserved/))\n`,
  `test('lowStock lists what is at or under the floor', () => assert.deepEqual(lowStock(stock()), ['BOOK-100', 'MUG-010']))\n`,
  `test('lowStock counts reservations', () => { const s = stock(); reserve(s, 'TEA-001', 6); assert.deepEqual(lowStock(s), ['BOOK-100', 'MUG-010', 'TEA-001']) })\n`,
].join('\n')

files['test/csv.test.js'] = head(`import { parseCsv, toCsv, toObjects } from '../src/csv.js'`) + [
  table('parseCsv', 'parseCsv(input)', [['a,b,c', [['a', 'b', 'c']]], ['a,b\n1,2', [['a', 'b'], ['1', '2']]], ['a,b\r\n1,2\r\n', [['a', 'b'], ['1', '2']]], ['"a,b",c', [['a,b', 'c']]], ['"say ""hi""",x', [['say "hi"', 'x']]], ['"two\nlines",x', [['two\nlines', 'x']]], ['a,,c', [['a', '', 'c']]], ['', []], [',', [['', '']]], ['a\n\nb', [['a'], [''], ['b']]]]),
  table('toCsv', 'toCsv(input)', [[[['a', 'b']], 'a,b'], [[['a,b', 'c']], '"a,b",c'], [[['say "hi"']], '"say ""hi"""'], [[['1', '2'], ['3', '4']], '1,2\n3,4'], [[[1, 2.5, true]], '1,2.5,true'], [[['two\nlines']], '"two\nlines"']]),
  `test('a round trip keeps every field', () => { const rows = [['sku', 'name'], ['TEA-001', 'Green tea, loose'], ['MUG-010', 'Mug "classic"']]; assert.deepEqual(parseCsv(toCsv(rows)), rows) })\n`,
  `test('toObjects uses the first row as keys', () => assert.deepEqual(toObjects('sku,qty\\nTEA-001,2\\nMUG-010,1'), [{ sku: 'TEA-001', qty: '2' }, { sku: 'MUG-010', qty: '1' }]))\n`,
  `test('toObjects fills short rows', () => assert.deepEqual(toObjects('a,b\\n1'), [{ a: '1', b: '' }]))\n`,
].join('\n')

files['test/validate.test.js'] = head(`import { isEmail, isOrgNumber, isSku, validateCustomer } from '../src/validate.js'`) + [
  table('isEmail', 'isEmail(input)', [['hej@fika.example', true], ['a@b.se', true], ['a.b+c@d.co.uk', true], ['a@b', false], ['@b.se', false], ['a b@c.se', false], ['', false], ['a@b.c', false]]),
  table('isSku', 'isSku(input)', [['TEA-001', true], ['BOOK-100', true], ['AB-123456', true], ['tea-001', false], ['TEA001', false], ['T-001', false], ['TOOLONG-001', false], ['TEA-01', false]]),
  table('isOrgNumber', 'isOrgNumber(input)', [['556036-0793', true], ['5560360793', true], ['556036-0794', false], ['55603-0793', false], ['abcdefghij', false], ['212000-0142', true]]),
  table('validateCustomer', 'validateCustomer(input)', [[{ name: 'Fika AB', email: 'hej@fika.example' }, []], [{ name: ' ', email: 'hej@fika.example' }, ['name is required']], [{ name: 'Fika AB', email: 'nope' }, ['email is not valid']], [{ name: 'Fika AB', email: 'hej@fika.example', org: '556036-0793' }, []], [{ name: 'Fika AB', email: 'hej@fika.example', org: '1' }, ['organisation number is not valid']], [{}, ['name is required', 'email is not valid']]]),
  `test('validateCustomer copes with nothing', () => assert.deepEqual(validateCustomer(undefined), ['name is required', 'email is not valid']))\n`,
].join('\n')

files['test/currency.test.js'] = head(`import { convert } from '../src/currency.js'`) + [
  table('convert', 'convert(...input)', [[[1000, 'EUR', 'SEK'], 11200], [[11200, 'SEK', 'EUR'], 1000], [[1000, 'SEK', 'SEK'], 1000], [[1000, 'USD', 'GBP'], 787], [[1, 'EUR', 'SEK'], 11], [[0, 'EUR', 'USD'], 0], [[-1000, 'EUR', 'NOK'], -11600], [[999, 'DKK', 'SEK'], 1500], [[100, 'GBP', 'USD'], 127]]),
  `test('an unknown currency is refused', () => assert.throws(() => convert(100, 'EUR', 'XYZ'), RangeError))\n`,
  `test('a custom table is used', () => assert.equal(convert(100, 'EUR', 'SEK', { EUR: 1, SEK: 10 }), 1000))\n`,
].join('\n')

files['test/report.test.js'] = head(`import { best, byCategory, byQuarter, daily } from '../src/report.js'\nimport { addItem, createCart } from '../src/cart.js'`) + `
const tea = { sku: 'TEA-001', name: 'Green tea', price: 4900, category: 'food' }
const mug = { sku: 'MUG-010', name: 'Mug', price: 12900 }
const sale = (date, ...items) => ({ date, cart: items.reduce((c, [item, qty]) => addItem(c, item, qty), createCart('SE')) })
const sales = [sale('2026-11-12', [tea, 2]), sale('2026-11-13', [mug, 1]), sale('2026-11-12', [mug, 2], [tea, 1]), sale('2026-07-01', [tea, 10])]

test('daily has one row per day, oldest first', () => assert.deepEqual(daily(sales).map((d) => d.date), ['2026-07-01', '2026-11-12', '2026-11-13']))
test('daily counts sales', () => assert.deepEqual(daily(sales).map((d) => d.sales), [1, 2, 1]))
test('daily adds net', () => assert.deepEqual(daily(sales).map((d) => d.net), [49000, 40500, 12900]))
test('daily adds tax', () => assert.deepEqual(daily(sales).map((d) => d.tax), [5880, 8214, 3225]))
test('daily total is net plus tax', () => { for (const d of daily(sales)) assert.equal(d.total, d.net + d.tax) })
test('daily of nothing is empty', () => assert.deepEqual(daily([]), []))
test('byCategory adds line values', () => assert.deepEqual(byCategory(sales), { food: 63700, standard: 38700 }))
test('byQuarter adds totals', () => assert.deepEqual(byQuarter(sales), { '2026-Q3': 54880, '2026-Q4': 64839 }))
test('best lists top sellers', () => assert.deepEqual(best(sales, 2), [{ sku: 'TEA-001', sold: 13 }, { sku: 'MUG-010', sold: 3 }]))
test('best defaults to three', () => assert.equal(best(sales).length, 2))
`

files['test/util.test.js'] = head(`import { camel, capitalize, count, padCenter, slug, truncate } from '../src/util/strings.js'\nimport { chunk, groupBy, range, sortBy, sum, unique, zip } from '../src/util/arrays.js'\nimport { deepEqual, get, isEmpty, mapValues, omit, pick } from '../src/util/objects.js'\nimport { createCache } from '../src/util/cache.js'\nimport { createEmitter } from '../src/util/events.js'`) + [
  table('slug', 'slug(input)', [['Green Tea', 'green-tea'], ['  Kaffe & Bulle  ', 'kaffe-bulle'], ['Smörgås', 'smorgas'], ['a--b', 'a-b'], ['', ''], ['Über 100%', 'uber-100']]),
  table('truncate', 'truncate(...input)', [[['hello', 10], 'hello'], [['hello world', 8], 'hello w…'], [['hello world', 6], 'hello…'], [['abc', 3], 'abc'], [['abcd', 1], '…']]),
  table('capitalize', 'capitalize(input)', [['tea', 'Tea'], ['Tea', 'Tea'], ['', ''], ['é', 'É']]),
  table('camel', 'camel(input)', [['line-total', 'lineTotal'], ['line_total_net', 'lineTotalNet'], ['line total', 'lineTotal'], ['total', 'total']]),
  table('padCenter', 'padCenter(...input)', [[['ab', 6], '  ab  '], [['ab', 5], ' ab  '], [['abc', 2], 'abc'], [['', 2], '  ']]),
  table('count', 'count(...input)', [[['banana', 'a'], 3], [['banana', 'an'], 2], [['banana', 'x'], 0], [['banana', ''], 0]]),
  table('chunk', 'chunk(...input)', [[[[1, 2, 3, 4, 5], 2], [[1, 2], [3, 4], [5]]], [[[1, 2], 5], [[1, 2]]], [[[], 3], []], [[[1, 2, 3], 1], [[1], [2], [3]]]]),
  table('unique', 'unique(input)', [[[1, 1, 2, 3, 3], [1, 2, 3]], [[], []], [['a', 'b', 'a'], ['a', 'b']]]),
  table('sum', 'sum(input)', [[[1, 2, 3], 6], [[], 0], [[-1, 1], 0]]),
  table('zip', 'zip(...input)', [[[[1, 2], ['a', 'b']], [[1, 'a'], [2, 'b']]], [[[1, 2, 3], ['a']], [[1, 'a']]], [[[], [1]], []]]),
  table('range', 'range(...input)', [[[0, 3], [0, 1, 2]], [[1, 10, 3], [1, 4, 7]], [[3, 3], []], [[5, 0], []]]),
  table('pick', 'pick(...input)', [[[{ a: 1, b: 2, c: 3 }, ['a', 'c']], { a: 1, c: 3 }], [[{ a: 1 }, ['z']], {}], [[{}, []], {}]]),
  table('omit', 'omit(...input)', [[[{ a: 1, b: 2, c: 3 }, ['b']], { a: 1, c: 3 }], [[{ a: 1 }, ['z']], { a: 1 }], [[{ a: 1 }, ['a']], {}]]),
  table('isEmpty', 'isEmpty(input)', [[{}, true], [[], true], ['', true], [null, true], [{ a: 1 }, false], [[0], false], ['a', false], [0, false]]),
  table('deepEqual', 'deepEqual(...input)', [[[{ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }], true], [[{ a: 1 }, { a: 2 }], false], [[[1, 2], [1, 2, 3]], false], [[1, 1], true], [[null, {}], false], [[{ a: 1, b: 2 }, { b: 2, a: 1 }], true]]),
  table('get', 'get(...input)', [[[{ a: { b: { c: 1 } } }, 'a.b.c'], 1], [[{ a: {} }, 'a.b.c', 'none'], 'none'], [[{ a: 0 }, 'a', 5], 0], [[{}, 'x', 5], 5]]),
  `test('groupBy collects by key', () => assert.deepEqual(groupBy([1, 2, 3, 4], (n) => (n % 2 ? 'odd' : 'even')), { odd: [1, 3], even: [2, 4] }))\n`,
  `test('sortBy does not change its input', () => { const list = [3, 1, 2]; assert.deepEqual([sortBy(list, (n) => n), list], [[1, 2, 3], [3, 1, 2]]) })\n`,
  `test('mapValues keeps the keys', () => assert.deepEqual(mapValues({ a: 1, b: 2 }, (v) => v * 2), { a: 2, b: 4 }))\n`,
  `test('cache returns what was set', () => { const c = createCache(); c.set('a', 1); assert.equal(c.get('a'), 1) })\n`,
  `test('cache drops the least recently used', () => { const c = createCache(2); c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3); assert.deepEqual(c.keys(), ['a', 'c']) })\n`,
  `test('cache misses are undefined', () => assert.equal(createCache().get('nope'), undefined))\n`,
  `test('cache set twice keeps one entry', () => { const c = createCache(); c.set('a', 1); c.set('a', 2); assert.deepEqual([c.size, c.get('a')], [1, 2]) })\n`,
  `test('emitter calls handlers', () => { const e = createEmitter(); const seen = []; e.on('sale', (x) => seen.push(x)); e.emit('sale', 1); e.emit('sale', 2); assert.deepEqual(seen, [1, 2]) })\n`,
  `test('emitter off stops a handler', () => { const e = createEmitter(); const seen = []; const off = e.on('sale', (x) => seen.push(x)); off(); e.emit('sale', 1); assert.deepEqual(seen, []) })\n`,
  `test('emitter once fires once', () => { const e = createEmitter(); let n = 0; e.once('sale', () => n++); e.emit('sale'); e.emit('sale'); assert.equal(n, 1) })\n`,
  `test('emit says how many heard', () => { const e = createEmitter(); e.on('a', () => {}); e.on('a', () => {}); assert.deepEqual([e.emit('a'), e.emit('b')], [2, 0]) })\n`,
].join('\n')

// Three bugs of the kind that slip through review. Each breaks tests in more than one file.
const BUGS = [
  ['src/money.js', 'for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k][1]]++', 'if (left > 0) parts[order[0][1]] += left - 1'],
  ['src/tax.js', 'return table[category] ?? table.standard', 'return table[category] || RATES.SE.standard'],
  ['src/dates.js', "if (!isWeekend(day)) left--", "if (weekday(day) !== 0) left--"],
]

export function writeRepo(dir, { fixed = false } = {}) {
  const out = { ...files }
  if (!fixed) for (const [file, good, bad] of BUGS) {
    if (!out[file].includes(good)) throw new Error(`bug target missing in ${file}`)
    out[file] = out[file].replace(good, bad)
  }
  for (const [name, text] of Object.entries(out)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return Object.keys(out)
}

if (/[\\/]repo\.mjs$/.test(process.argv[1] ?? '')) {
  const dir = process.argv[2]
  if (!dir) { console.error('usage: node repo.mjs <dir> [--fixed]'); process.exit(1) }
  console.log(`${writeRepo(dir, { fixed: process.argv.includes('--fixed') }).length} files in ${dir}`)
}
