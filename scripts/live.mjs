import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const out = join(mkdtempSync(join(tmpdir(), 'lunchbox-live-')), 'live.mjs')
await build({ entryPoints: ['test/live.ts'], outfile: out, bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'warning' })
await import(out)
