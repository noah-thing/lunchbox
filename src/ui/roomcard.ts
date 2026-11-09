import type { AgentInfo, Event, RoomMeta } from '../../shared/types'
import { BRANDS } from './brands'
import { agentOf, desk, money, reason } from '../lib/desk'

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

// A room as one image for X: who worked, in the order they held the turn, joined where one
// handed to the next, with the time, the cost and every claim that was proved.
export async function roomCard(meta: RoomMeta, events: Event[], agents: AgentInfo[], say: (t: string) => void) {
  const ink = '#f2f0ea', dim = 'rgba(242,240,234,.62)', faint = 'rgba(242,240,234,.36)', line = 'rgba(242,240,234,.14)'
  const turns = events.flatMap((e) => (e.kind === 'say' ? [e.who] : e.kind === 'hands' ? [e.to] : []))
  const relay = turns.filter((w, i) => w !== turns[i - 1]).slice(0, 12)
  const handoffs = events.filter((e) => e.kind === 'hands' || e.kind === 'wall').length
  const cost = events.reduce((n, e) => n + ((e.kind === 'say' || e.kind === 'hands') ? e.usage?.cost ?? 0 : 0), 0)
  const proofs = events.flatMap((e) => (e.kind === 'say' ? e.proof ?? [] : [])).filter((p) => p.ok)
  const first = events.find((e) => e.kind === 'you')?.at ?? meta.created
  const mins = Math.max(1, Math.round((meta.updated - first) / 60e3))
  const crew = [...new Set(turns)].map((id) => agentOf(id, agents).short)
  const names = crew.length > 1 ? `${crew.slice(0, -1).join(', ')} and ${crew.at(-1)}` : crew[0] ?? 'One agent'
  const step = Math.min(110, 1040 / Math.max(1, relay.length))
  const marks = relay.map((id, i) => {
    const x = 80 + i * step
    const paths = BRANDS[agentOf(id, agents).mark]
    const glyph = paths ? `<g transform="translate(${x + 14} 324) scale(1.17)" fill="${ink}" fill-rule="evenodd">${paths.map((d) => `<path d="${d}"/>`).join('')}</g>` : `<text x="${x + 28}" y="345" fill="${ink}" font-size="22" text-anchor="middle">${esc(agentOf(id, agents).short[0])}</text>`
    const join = i ? `<line x1="${x - step + 64}" x2="${x - 8}" y1="338" y2="338" stroke="${line}" stroke-width="2" stroke-dasharray="4 6"/>` : ''
    return `${join}<rect x="${x}" y="310" width="56" height="56" rx="14" fill="none" stroke="${line}" stroke-width="1.5"/>${glyph}`
  }).join('')
  const proofLines = proofs.slice(0, 3).map((p, i) => `<text x="80" y="${450 + i * 40}" fill="${dim}" font-size="22"><tspan fill="${ink}">Proved:</tspan> ${esc(p.claim)}</text>`).join('')
  const title = meta.name.length > 54 ? `${meta.name.slice(0, 53)}…` : meta.name
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" font-family="Helvetica Neue, Helvetica, Arial, sans-serif">
<rect width="1200" height="675" fill="#0d0d0c"/>
<text x="80" y="130" fill="${ink}" font-size="46" font-weight="500" letter-spacing="-1.2">${esc(title)}</text>
<text x="80" y="182" fill="${dim}" font-size="24">${esc(names)} worked it through in ${mins} minute${mins > 1 ? 's' : ''}${handoffs ? `, with ${handoffs} handoff${handoffs > 1 ? 's' : ''}` : ''}${cost ? `, for ${money(cost)}` : ''}.</text>
${marks}
${proofLines || `<text x="80" y="450" fill="${faint}" font-size="22">Every answer kept in one room, with one memory.</text>`}
<text x="1120" y="620" fill="${faint}" font-size="20" text-anchor="end">Lunchbox</text>
</svg>`
  try {
    const img = new Image()
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 2400
    canvas.height = 1350
    const g = canvas.getContext('2d')!
    g.scale(2, 2)
    g.drawImage(img, 0, 0)
    const file = await desk.call('save:png', canvas.toDataURL('image/png'), 'lunchbox-room.png')
    if (file) say('Card saved, ready to post')
  } catch (e) {
    say(reason(e))
  }
}
