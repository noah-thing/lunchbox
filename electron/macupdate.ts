import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app, net } from 'electron'
import type { Asset } from './macfeed'

export { canReplace, parseFeed, pick, type Asset, type Feed } from './macfeed'

// macOS lets electron-updater install only signed apps, and Lunchbox is not signed yet. So on a Mac
// the update is done by hand: the release's zip is downloaded, checked against the hash in its
// feed, unpacked with ditto (which keeps the bundle's links and signature intact), and swapped in
// for the running app by a small script once the app has quit.

// The .app this process runs from: .../Lunchbox.app/Contents/MacOS/Lunchbox.
export function bundlePath(exe = app.getPath('exe')) {
  return resolve(exe, '..', '..', '..')
}

const run = (file: string, args: string[]) =>
  new Promise<number>((done) => {
    const p = spawn(file, args, { stdio: 'ignore' })
    p.on('error', () => done(-1))
    p.on('close', (code) => done(code ?? -1))
  })

const plistVersion = async (appPath: string) =>
  new Promise<string>((done) => {
    const p = spawn('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(appPath, 'Contents', 'Info.plist')])
    let out = ''
    p.stdout.on('data', (b) => (out += b))
    p.on('error', () => done(''))
    p.on('close', () => done(out.trim()))
  })

// Downloads, verifies and unpacks a release. Resolves with the path of the new Lunchbox.app, ready
// to be swapped in, or throws with a reason a person can read.
export async function prepare(base: string, version: string, asset: Asset, progress: (p: number) => void): Promise<string> {
  const dir = join(app.getPath('userData'), 'updates', version)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const zip = join(dir, 'update.zip')
  const res = await net.fetch(`${base}/download/v${version}/${asset.url}`)
  if (!res.ok || !res.body) throw new Error(`the download failed (${res.status})`)
  const hash = createHash('sha512')
  let got = 0
  const body = Readable.fromWeb(res.body as never)
  body.on('data', (chunk: Buffer) => {
    hash.update(chunk)
    got += chunk.length
    progress(Math.min(0.99, got / asset.size))
  })
  await pipeline(body, createWriteStream(zip))
  if (hash.digest('base64') !== asset.sha512) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error('the download did not match the release, so it was thrown away')
  }
  const out = join(dir, 'app')
  if ((await run('/usr/bin/ditto', ['-x', '-k', zip, out])) !== 0) throw new Error('the update could not be unpacked')
  rmSync(zip, { force: true })
  const fresh = join(out, 'Lunchbox.app')
  if (!existsSync(fresh) || (await plistVersion(fresh)) !== version) throw new Error('the unpacked app is not the expected version')
  // Downloaded by the app itself it carries no quarantine flag, but a copy from elsewhere might.
  await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', fresh])
  progress(1)
  return fresh
}

// Waits for this process to exit, moves the old bundle aside, moves the new one in, and opens it
// when asked. If the second move fails the old bundle goes back, so a failed update never leaves
// the person without an app.
const SWAP = `#!/bin/sh
pid="$1"; app="$2"; new="$3"; reopen="$4"
case "$app" in /*.app) ;; *) exit 1 ;; esac
case "$new" in /*.app) ;; *) exit 1 ;; esac
i=0
while kill -0 "$pid" 2>/dev/null && [ $i -lt 300 ]; do sleep 0.2; i=$((i + 1)); done
old="$app.previous"
rm -rf "$old"
if mv "$app" "$old"; then
  if mv "$new" "$app"; then rm -rf "$old"; else mv "$old" "$app"; fi
fi
[ "$reopen" = 1 ] && open "$app"
exit 0
`

export function swapOnExit(fresh: string, reopen: boolean, bundle = bundlePath()) {
  const script = join(app.getPath('userData'), 'updates', 'swap.sh')
  writeFileSync(script, SWAP, { mode: 0o700 })
  spawn('/bin/sh', [script, String(process.pid), bundle, fresh, reopen ? '1' : '0'], { detached: true, stdio: 'ignore' }).unref()
}
