import { useEffect, useState, type MouseEvent } from 'react'
import { Loader, Mark } from '../ui/bits'
import { Logo } from '../ui/Logo'
import { Maker } from '../ui/Maker'
import { ACCESS, desk, reason, reload, short, unavailable, useApp, type RemoteStatus } from '../lib/desk'
import type { Look } from '../App'
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

// The agents that take an effort level on the command line, and the levels both understand.
const EFFORT = ['claude', 'codex']
const LEVELS = [['', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]

export function Settings({ theme, setTheme, look, setLook, restart, say }: {
  theme: 'dark' | 'light'; setTheme: (t: 'dark' | 'light', e?: MouseEvent) => void; look: Look; setLook: (l: Look) => void; restart: () => void; say: (t: string) => void
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

  return (
    <div className="page">
      <header className="pagehead"><h1>Settings</h1></header>

      <section className="group">
        <h2>Appearance</h2>
        <div className="settings">
          <div className="setting">
            <div className="grow"><b>Theme</b><span>Dark is ink on black. Light is ink on paper.</span></div>
            <div className="seg">{(['dark', 'light'] as const).map((t) => <button key={t} className={t === theme ? 'on' : ''} onClick={(e) => setTheme(t, e)}>{t === 'dark' ? 'Dark' : 'Light'}</button>)}</div>
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
          {EFFORT.filter((id) => agents.some((a) => a.id === id && a.found)).map((id) => {
            const a = agents.find((x) => x.id === id)!
            const now = settings.effort?.[id] ?? ''
            return (
              <div className="setting" key={id}>
                <div className="grow"><b>{a.short} effort</b><span>How hard {a.short} thinks before it acts. Thinking is billed as output, the most expensive kind of token. Default leaves {a.name} as you set it up.</span></div>
                <div className="seg">{LEVELS.map(([value, name]) => <button key={name} className={now === value ? 'on' : ''} onClick={() => reload.settings({ effort: { ...settings.effort, [id]: value } })}>{name}</button>)}</div>
              </div>
            )
          })}
        </div>
      </section>

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
