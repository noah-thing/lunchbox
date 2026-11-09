import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const out = mkdtempSync(join(tmpdir(), 'lunchbox-test-'))
const files = ['test/unit.ts', 'test/engine.ts']
await build({ entryPoints: files, outdir: out, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'warning' })

const policy = spawnSync(process.execPath, ['scripts/test-policy.mjs'], { stdio: 'inherit' })
const unit = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files.map((f) => join(out, f.replace(/^test\//, '').replace(/\.ts$/, '.js')))], { stdio: 'inherit' })
process.exit(policy.status || unit.status || 0)
