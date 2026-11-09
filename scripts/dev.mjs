import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'vite'
import { electron } from './build.mjs'

const server = await createServer({ configFile: 'vite.config.ts', server: { port: 4410 } })
await server.listen()
await electron()

const bin = createRequire(import.meta.url)('electron')
const app = spawn(bin, ['.'], { stdio: 'inherit', env: { ...process.env, VITE_URL: 'http://localhost:4410/' + (process.env.LB_QUERY ?? '') } })
app.on('close', () => { server.close(); process.exit(0) })
