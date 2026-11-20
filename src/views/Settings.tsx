import { useEffect, useState, type MouseEvent } from 'react'
import { ThemeCards } from '../ui/ThemeCards'
import { ASCII, REACH, THEMES, themeOf, type AsciiId, type Mode, type Reach, type Theme, type ThemeId } from '../lib/themes'
import { draftOf, type Draft } from '../lib/custom'
import { ThemeEditor } from '../ui/ThemeEditor'
import { TuneSheet } from '../ui/TuneSheet'
import type { Tune } from '../lib/tune'
import { Loader, Mark, Sure } from '../ui/bits'
import { IconEdit, IconPalette, IconPlus, IconTrash } from '../ui/icons'
import { Logo } from '../ui/Logo'
import { Maker } from '../ui/Maker'
import { Effort } from '../ui/ModelPicker'
import { ACCESS, desk, reason, reload, short, unavailable, useApp, type RemoteStatus } from '../lib/desk'
import type { Look } from '../App'
import type { Limits } from '../../shared/types'
import { Toggle } from './Flows'

// Lunchbox from a phone through a Telegram bot: make one with @BotFather, paste its token, then
// send the bot the code shown here. Only that chat is listened to.
function Phone({ say }: { say: (t: string) => void }) {
  const [s, setS] = useState<RemoteStatus | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const access = useApp((x) => x.settings.remote?.access ?? 'workspace')
  useEffect(() => {
    desk.call('remote').then(setS)
    return desk.on('remote', setS)
  }, [])
  // True when the change took. A bad token comes back as a status with an error, not a throw.
  const set = async (patch: Record<string, unknown>) => {
    setBusy(true)
    try {
      const next: RemoteStatus = await desk.call('remote:set', patch)
      setS(next)
      await reload.settings({})
      if (next?.error) say(next.error)
      return !next?.error
    } catch (e) {
      say(reason(e))
      return false
    } finally { setBusy(false) }
  }
  if (!s) return null
  return (
    <section className="group">
      <h2>Phone<span className="quiet">talk to your rooms from Telegram</span></h2>
      <div className="settings">
        <div className="setting">
          <div className="grow"><b>Telegram bot</b><span>{s.token ? s.bot ? `Connected as @${s.bot}` : s.error ?? 'Token saved' : 'Make a bot with @BotFather in Telegram and paste its token.'}</span></div>
          {s.token && <Toggle on={s.on} set={(on) => set({ on })} label="Phone remote" />}
        </div>
        {(!s.token || !s.on) && (
          <div className="setting">
            <input className="grow input mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={s.token ? 'Saved. Paste to replace' : '123456789:AA…'} />
            <button className="btn small" disabled={!token.trim() || busy} onClick={async () => { if (await set({ token, on: true })) setToken('') }}>{busy ? <Loader size={10} /> : 'Connect'}</button>
          </div>
        )}
        {s.on && s.bot && !s.paired && (
          <div className="setting pair">
            <div className="grow"><b>Pair your phone</b><span>Open @{s.bot} in Telegram and send this code.</span></div>
            <code className="code">{s.code}</code>
          </div>
        )}
        {s.paired && (
          <>
            <div className="setting">
              <div className="grow"><b>Paired with {s.name ?? 'your chat'}</b><span>Write to continue your latest room, /new to start one, /rooms to switch, /stop to stop. Decisions arrive as buttons.</span></div>
              <button className="btn small quiet" onClick={async () => setS(await desk.call('remote:unpair'))}>Unpair</button>
            </div>
            <div className="setting">
              <div className="grow"><b>Mode for messages from the phone</b><span>{ACCESS.find((a) => a.id === access)?.line}</span></div>
              <div className="seg">{ACCESS.filter((a) => a.id !== 'full').map((a) => <button key={a.id} className={access === a.id ? 'on' : ''} onClick={() => set({ access: a.id })}>{a.name}</button>)}</div>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

// The agents that take an effort level on the command line. Which levels depends on the model.
const EFFORT = ['claude', 'codex', 'antigravity']

export function Settings({ edit, theme, setTheme, mode, setMode, custom, tune, setTune, keepTheme, dropTheme, themeWithAgent, ascii, setAscii, reach, setReach, look, setLook, restart, say }: {
  edit?: string; theme: ThemeId; setTheme: (t: ThemeId, e?: MouseEvent) => void; mode: Mode; setMode: (m: Mode, e?: MouseEvent) => void
  custom: Theme[]; tune: Tune; setTune: (t: Tune) => void; keepTheme: (t: Theme) => void; dropTheme: (id: string) => void; themeWithAgent: () => void; ascii: AsciiId; reach: Reach; setReach: (r: Reach, e?: MouseEvent) => void; setAscii: (a: AsciiId) => void; look: Look; setLook: (l: Look) => void; restart: () => void; say: (t: string) => void
}) {
  const settings = useApp((s) => s.settings)
  const agents = useApp((s) => s.agents)
  const env = useApp((s) => s.env)
  const [secure, setSecure] = useState(true)
  useEffect(() => { desk.call('keys:secure').then((v: boolean | null) => setSecure(v !== false)) }, [])
  // In the order a new room fills its crew, so the Main shown here is the one a new room gets.
  const usable = agents.filter((a) => !unavailable(a)).sort((a, b) => Number(b.tools) - Number(a.tools))
  const crew = settings.defaultCrew
  const saving = settings.saving ?? {}
  const [editing, setEditing] = useState<{ draft: Draft; id?: string } | null>(null)
  const [tuning, setTuning] = useState(false)
  // Opened from a theme an agent offered: that theme goes straight into the editor.
  useEffect(() => {
    const t = edit && custom.find((x) => x.id === edit)
    if (t) setEditing({ draft: draftOf(t), id: t.id })
  }, [edit])
  const tunedCount = Object.keys(tune.dark).length + Object.keys(tune.light).length
  const themeName = themeOf(theme, custom).name

  return (
    <div className="page">
      <header className="pagehead"><h1>Settings</h1></header>

      <section className="group">
        <h2>Appearance</h2>
        <div className="settings">
          <div className="setting">
            <div className="grow"><b>Mode</b><span>Every theme has a night and a day.</span></div>
            <div className="seg">{(['dark', 'light'] as const).map((m) => <button key={m} className={m === mode ? 'on' : ''} onClick={(e) => setMode(m, e)}>{m === 'dark' ? 'Night' : 'Day'}</button>)}</div>
          </div>
          <div className="setting col">
            <div className="grow"><b className="withreset">ASCII colour{ascii !== 'theme' && <button className="linkbtn" onClick={() => setAscii('theme')}>Reset to {themeName}</button>}</b><span>The characters on the home screen and in the room's field, and the dots behind a search or a drawing. Follow the theme, or give them a palette of their own. Each theme remembers its own choice.</span></div>
            <div className="asciis" role="radiogroup" aria-label="ASCII colour">
              {ASCII.map((a) => {
                const ramp = a.id === 'theme' ? (theme === 'lunchbox' ? null : themeOf(theme, custom)[mode].glyphs) : a.id === 'ink' ? null : a[mode]!
                return (
                  <button key={a.id} role="radio" aria-checked={ascii === a.id} className={`asciichip${ascii === a.id ? ' on' : ''}`} onClick={() => setAscii(a.id)}>
                    <code aria-hidden="true">{'01|*/~'.split('').map((ch, i) => <span key={i} style={ramp ? { color: ramp[[1, 2, 3, 2, 3, 1][i]] } : undefined}>{ch}</span>)}</code>
                    {a.name}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="setting col">
            <div className="grow"><b>Theme</b><span>Lunchbox is ink on black or paper. The others tint every surface and give what is selected, what acts and the ASCII colours of their own.</span></div>
            <ThemeCards themes={THEMES} value={theme} mode={mode} pick={setTheme} />
            {custom.length > 0 && (
              <>
                <span className="themesub">Yours</span>
                <ThemeCards themes={custom} value={theme} mode={mode} pick={setTheme}
                  tools={(t) => (
                    <span className="themetools">
                      <button className="iconbtn" title="Edit" onClick={() => setEditing({ draft: draftOf(t), id: t.id })}><IconEdit /></button>
                      <Sure className="iconbtn" act={() => dropTheme(t.id)}>{(sure) => <span title={sure ? 'Click again to delete' : 'Delete'}>{sure ? '?' : <IconTrash />}</span>}</Sure>
                    </span>
                  )} />
              </>
            )}
            <div className="themefoot">
              <span className="themenow"><b>{themeOf(theme, custom).name}</b>{themeOf(theme, custom).note}</span>
              <button className="btn small quiet" onClick={() => setEditing({ draft: draftOf(themeOf(theme === 'lunchbox' ? 'lagoon' : theme, custom), 'My theme') })}><IconPlus />New theme</button>
              <button className="btn small quiet" onClick={themeWithAgent}><IconPalette />Make one with an agent</button>
            </div>
            {editing && <ThemeEditor start={editing.draft} id={editing.id} mode={mode} setMode={(m) => setMode(m)} close={() => setEditing(null)} save={(t) => { keepTheme(t); setEditing(null) }} />}
          </div>
          <div className="setting">
            <div className="grow"><b>Theme colour</b><span>{theme === 'lunchbox' ? 'How far a theme carries its colour. Lunchbox is ink alone, so this shows on the other themes.' : `How far ${themeName} carries its colour. ${REACH.find((r) => r.id === reach)!.line}`}</span></div>
            <div className="seg" role="radiogroup" aria-label="Theme colour">{REACH.map((r) => <button key={r.id} role="radio" aria-checked={r.id === reach} className={r.id === reach ? 'on' : ''} onClick={(e) => setReach(r.id, e)} title={r.line}>{r.name}</button>)}</div>
          </div>
          <div className="setting">
            <div className="grow"><b>Fine tune</b><span>{tunedCount ? `${tunedCount} ${tunedCount === 1 ? 'colour' : 'colours'} changed by hand on ${themeName}. Other themes keep their own.` : `Change single colours of ${themeName}, like the text or the sheet. Other themes keep their own.`}</span></div>
            {tunedCount > 0 && <button className="btn small quiet" onClick={() => setTune({ dark: {}, light: {} })}>Reset to {themeName}</button>}
            <button className="btn small quiet" onClick={() => setTuning(true)}>Customise</button>
            {tuning && <TuneSheet tune={tune} setTune={setTune} mode={mode} setMode={(m) => setMode(m)} close={() => setTuning(false)} theme={theme} name={themeName} />}
          </div>
          <div className="setting">
            <div className="grow"><b>Look</b><span>Lunchbox floats the work on a soft sheet. Square is flat panes, hairlines and square corners.</span></div>
            <div className="seg">{(['lunchbox', 'neyra'] as const).map((l) => <button key={l} className={l === look ? 'on' : ''} onClick={() => setLook(l)}>{l === 'lunchbox' ? 'Lunchbox' : 'Square'}</button>)}</div>
          </div>
        </div>
      </section>

      <section className="group">
        <h2>Rooms</h2>
        <div className="settings">
          <div className="setting col">
            <div className="grow"><b>Default crew</b><span>Who joins a new room. Without a choice, the first three that are ready.</span></div>
            <div className="chips">
              {usable.map((a) => {
                const on = crew.includes(a.id)
                return (
                  <button key={a.id} className={`chip${on ? ' on' : ''}`} onClick={() => reload.settings({ defaultCrew: on ? crew.filter((c) => c !== a.id) : [...crew, a.id] })}>
                    <Mark seed={a.mark} size={12} />{a.short}
                  </button>
                )
              })}
              {!usable.length && <span className="quiet">No agent is ready yet.</span>}
            </div>
          </div>
          <div className="setting">
            <div className="grow"><b>Notifications</b><span>When a room needs you or finishes while Lunchbox is in the background.</span></div>
            <Toggle on={settings.notify} set={(v) => reload.settings({ notify: v })} label="Notifications" />
          </div>
          <div className="setting">
            <div className="grow"><b>Plan limits</b><span>Read how much of each plan is left from the login its own tool already has. The login only ever goes to the company that issued it.</span></div>
            <Toggle on={settings.planLimits !== false} set={(v) => reload.settings({ planLimits: v })} label="Plan limits" />
          </div>
          <div className="setting">
            <div className="grow"><b>Install updates automatically</b><span>New versions download in the background and install when you restart. Off, Lunchbox still tells you when one is out.</span></div>
            <Toggle on={settings.autoUpdate !== false} set={(v) => reload.settings({ autoUpdate: v })} label="Install updates automatically" />
          </div>
          <div className="setting">
            <div className="grow"><b>Anonymous count</b><span>Once a day, a random ID made on this computer, the Lunchbox version and your system. No IP address, nothing about your rooms, files, prompts or keys. It tells us how many people use Lunchbox and which versions.</span></div>
            <Toggle on={settings.count !== false} set={(v) => reload.settings({ count: v })} label="Anonymous count" />
          </div>
          <div className="setting">
            <div className="grow"><b>Checkpoints</b><span>Save the folder before every message so any change can be rewound. Kept outside the project, in its own history.</span></div>
            <Toggle on={settings.snapshots !== false} set={(v) => reload.settings({ snapshots: v })} label="Checkpoints" />
          </div>
          <div className="setting">
            <div className="grow"><b>Unload local models when they finish</b><span>Ollama frees the model's memory as soon as it answers. The next message takes a few seconds longer while the model loads again.</span></div>
            <Toggle on={settings.unload === true} set={(v) => reload.settings({ unload: v })} label="Unload local models when they finish" />
          </div>
          <div className="setting col">
            <div className="grow"><b>Main agent</b><span>Takes your messages in a new room and brings the others in when they are better placed. The rest stay on call and do not read along. Change it per room in the agent menu.</span></div>
            <div className="chips">
              {usable.map((a) => {
                const main = (crew.find((id) => usable.some((u) => u.id === id)) ?? usable[0]?.id) === a.id
                return (
                  <button key={a.id} className={`chip${main ? ' on' : ''}`} onClick={() => reload.settings({ defaultCrew: [a.id, ...(crew.length ? crew : usable.slice(0, 3).map((u) => u.id)).filter((c) => c !== a.id)] })}>
                    <Mark seed={a.mark} size={12} />{a.short}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="group">
        <h2>Saving<span className="quiet">what each one saved is on the Savings page</span></h2>
        <div className="settings">
          <div className="setting">
            <div className="grow"><b>Shorten long command output</b><span>A test run, a build or an install can print thousands of lines, and an agent reads them again on every step after. Claude Code is shown the start, the end and the lines that look like problems. The whole output stays in a file it can open.</span></div>
            <Toggle on={saving.trim !== false} set={(v) => reload.settings({ saving: { ...saving, trim: v } })} label="Shorten long command output" />
          </div>
          <div className="setting">
            <div className="grow"><b>Cache lifetime</b><span>A cache runs out some time after a room's last turn, and the next message then pays to read the whole room again. Lunchbox reads the room once more just before that, at the cached price, and stops after a few times if you do not come back. Flows and crewmates called for one job store their cache for five minutes, which costs less than the hour.</span></div>
            <Toggle on={saving.warm !== false} set={(v) => reload.settings({ saving: { ...saving, warm: v } })} label="Cache lifetime" />
          </div>
          <div className="setting">
            <div className="grow"><b>Only the tools connected in Lunchbox</b><span>Start Claude Code in rooms without the MCP servers you set up outside Lunchbox. Every step reads less. Leave it off if your rooms use those servers.</span></div>
            <Toggle on={saving.lean === true} set={(v) => reload.settings({ saving: { ...saving, lean: v } })} label="Only the tools connected in Lunchbox" />
          </div>
          {EFFORT.filter((id) => agents.some((a) => a.id === id && a.found) && (id !== 'antigravity' || settings.models[id])).map((id) => {
            const a = agents.find((x) => x.id === id)!
            return (
              <div className="setting" key={id}>
                <div className="grow"><b>{a.short} effort</b><span>How hard {a.short} thinks before it acts, for the model it uses now. Thinking is billed as output, the most expensive kind of token. Default leaves {a.name} as you set it up.</span></div>
                <Effort a={a} model={settings.models[id] ?? ''} plain />
              </div>
            )
          })}
        </div>
      </section>

      <LimitSettings />

      <Phone say={say} />

      <section className="group">
        <h2>Data</h2>
        <div className="settings">
          <div className="setting">
            <div className="grow"><b>Stored on this computer</b><span className="mono">{short(env.data) || 'not set'}</span></div>
            <button className="btn small quiet" onClick={() => desk.call('reveal', env.data)}>Open</button>
          </div>
          {!secure && (
            <div className="setting">
              <div className="grow"><b>No system keychain</b><span>API keys are stored encoded, not encrypted. Install a keyring such as GNOME Keyring or KWallet to seal them.</span></div>
            </div>
          )}
          <div className="setting">
            <div className="grow"><b>Welcome screens</b><span>See the first run again.</span></div>
            <button className="btn small quiet" onClick={restart}>Show again</button>
          </div>
        </div>
        <p className="about"><Logo size={16} /><b>Lunchbox</b><span>{env.version}</span></p>
        <Maker />
      </section>
    </div>
  )
}

// Lunchbox lets agents work until they are done. Each limit here is off until it is switched on,
// and then stops them at the number set.
const LIMITS: { key: keyof Limits; name: string; line: string; unit: string; start: number; min: number; max: number }[] = [
  { key: 'toolCalls', name: 'Tool calls per turn', line: 'Stops an agent on an API key or a local model after this many tool calls in one turn.', unit: 'calls', start: 60, min: 5, max: 1000 },
  { key: 'handoffs', name: 'Handoffs per message', line: 'Pauses the room after agents have handed work to each other this many times for one message.', unit: 'handoffs', start: 24, min: 2, max: 200 },
  { key: 'failures', name: 'Same failing command', line: 'Pauses an agent that runs the same command this many times in a row and fails each time.', unit: 'times', start: 3, min: 2, max: 50 },
  { key: 'minutes', name: 'Time per turn', line: 'Stops a command line agent that is still working after this long.', unit: 'minutes', start: 60, min: 5, max: 600 },
]

function LimitSettings() {
  const limits = useApp((s) => s.settings.limits) ?? {}
  const set = (key: string, v: number | undefined) => reload.settings({ limits: { ...limits, [key]: v } })
  return (
    <section className="group">
      <h2>Limits<span className="quiet">off unless you turn one on; agents work until they are done or you stop them</span></h2>
      <div className="settings">
        {LIMITS.map((l) => {
          const now = limits[l.key]
          return (
            <div className="setting" key={l.key}>
              <div className="grow"><b>{l.name}</b><span>{l.line}</span></div>
              {now ? (
                <label className="limitnum">
                  <input type="number" min={l.min} max={l.max} defaultValue={now} key={now} aria-label={`${l.name}, ${l.unit}`}
                    onBlur={(e) => { const v = Math.round(Number(e.target.value)); set(l.key, Number.isFinite(v) ? Math.min(l.max, Math.max(l.min, v)) : now) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                  <span>{l.unit}</span>
                </label>
              ) : null}
              <Toggle on={!!now} set={(on) => set(l.key, on ? l.start : undefined)} label={l.name} />
            </div>
          )
        })}
      </div>
    </section>
  )
}

