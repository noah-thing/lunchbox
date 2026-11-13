import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const out = join(mkdtempSync(join(tmpdir(), 'lunchbox-bench-')), 'bench.mjs')
await build({ entryPoints: ['test/bench/run.ts'], outfile: out, bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'warning' })
await import(out)
