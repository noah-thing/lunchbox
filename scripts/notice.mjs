// Publishes the in-app message feed. Edit ~/lunchbox/notices.json (a list of notices), then run
// node scripts/notice.mjs. It signs the list with the private key in ~/lunchbox/keys, writes
// notices.json into the public lunchbox-releases checkout and pushes it. Every running copy of
// the app picks it up within half an hour, no update needed.
//
// A notice: { "id": "beta-welcome", "kind": "toast" | "card" | "banner", "title": "...",
//   "body": "...", "image": "https://...", "action": { "label": "...", "url": "https://..." },
//   "from": "0.1.0", "to": "0.2.0", "platforms": ["darwin", "win32", "linux"],
//   "after": "2026-11-10T09:00:00Z", "until": "2026-11-20T00:00:00Z" }
import { createPrivateKey, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = homedir()
const source = process.argv[2] ?? join(home, 'lunchbox/notices.json')
const repo = process.env.RELEASES ?? join(home, 'lunchbox/releases')
const key = createPrivateKey(readFileSync(join(home, 'lunchbox/keys/notices-ed25519.pem')))

const notices = JSON.parse(readFileSync(source, 'utf8'))
if (!Array.isArray(notices)) throw new Error(`${source} should hold a list of notices`)
const ids = new Set()
for (const n of notices) {
  if (!n.id || !['toast', 'card', 'banner'].includes(n.kind) || !n.title) throw new Error(`Each notice needs an id, a kind (toast, card or banner) and a title: ${JSON.stringify(n)}`)
  if (ids.has(n.id)) throw new Error(`Two notices share the id ${n.id}`)
  if ((n.image && !n.image.startsWith('https://')) || (n.action && !n.action.url?.startsWith('https://'))) throw new Error(`Images and links must be https: ${n.id}`)
  ids.add(n.id)
}
const sig = sign(null, Buffer.from(JSON.stringify(notices)), key).toString('base64')
writeFileSync(join(repo, 'notices.json'), JSON.stringify({ notices, sig }, null, 2) + '\n')
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'inherit' })
git('add', 'notices.json')
git('-c', 'user.name=Noah', '-c', 'user.email=261804785+noah-thing@users.noreply.github.com', 'commit', '-m', `Messages: ${notices.map((n) => n.id).join(', ') || 'none'}`)
git('push')
console.log(`Published ${notices.length} message${notices.length === 1 ? '' : 's'}.`)
