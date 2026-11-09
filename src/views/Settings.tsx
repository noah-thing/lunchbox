import { useEffect, useState, type MouseEvent } from 'react'
import { Loader, Mark } from '../ui/bits'
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
  const set = async (patch: Record<string, unknown>) => {
    setBusy(true)
    try { setS(await desk.call('remote:set', patch)); await reload.settings({}) } catch (e) { say(reason(e)) } finally { setBusy(false) }
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
            <button className="btn small" disabled={!token.trim() || busy} onClick={async () => { await set({ token, on: true }); setToken('') }}>{busy ? <Loader size={10} /> : 'Connect'}</button>
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

export function Settings({ theme, setTheme, look, setLook, restart, say }: {
  theme: 'dark' | 'light'; setTheme: (t: 'dark' | 'light', e?: MouseEvent) => void; look: Look; setLook: (l: Look) => void; restart: () => void; say: (t: string) => void
}) {
  const settings = useApp((s) => s.settings)
  const agents = useApp((s) => s.agents)
  const env = useApp((s) => s.env)
  const [secure, setSecure] = useState(true)
  useEffect(() => { desk.call('keys:secure').then((v: boolean | null) => setSecure(v !== false)) }, [])
  const usable = agents.filter((a) => !unavailable(a))
  const crew = settings.defaultCrew

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
            <div className="grow"><b>Look</b><span>Lunchbox floats the work on a sheet. Neyra is flat panes, hairlines and square corners.</span></div>
            <div className="seg">{(['lunchbox', 'neyra'] as const).map((l) => <button key={l} className={l === look ? 'on' : ''} onClick={() => setLook(l)}>{l === 'lunchbox' ? 'Lunchbox' : 'Neyra'}</button>)}</div>
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
            <div className="grow"><b>Checkpoints</b><span>Save the folder before every message so any change can be rewound. Kept outside the project, in its own history.</span></div>
            <Toggle on={settings.snapshots !== false} set={(v) => reload.settings({ snapshots: v })} label="Checkpoints" />
          </div>
          <div className="setting">
            <div className="grow"><b>Who leads</b><span>Best for the job picks by kind of work, ratings and what is left today. Crew order always starts with the first agent.</span></div>
            <div className="seg">{(['best', 'order'] as const).map((r) => <button key={r} className={(settings.route ?? 'best') === r ? 'on' : ''} onClick={() => reload.settings({ route: r })}>{r === 'best' ? 'Best for the job' : 'Crew order'}</button>)}</div>
          </div>
        </div>
      </section>

      <Phone say={say} />

      <section className="group">
        <h2>Data</h2>
        <div className="settings">
          <div className="setting">
            <div className="grow"><b>Stored on this computer</b><span className="mono">{short(env.data) || '—'}</span></div>
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
        <p className="hint mono">Lunchbox {env.version}</p>
      </section>
    </div>
  )
}
