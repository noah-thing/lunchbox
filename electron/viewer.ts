// Pages Expert uses to look at things that are not web pages: an image or logo at the sizes it
// will be used, and a 3D model from three sides. Each is a small local page loaded in the hidden
// window; it writes what it learned to window.__view.

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

// A mark at favicon, toolbar and poster sizes, on light and on dark, the way it will be used.
export function imagePage(file: string) {
  const src = esc(pathToFileURL(file).href)
  const row = (bg: string, fg: string) => `<div class="row" style="background:${bg};color:${fg}">${[16, 32, 64, 128, 512].map((s) => `<figure><img src="${src}" style="width:${s}px;height:${s}px"><figcaption>${s}px</figcaption></figure>`).join('')}</div>`
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:12px -apple-system,Helvetica,Arial,sans-serif}
.row{display:flex;align-items:flex-end;gap:40px;padding:36px 40px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:10px}
img{object-fit:contain;display:block}figcaption{opacity:.55}
</style>${row('#ffffff', '#111')}${row('#151514', '#eee')}
<script>Promise.all([...document.images].map((i) => i.decode().catch(() => null))).then(() => {
  const i = document.images[0]
  window.__view = i.naturalWidth ? { ok: true, width: i.naturalWidth, height: i.naturalHeight } : { ok: false, error: 'the image could not be read' }
})</script>`
}

// A model lit with a key, a fill and a rim light, framed from the front, three quarters and the
// top, with the numbers that matter for the web: triangles, meshes, materials, size.
export function modelPage(file: string) {
  // Copied next to main.cjs by the build (scripts/build.mjs), inside the app archive once packaged.
  const vendor = join(__dirname, 'vendor', 'three')
  const three = pathToFileURL(join(vendor, 'three.module.js')).href
  const gltf = pathToFileURL(join(vendor, 'jsm', 'loaders', 'GLTFLoader.js')).href
  const model = pathToFileURL(file).href
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#1c1c1a}canvas{display:block}</style>
<script type="importmap">{"imports":{"three":${JSON.stringify(three)}}}</script>
<script type="module">
import * as THREE from 'three'
import { GLTFLoader } from ${JSON.stringify(gltf)}
const W = 1440, H = 480
try {
  const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
  r.setPixelRatio(1); r.setSize(W, H)
  r.outputColorSpace = THREE.SRGBColorSpace
  r.toneMapping = THREE.ACESFilmicToneMapping
  r.setScissorTest(true)
  document.body.appendChild(r.domElement)
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a38, 1.1))
  const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(3, 5, 4); scene.add(key)
  const rim = new THREE.DirectionalLight(0xffffff, 1.4); rim.position.set(-4, 3, -5); scene.add(rim)
  const g = await new GLTFLoader().loadAsync(${JSON.stringify(model)})
  scene.add(g.scene)
  const box = new THREE.Box3().setFromObject(g.scene)
  const size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3())
  let tris = 0, meshes = 0
  const mats = new Set()
  g.scene.traverse((o) => {
    if (!o.isMesh) return
    meshes++
    const geo = o.geometry
    tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3
    for (const m of [].concat(o.material)) mats.add(m.uuid)
  })
  const radius = size.length() / 2 || 1
  const views = [[0, 0, 1, 0, 1, 0], [1, 0.55, 1, 0, 1, 0], [0, 1, 0, 0, 0, -1]]
  views.forEach(([x, y, z, ux, uy, uz], i) => {
    const cam = new THREE.PerspectiveCamera(35, W / 3 / H, radius / 100, radius * 100)
    cam.up.set(ux, uy, uz)
    cam.position.copy(mid).add(new THREE.Vector3(x, y, z).normalize().multiplyScalar(radius / Math.tan(THREE.MathUtils.degToRad(17.5)) * 1.12))
    cam.lookAt(mid)
    r.setViewport(i * W / 3, 0, W / 3, H); r.setScissor(i * W / 3, 0, W / 3, H)
    r.setClearColor(0x1c1c1a); r.render(scene, cam)
  })
  window.__view = { ok: true, tris: Math.round(tris), meshes, materials: mats.size, size: [size.x, size.y, size.z], animations: g.animations.length }
} catch (e) {
  window.__view = { ok: false, error: String(e && e.message || e) }
}
</script>`
}

export type View = { ok: boolean; error?: string; width?: number; height?: number; tris?: number; meshes?: number; materials?: number; size?: number[]; animations?: number }

export function describeModel(v: View, bytes: number) {
  const mb = bytes / 1048576
  const dims = (v.size ?? []).map((n) => (n >= 10 ? n.toFixed(0) : n.toFixed(2))).join(' × ')
  const notes: string[] = []
  if ((v.tris ?? 0) > 150000) notes.push('over 150k triangles is heavy for a web page')
  if (mb > 8) notes.push(`${mb.toFixed(1)} MB is a slow download on a phone; compress textures or use Draco or meshopt`)
  const big = Math.max(...(v.size ?? [1]))
  if (big > 100 || big < 0.01) notes.push('the size looks off for metres; check the units and applied scale')
  return `${(v.tris ?? 0).toLocaleString('en')} triangles in ${v.meshes} mesh${v.meshes === 1 ? '' : 'es'}, ${v.materials} material${v.materials === 1 ? '' : 's'}${v.animations ? `, ${v.animations} animation${v.animations > 1 ? 's' : ''}` : ''}; ${mb.toFixed(1)} MB; ${dims} in the file's units (usually metres).${notes.length ? ` Watch: ${notes.join('; ')}.` : ''}`
}
