// The anonymous Lunchbox install counter. Once a day each copy that has not turned the count off
// sends a random ID it made on first launch, its version and its system. The ID is hashed before it
// is stored, IP addresses are never stored, and requests are not logged. To stop one network from
// flooding the counter, a one way hash of the address, salted with a server secret and the day, is
// kept for two days and nothing else about it. /stats shows the totals to whoever holds STATS_KEY.

import { ipBucket } from './ipKey'

interface Env {
  DB: D1Database
  STATS_KEY: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9a-z.]{1,20})?$/
const OS = new Set(['darwin', 'win32', 'linux'])
const ARCH = new Set(['arm64', 'x64'])
const MAX_BODY = 4 * 1024
const NEW_INSTALLS_PER_IP_PER_DAY = 200

const day = (offset = 0) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10)

async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function readObject(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return null
  const text = await req.text().catch(() => '')
  if (text.length > MAX_BODY) return null
  try {
    const j: unknown = JSON.parse(text)
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// Counts one new install for this network today and says whether it is over the limit.
async function overIpLimit(req: Request, env: Env) {
  const ip = req.headers.get('cf-connecting-ip')
  if (!ip) return false
  try {
    const hash = await sha256(`${env.STATS_KEY ?? ''}|${day()}|${ipBucket(ip)}`)
    const row = await env.DB.prepare(
      'INSERT INTO ip_limits (kind, period, hash, n) VALUES (?1, ?2, ?3, 1) ON CONFLICT (kind, period, hash) DO UPDATE SET n = n + 1 RETURNING n',
    ).bind('ping', day(), hash).first<{ n: number }>()
    await env.DB.prepare('DELETE FROM ip_limits WHERE period < ?1').bind(day(2)).run()
    return Number(row?.n ?? 0) > NEW_INSTALLS_PER_IP_PER_DAY
  } catch {
    return false
  }
}

async function ping(req: Request, env: Env) {
  const b = await readObject(req)
  if (!b) return new Response('bad ping', { status: 400 })
  const { id, version, os, arch } = b
  if (typeof id !== 'string' || typeof version !== 'string' || typeof os !== 'string' || typeof arch !== 'string') return new Response('bad ping', { status: 400 })
  const lid = id.toLowerCase()
  if (!UUID.test(lid) || !VERSION.test(version) || !OS.has(os) || !ARCH.has(arch)) return new Response('bad ping', { status: 400 })
  const hash = await sha256(lid)
  const today = day()
  // Known installs only check in; new IDs count against the network's daily limit, so a script
  // cannot inflate the total.
  const known = await env.DB.prepare('SELECT 1 AS k FROM installs WHERE hash = ?1').bind(hash).first()
  if (!known && (await overIpLimit(req, env))) return new Response('too many new installs from this network', { status: 429 })
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO installs (hash, first_day, last_day, os, arch, version) VALUES (?1, ?2, ?2, ?3, ?4, ?5)
       ON CONFLICT (hash) DO UPDATE SET last_day = ?2, os = ?3, arch = ?4, version = ?5`,
    ).bind(hash, today, os, arch, version),
    env.DB.prepare('INSERT INTO active (day, hash, version) VALUES (?1, ?2, ?3) ON CONFLICT (day, hash) DO UPDATE SET version = ?3').bind(today, hash, version),
  ])
  return new Response(null, { status: 204 })
}

// Constant time, so the key cannot be guessed one character at a time.
function sameKey(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const newer = (a: string, b: string) => {
  const p = a.split(/[.-]/).map(Number), q = b.split(/[.-]/).map(Number)
  for (let i = 0; i < 3; i++) if ((p[i] || 0) !== (q[i] || 0)) return (p[i] || 0) > (q[i] || 0)
  return false
}

async function stats(env: Env) {
  const one = async (sql: string, ...args: unknown[]) => Number((await env.DB.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? 0)
  const all = async <T>(sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).all<T>()).results
  const versionsWeek = await all<{ version: string; n: number }>('SELECT version, COUNT(DISTINCT hash) AS n FROM active WHERE day >= ?1 GROUP BY version', day(6))
  const latest = versionsWeek.map((r) => r.version).reduce((a, b) => (newer(b, a) ? b : a), '0.0.0')
  // How far the newest version has spread: of the installs opened on each day, how many ran it.
  const reach = await all<{ day: string; on: number; active: number }>(
    'SELECT day, SUM(version = ?2) AS "on", COUNT(*) AS active FROM active WHERE day >= ?1 GROUP BY day ORDER BY day', day(13), latest)
  return {
    total: await one('SELECT COUNT(*) AS n FROM installs'),
    newToday: await one('SELECT COUNT(*) AS n FROM installs WHERE first_day = ?1', day()),
    newWeek: await one('SELECT COUNT(*) AS n FROM installs WHERE first_day >= ?1', day(6)),
    activeToday: await one('SELECT COUNT(*) AS n FROM active WHERE day = ?1', day()),
    activeWeek: await one('SELECT COUNT(DISTINCT hash) AS n FROM active WHERE day >= ?1', day(6)),
    activeMonth: await one('SELECT COUNT(DISTINCT hash) AS n FROM active WHERE day >= ?1', day(29)),
    latest,
    onLatestWeek: versionsWeek.find((r) => r.version === latest)?.n ?? 0,
    byOs: await all<{ os: string; n: number }>('SELECT os, COUNT(*) AS n FROM installs WHERE last_day >= ?1 GROUP BY os ORDER BY n DESC', day(29)),
    byVersionWeek: versionsWeek.sort((a, b) => b.n - a.n),
    reach,
    daily: await all<{ day: string; active: number }>('SELECT day, COUNT(*) AS active FROM active WHERE day >= ?1 GROUP BY day ORDER BY day', day(29)),
    newDaily: await all<{ day: string; n: number }>('SELECT first_day AS day, COUNT(*) AS n FROM installs WHERE first_day >= ?1 GROUP BY first_day ORDER BY first_day', day(29)),
  }
}

const OS_NAME: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const n = (v: unknown) => Number(v).toLocaleString('en')

function page(s: Awaited<ReturnType<typeof stats>>) {
  const days = Array.from({ length: 30 }, (_, i) => day(29 - i))
  const activeBy = new Map(s.daily.map((r) => [r.day, r.active]))
  const newBy = new Map(s.newDaily.map((r) => [r.day, r.n]))
  const max = Math.max(1, ...days.map((d) => activeBy.get(d) ?? 0))
  const bars = days.map((d) => {
    const a = activeBy.get(d) ?? 0, nw = newBy.get(d) ?? 0
    return `<div class="bar" title="${d}: ${a} active, ${nw} new"><i style="height:${(a / max) * 100}%"></i><b style="height:${(nw / max) * 100}%"></b></div>`
  }).join('')
  const rows = (list: { n: number }[], label: (r: never) => string) => {
    const total = list.reduce((x, r) => x + r.n, 0) || 1
    return list.map((r) => `<li><span>${esc(label(r as never))}</span><span class="track"><span style="width:${(r.n / total) * 100}%"></span></span><span class="n">${r.n}</span></li>`).join('') || '<li class="none">No data yet</li>'
  }
  const reach = s.reach.map((r) => `<li><span>${esc(r.day.slice(5))}</span><span class="track"><span style="width:${r.active ? (r.on / r.active) * 100 : 0}%"></span></span><span class="n">${r.on}/${r.active}</span></li>`).join('') || '<li class="none">No data yet</li>'
  const tile = (label: string, v: unknown, sub = '') => `<div class="tile"><div class="label">${label}</div><div class="num">${n(v)}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Lunchbox installs</title>
<style>
:root{--bg:#f5f4f0;--fg:#141412;--mute:#75736c;--line:#e4e2db;--card:#fff;--a:#141412;--b:#b3b0a7}
@media (prefers-color-scheme:dark){:root{--bg:#0e0e0d;--fg:#f2f0ea;--mute:#a3a097;--line:#262624;--card:#161614;--a:#f2f0ea;--b:#55534d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:880px;margin:0 auto;padding:40px 20px 60px}h1{font-size:20px;margin:0 0 4px}p.lead{color:var(--mute);margin:0 0 28px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:28px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.label{color:var(--mute);font-size:12px}.num{font-size:28px;font-weight:600;font-variant-numeric:tabular-nums}.sub{color:var(--mute);font-size:12px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}h2{font-size:13px;margin:0 0 12px;color:var(--mute);font-weight:500}
.chart{display:flex;align-items:flex-end;gap:3px;height:120px}.bar{flex:1;height:100%;position:relative}.bar i,.bar b{position:absolute;bottom:0;left:0;right:0;border-radius:3px 3px 0 0}.bar i{background:var(--b)}.bar b{background:var(--a)}
.legend{display:flex;gap:16px;color:var(--mute);font-size:12px;margin-top:8px}.legend span::before{content:"";display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:var(--b)}.legend span.new::before{background:var(--a)}
ul{list-style:none;margin:0;padding:0}li{display:grid;grid-template-columns:90px 1fr 64px;gap:10px;align-items:center;padding:4px 0}.track{height:8px;background:var(--line);border-radius:4px;overflow:hidden}.track span{display:block;height:100%;background:var(--a)}.n{text-align:right;font-variant-numeric:tabular-nums}.none{color:var(--mute);display:block}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media (max-width:640px){.cols{grid-template-columns:1fr}}
footer{color:var(--mute);font-size:12px;margin-top:20px}
</style></head><body><main>
<h1>Lunchbox installs</h1><p class="lead">Anonymous counts from copies that have the count turned on. Days are UTC.</p>
<div class="tiles">${tile('Total installs', s.total)}${tile('New today', s.newToday, `${n(s.newWeek)} this week`)}${tile('Active today', s.activeToday)}${tile('Active this week', s.activeWeek)}${tile(`On ${esc(s.latest)} this week`, s.onLatestWeek, `of ${n(s.activeWeek)} active`)}</div>
<section><h2>Last 30 days</h2><div class="chart">${bars}</div><div class="legend"><span>Active</span><span class="new">New installs</span></div></section>
<section><h2>Reach of ${esc(s.latest)}: installs opened each day that ran it</h2><ul>${reach}</ul></section>
<div class="cols"><section><h2>System, active this month</h2><ul>${rows(s.byOs, (r: { os: string }) => OS_NAME[r.os] ?? r.os)}</ul></section>
<section><h2>Version, active this week</h2><ul>${rows(s.byVersionWeek, (r: { version: string }) => r.version)}</ul></section></div>
<footer>Updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</footer>
</main></body></html>`
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/v1/ping' && req.method === 'POST') return ping(req, env)
    if (url.pathname === '/stats' || url.pathname === '/stats.json') {
      if (!sameKey(url.searchParams.get('key') ?? '', env.STATS_KEY ?? '')) return new Response('Not found', { status: 404 })
      const s = await stats(env)
      const headers = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' }
      return url.pathname === '/stats.json' ? Response.json(s, { headers }) : new Response(page(s), { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } })
    }
    return new Response('Not found', { status: 404 })
  },
}
