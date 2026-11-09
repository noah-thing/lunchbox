import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Only the packaged app gets a strict policy; the dev server needs inline scripts for hot reload.
const csp: Plugin = {
  name: 'csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:" />`),
}

export default defineConfig({
  plugins: [react(), csp],
  base: './',
  build: { outDir: 'out/renderer', emptyOutDir: true },
})
