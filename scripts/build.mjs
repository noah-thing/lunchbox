import { pathToFileURL } from 'node:url'
import { build as esbuild } from 'esbuild'
import { build as vite } from 'vite'

const node = { bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'warning' }

export async function electron() {
  await esbuild({ ...node, entryPoints: ['electron/main.ts'], outfile: 'out/main.cjs' })
  await esbuild({ ...node, entryPoints: ['electron/preload.ts'], outfile: 'out/preload.cjs' })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await electron()
  await vite({ configFile: 'vite.config.ts', logLevel: 'warn' })
}
