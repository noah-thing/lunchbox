import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// The README images: one room where the crew works together and the claim is proved, played by
// the stand-in agents, in dark and light. The folder sits in the home folder so the header
// reads ~/acme-site, and is removed afterwards. node test/hero.mjs
const root = new URL('..', import.meta.url).pathname
const out = root + '.github/assets/'
const work = join(homedir(), 'acme-site')
if (existsSync(work)) throw new Error(`${work} already exists; move it before taking the README shots`)
mkdirSync(join(work, 'src'), { recursive: true })
writeFileSync(join(work, 'index.html'), '<h1>Acme</h1>\n')
const bin = mkdtempSync(join(tmpdir(), 'lunchbox-bin-'))
chmodSync(root + 'test/fake-agent.mjs', 0o755)
for (const name of ['claude', 'codex', 'grok']) symlinkSync(root + 'test/fake-agent.mjs', join(bin, name))

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'lunchbox-hero-'))}`], cwd: root,
  env: { ...process.env, LB_FOLDER: 'shared', LB_PLAN_LIMITS: 'off', LB_WORKSPACE: work, LUNCHBOX_PATH: `${bin}:${process.execPath.replace(/\/[^/]+$/, '')}:/usr/bin:/bin`, LUNCHBOX_PATH_ONLY: '1', FAKE_DELAY: '25', FAKE_SCRIPT: 'showcase', SHOWCASE_HOLD: '25000', SHOWCASE_PACE: process.env.HERO_AT ? 'real' : '' },
  timeout: 30000,
})
try {
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000))
  await page.waitForSelector('.onboard')
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(i ? 900 : 2600) }
  await page.click('.sbitem >> text=Settings')
  await page.click('.seg button:has-text("Crew order")')
  await page.click('.sbitem >> text=New room')
  await page.waitForSelector('.newroom')
  await page.click('.composer textarea')
  await page.keyboard.type('Our hackathon Build Night is in three weeks. Find out what people on X want from hackathons, write the announcement, design the banner and put up the event page.')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.room')
  // HERO_AT stops at one live moment and saves a still of it, for checking those states by eye.
  const AT = { search: '.xsearch.live', sources: '.xsearch.done', developing: '.developing', testing: '.workline code' }[process.env.HERO_AT ?? '']
  if (AT) {
    await page.waitForSelector(AT, { timeout: 60000 })
    await page.waitForTimeout(1400)
    await page.evaluate(() => { const t = document.querySelector('.transcript'); if (t) t.scrollTop = t.scrollHeight })
    await page.waitForTimeout(400)
    await page.screenshot({ path: root + `test/shots/at-${process.env.HERO_AT}.png` })
    await app.close()
    // A stand-in agent can still be finishing a write; let it, then clear the folder.
    await new Promise((r) => setTimeout(r, 6000))
    rmSync(work, { recursive: true, force: true })
    process.exit(0)
  }
  // Mid-flight: Grok has answered, Codex's header is in the room, and Codex is running the tests.
  await page.waitForFunction(() => !!document.querySelector('.room img') && document.body.innerText.includes('npm test'), null, { timeout: 60000 })
    .catch(async (e) => { await page.screenshot({ path: out + 'failed.png' }); throw e })
  await page.waitForTimeout(1200)
  // Frame the room from Grok's answer down: Grok, Codex's banner and Claude's announcement in the
  // chat, with Codex's live test run in the header and the crew panel.
  const bottom = async () => {
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        const t = document.querySelector('.transcript')
        const grok = [...document.querySelectorAll('.transcript .ev')].find((e) => e.textContent?.includes('answered'))
        // Scroll the way a person does, so the room stops following new output.
        t?.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }))
        if (t && grok) t.scrollTop += grok.getBoundingClientRect().top - t.getBoundingClientRect().top - 20
      })
      await page.waitForTimeout(250)
    }
  }
  await bottom()
  await page.waitForTimeout(400)
  await page.screenshot({ path: out + 'room-dark.png' })
  await page.click('.sbitem >> text=Settings')
  await page.click('.seg button:has-text("Light")')
  await page.click('.sbroom >> nth=0')
  await page.waitForTimeout(1500)
  await bottom()
  await page.waitForTimeout(400)
  await page.screenshot({ path: out + 'room-light.png' })
  console.log('saved')
} finally {
  await app.close()
  rmSync(work, { recursive: true, force: true })
}
