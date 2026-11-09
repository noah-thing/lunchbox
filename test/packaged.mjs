import { _electron as electron } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Starts the packaged macOS build and checks it reaches the first screen without errors.
const root = new URL('..', import.meta.url).pathname
const app = await electron.launch({
  executablePath: join(root, 'release/mac-arm64/Lunchbox.app/Contents/MacOS/Lunchbox'),
  args: [`--user-data-dir=${mkdtempSync(join(tmpdir(), 'lunchbox-packaged-'))}`],
})
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.waitForSelector('.onboard', { timeout: 15000 })
await page.waitForTimeout(2500)
await page.screenshot({ path: join(root, 'test/shots/packaged.png') })
console.log('packaged app ok, errors:', errors.length ? errors.join('\n') : 'none')
await app.close()
