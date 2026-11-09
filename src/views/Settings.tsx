import { useEffect, useState, type MouseEvent } from 'react'
import { Mark } from '../ui/bits'
import { agentOf, desk, reload, short, unavailable, useApp } from '../lib/desk'
import type { Look } from '../App'

export function Settings({ theme, setTheme, look, setLook, restart, say }: {
  theme: 'dark' | 'light'; setTheme: (t: 'dark' | 'light', e?: MouseEvent) => void; look: Look; setLook: (l: Look) => void; restart: () => void; say: (t: string) => void
}) {
  const settings = useApp((s) => s.settings)
  const agents = useApp((s) => s.agents)
  const packs = useApp((s) => s.packs)
  const skills = useApp((s) => s.skills)
  const env = useApp((s) => s.env)
  const [secure, setSecure] = useState(true)
  useEffect(() => { desk.call('keys:secure').then((v: boolean | null) => setSecure(v !== false)) }, [])
  const usable = agents.filter((a) => !unavailable(a))
  const crew = settings.defaultCrew
  const importPack = async () => {
    try {
      const p = await desk.call('packs:import')
      if (p) { await reload.packs(); say(`Added the ${p.name} pack`) }
    } catch (e) {
      say(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'That pack could not be read')
    }
  }

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
            <div className="seg">{[true, false].map((v) => <button key={String(v)} className={settings.notify === v ? 'on' : ''} onClick={() => reload.settings({ notify: v })}>{v ? 'On' : 'Off'}</button>)}</div>
          </div>
        </div>
      </section>

      <section className="group">
        <h2>Packs<button className="btn small quiet" onClick={importPack}>Import pack</button></h2>
        <div className="settings">
          {packs.map((p) => (
            <div key={p.id} className="setting">
              <div className="grow"><b>{p.name}</b><span>{p.line || p.brief.slice(0, 120)}</span></div>
              <small className="mono quiet">{p.source === 'user' ? 'imported' : 'built in'}</small>
            </div>
          ))}
        </div>
        <p className="hint">A pack is a JSON file with an id, a name, a brief for the crew, ideas and optional checks. Share them like any other file.</p>
      </section>

      {skills.length > 0 && (
        <section className="group">
          <h2>Skills</h2>
          <div className="settings">
            {skills.map((s) => (
              <div key={s.id} className="setting">
                <div className="grow"><b>{s.name}</b><span>{s.steps.length} steps · {s.crew.map((c) => agentOf(c, agents).short).join(', ')}</span></div>
                <button className="btn small quiet" onClick={async () => { await desk.call('skills:remove', s.id); say('Skill removed') }}>Remove</button>
              </div>
            ))}
          </div>
        </section>
      )}

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
