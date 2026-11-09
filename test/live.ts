import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../electron/store'
import { Engine } from '../electron/room/engine'

// Real agents, real usage. Run by hand: node scripts/live.mjs
const root = mkdtempSync(join(tmpdir(), 'lunchbox-live-'))
const store = new Store(join(root, 'data'), { seal: (t) => t, open: (t) => t })
store.saveSettings({ models: { claude: 'haiku' } })
const engine = new Engine(store, { emit: () => {}, notify: () => {}, packs: () => [] })

await engine.refresh()
const room = engine.create({ crew: ['claude', 'grok'], workspace: root })
engine.send(room.id, 'Ask @grok for the current year in one word, then tell me what it said in one short sentence. Do not use any tools.', 'plan')
await engine.idle(room.id)
for (const e of store.events(room.id)) {
  const text = e.kind === 'say' ? `${e.who}: ${e.text}${e.error ? ` [${e.error}]` : ''}` : e.kind === 'hands' ? `${e.from} -> ${e.to}: ${e.ask} => ${e.answer}` : e.kind === 'you' ? `you: ${e.text}` : JSON.stringify(e)
  console.log(`${e.kind.padEnd(6)} ${text.slice(0, 220)}`)
}
console.log('ledger', JSON.stringify(store.totals().today))
store.flush()
