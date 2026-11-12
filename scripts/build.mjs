import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build as esbuild } from 'esbuild'
import { build as vite } from 'vite'

const node = { bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'warning' }

export async function electron() {
  await esbuild({ ...node, entryPoints: ['electron/main.ts'], outfile: 'out/main.cjs' })
  await esbuild({ ...node, entryPoints: ['electron/preload.ts'], outfile: 'out/preload.cjs' })
  vendor()
}

// The three.js files expert_view loads into its page, copied next to the app. Packaging leaves out
// every examples folder inside node_modules, and the model loader lives in one. The loader's own
// import of ../utils/ keeps working because the layout below keeps that step.
function vendor() {
  const files = {
    'three.module.js': 'node_modules/three/build/three.module.js',
    'LICENSE': 'node_modules/three/LICENSE',
    'jsm/loaders/GLTFLoader.js': 'node_modules/three/examples/jsm/loaders/GLTFLoader.js',
    'jsm/utils/BufferGeometryUtils.js': 'node_modules/three/examples/jsm/utils/BufferGeometryUtils.js',
  }
  for (const [to, from] of Object.entries(files)) {
    const out = join('out/vendor/three', to)
    mkdirSync(dirname(out), { recursive: true })
    copyFileSync(from, out)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await electron()
  await vite({ configFile: 'vite.config.ts', logLevel: 'warn' })
}
