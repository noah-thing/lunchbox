import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// Raw footage for the launch video: the renderer's own frames, each with its timestamp, plus a
// timeline of where and when each moment happens on screen. The edit zooms to those moments.
// node test/hero-capture.mjs <out dir>
const root = new URL('..', import.meta.url).pathname
const dir = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'lunchbox-capture-'))
const frames = join(dir, 'frames')
mkdirSync(frames, { recursive: true })
const work = join(homedir(), 'acme-site')
if (existsSync(work)) throw new Error(`${work} already exists; move it before recording`)
mkdirSync(join(work, 'src'), { recursive: true })
writeFileSync(join(work, 'index.html'), '<h1>Acme</h1>\n')
const bin = mkdtempSync(join(tmpdir(), 'lunchbox-bin-'))
chmodSync(root + 'test/fake-agent.mjs', 0o755)
for (const name of ['claude', 'codex', 'grok']) symlinkSync(root + 'test/fake-agent.mjs', join(bin, name))

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'lunchbox-hero-'))}`], cwd: root,
  env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_WORKSPACE: work, LUNCHBOX_PATH: `${bin}:${process.env.PATH}`, FAKE_DELAY: '12', FAKE_SCRIPT: 'showcase', SHOWCASE_PACE: 'real', SHOWCASE_HOLD: '5200' },
  timeout: 30000,
})
const timeline = { size: { width: 1440, height: 900 }, frames: [], marks: [] }
try {
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await page.waitForSelector('.onboard', { timeout: 30000 })
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(i ? 900 : 2600) }
  await page.click('.sbitem >> text=Settings')
  await page.click('.seg button:has-text("Crew order")')
  await page.click('.sbitem >> text=New room')
  await page.waitForSelector('.newroom')
  await page.waitForTimeout(800)

  const cdp = await page.context().newCDPSession(page)
  let n = 0
  const t0 = Date.now()
  cdp.on('Page.screencastFrame', async (f) => {
    const name = `${String(n++).padStart(5, '0')}.jpg`
    writeFileSync(join(frames, name), Buffer.from(f.data, 'base64'))
    timeline.frames.push({ name, t: (Date.now() - t0) / 1000 })
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
  })
  // CAPTURE_W=1440 CAPTURE_Q=70 for a quick look that fits on a small disk.
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: Number(process.env.CAPTURE_Q ?? 92), maxWidth: Number(process.env.CAPTURE_W ?? 2880), maxHeight: 1800, everyNthFrame: 1 })
  // Where and when each moment is: the edit zooms to these boxes, in window coordinates.
  const mark = async (name, selector, test) => {
    if (test) await page.waitForFunction(test, null, { timeout: 90000 })
    else await page.waitForSelector(selector, { timeout: 90000 })
    const box = await page.evaluate((s) => { const el = [...document.querySelectorAll(s)].pop(); const r = el?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null }, selector)
    timeline.marks.push({ name, t: (Date.now() - t0) / 1000, box })
  }

  await page.waitForTimeout(1200)
  const box = await page.evaluate(() => { const r = document.querySelector('.composer textarea').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
  timeline.marks.push({ name: 'type', t: (Date.now() - t0) / 1000, box })
  await page.click('.composer textarea')
  await page.keyboard.type('Our hackathon Build Night is in three weeks. Find out what people on X want from hackathons, write the announcement, design the banner and put up the event page.', { delay: 32 })
  await page.waitForTimeout(600)
  timeline.marks.push({ name: 'send', t: (Date.now() - t0) / 1000, box })
  await page.keyboard.press('Enter')
  await mark('plan', '.transcript .ev', () => document.body.innerText.includes('Grok checks X'))
  await mark('search', '.xsearch.live', () => !!document.querySelector('.xsearch.live'))
  await mark('grok', '.transcript .ev.hands', () => document.body.innerText.includes('Three things come up most'))
  await mark('drawing', '.developing', () => !!document.querySelector('.developing'))
  await mark('banner', '.picture', () => !!document.querySelector('.picture img'))
  await mark('post', '.transcript .ev', () => document.body.innerText.includes('Banner is in'))
  await mark('testing', '.workline', () => [...document.querySelectorAll('.workline code')].some((c) => c.textContent?.includes('npm test')))
  await mark('proved', '.transcript .ev', () => document.body.innerText.includes('Proved'))
  await page.waitForTimeout(3000)
  timeline.marks.push({ name: 'end', t: (Date.now() - t0) / 1000, box: null })
  await cdp.send('Page.stopScreencast')
} catch (e) {
  console.error(e)
  process.exitCode = 1
} finally {
  writeFileSync(join(dir, 'timeline.json'), JSON.stringify(timeline, null, 1))
  await app.close()
  await new Promise((r) => setTimeout(r, 6000))
  rmSync(work, { recursive: true, force: true })
  console.log('captured', timeline.frames.length, 'frames into', dir)
}
