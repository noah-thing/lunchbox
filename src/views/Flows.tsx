import { useState, type CSSProperties } from 'react'
import { describe, DAYS, EVERY, TEMPLATES, type Template } from '../../shared/flow'
import type { Access, Every, Flow, FlowStep } from '../../shared/types'
import { Loader, Mark } from '../ui/bits'
import { IconClose, IconFolder, IconPlay, IconPlus } from '../ui/icons'
import { ACCESS, agentOf, ago, desk, reason, short, unavailable, upcoming, useApp } from '../lib/desk'
import type { View } from '../App'

type Draft = { id?: string; name: string; steps: FlowStep[]; crew: string[]; workspace: string; pack?: string; access: Access; every?: Every; at: string; day: number; on: boolean }

export function Flows({ edit, template, go, say, workspace }: { edit?: string; template?: string; go: (v: View) => void; say: (t: string) => void; workspace: string }) {
  const flows = useApp((s) => s.flows)
  const running = useApp((s) => s.running)
  const agents = useApp((s) => s.agents)
  const editing = edit === 'new' || template ? 'new' : edit ? flows.find((f) => f.id === edit) : undefined

  if (editing) {
    const t = TEMPLATES.find((x) => x.id === template)
    const usable = agents.filter((a) => !unavailable(a)).map((a) => a.id)
    const draft: Draft = editing === 'new'
      ? {
          name: t?.name ?? '', steps: t?.steps ?? [{ text: '' }], pack: t?.pack, access: 'workspace', every: t?.every, at: t?.at ?? '09:00', day: t?.day ?? 1, on: true, workspace,
          crew: (t?.crew.filter((c) => usable.includes(c)).length ? t.crew.filter((c) => usable.includes(c)) : usable.slice(0, 2)),
        }
      : { ...editing, at: editing.at ?? '09:00', day: editing.day ?? 1 }
    return <Editor initial={draft} go={go} say={say} />
  }

  const run = async (f: Flow) => {
    try {
      const room = await desk.call('flows:run', f.id)
      say(`${f.name} started`)
      go({ name: 'room', id: room })
    } catch (e) { say(reason(e)) }
  }

  return (
    <div className="page">
      <div className="pagebody wide">
        <header className="pagehead rise row">
          <div className="grow">
            <h1>Flows</h1>
            <p>Work that runs without you: a few steps, the agents that do them, and when. Each run gets a room of its own.</p>
          </div>
          <button className="btn" onClick={() => go({ name: 'flows', edit: 'new' })}><IconPlus />New flow</button>
        </header>

        {running.map((r) => {
          const f = flows.find((x) => x.id === r.flow)
          return (
            <button key={r.room} className="runningcard rise" onClick={() => go({ name: 'room', id: r.room })}>
              <Loader size={14} />
              <span className="grow"><b>{f?.name ?? 'Flow'}</b><span>Step {r.step} of {r.of}</span></span>
              <span className="progress"><i style={{ width: `${(r.step / r.of) * 100}%` }} /></span>
              <span className="quiet">Open</span>
            </button>
          )
        })}

        {flows.length > 0 && (
          <div className="flows rise" style={{ '--i': 1 } as CSSProperties}>
            {flows.map((f, i) => {
              const last = f.runs[0]
              const busy = running.some((r) => r.flow === f.id)
              return (
                <div key={f.id} className={`flowrow${f.on ? '' : ' off'}`} style={{ '--i': i } as CSSProperties}>
                  <button className="flowmain" onClick={() => go({ name: 'flows', edit: f.id })}>
                    <span className="crewmarks">{f.crew.slice(0, 3).map((id) => <Mark key={id} seed={agentOf(id, agents).mark} size={14} />)}</span>
                    <span className="grow">
                      <b>{f.name}</b>
                      <span>{describe(f)} · {f.steps.length} step{f.steps.length > 1 ? 's' : ''} · {short(f.workspace)}</span>
                    </span>
                  </button>
                  <span className="flowwhen">
                    {f.on && f.next ? <span>Next {upcoming(f.next)}</span> : <span className="quiet">{f.every ? 'Paused' : 'Manual'}</span>}
                    {last && <button className={`lastrun${last.ok ? '' : ' bad'}`} onClick={() => go({ name: 'room', id: last.room })} title="Open the last run">{last.ok ? 'Ran' : 'Needs a look'} {ago(last.at)}</button>}
                  </span>
                  {f.every && <Toggle on={f.on} set={(on) => desk.call('flows:toggle', f.id, on)} label={`Schedule for ${f.name}`} />}
                  <button className="btn small quiet" disabled={busy} onClick={() => run(f)}>{busy ? <Loader size={10} /> : <IconPlay />}Run</button>
                </div>
              )
            })}
          </div>
        )}

        <section className="group rise" style={{ '--i': 2 } as CSSProperties}>
          <h2>{flows.length ? 'Start from a template' : 'Start with one of these'}<span className="quiet">change anything before saving</span></h2>
          <div className="templates">
            {TEMPLATES.map((t, i) => <TemplateCard key={t.id} t={t} i={i} open={() => go({ name: 'flows', template: t.id })} />)}
          </div>
        </section>
      </div>
    </div>
  )
}

function TemplateCard({ t, i, open }: { t: Template; i: number; open: () => void }) {
  const agents = useApp((s) => s.agents)
  return (
    <button className="tcard" style={{ '--i': i } as CSSProperties} onClick={open}>
      <span className="crewmarks">{t.crew.map((id) => <Mark key={id} seed={agentOf(id, agents).mark} size={14} />)}</span>
      <b>{t.name}</b>
      <span>{t.line}</span>
      <small>{describe(t)} · {t.steps.length} step{t.steps.length > 1 ? 's' : ''}</small>
    </button>
  )
}

export function Toggle({ on, set, label }: { on: boolean; set: (on: boolean) => void; label: string }) {
  return <button className={`toggle${on ? ' on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => set(!on)}><i /></button>
}

function Editor({ initial, go, say }: { initial: Draft; go: (v: View) => void; say: (t: string) => void }) {
  const agents = useApp((s) => s.agents)
  const packs = useApp((s) => s.packs)
  const [d, setD] = useState<Draft>(initial)
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }))
  const setStep = (i: number, patch: Partial<FlowStep>) => set({ steps: d.steps.map((s, k) => (k === i ? { ...s, ...patch } : s)) })
  const present = agents.filter((a) => a.found)
  const toggleCrew = (id: string) => set({ crew: d.crew.includes(id) ? d.crew.filter((c) => c !== id) : [...d.crew, id] })
  const pick = async () => { const p = await desk.call('pick'); if (p) set({ workspace: p }) }

  const save = async (runNow = false) => {
    setBusy(true)
    try {
      const f: Flow = await desk.call('flows:put', { ...d, every: d.every || undefined })
      if (runNow) {
        const room = await desk.call('flows:run', f.id)
        return go({ name: 'room', id: room })
      }
      say(d.id ? 'Flow saved' : 'Flow created')
      go({ name: 'flows' })
    } catch (e) {
      say(reason(e))
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!d.id) return
    await desk.call('flows:remove', d.id)
    say('Flow deleted')
    go({ name: 'flows' })
  }

  return (
    <div className="page">
      <div className="pagebody">
        <header className="pagehead rise row">
          <button className="ghostbtn" onClick={() => go({ name: 'flows' })}>Flows</button>
          <span className="quiet">/</span>
          <input className="titleinput grow" value={d.name} placeholder="Name the flow" onChange={(e) => set({ name: e.target.value })} autoFocus={!d.name} />
        </header>

        <section className="group rise" style={{ '--i': 1 } as CSSProperties}>
          <h2>Steps<span className="quiet">each one waits for the last to finish, handoffs included</span></h2>
          <ol className="steps">
            {d.steps.map((s, i) => (
              <li key={i} className="step" style={{ '--i': i } as CSSProperties}>
                <span className="stepn">{String(i + 1).padStart(2, '0')}</span>
                <div className="grow">
                  <textarea value={s.text} rows={Math.min(6, Math.max(2, Math.ceil(s.text.length / 80)))} placeholder={i ? 'Then…' : 'First, what should happen?'} onChange={(e) => setStep(i, { text: e.target.value })} />
                  <div className="stepfoot">
                    <span className="quiet">Done by</span>
                    <button className={`chip small${!s.to ? ' on' : ''}`} onClick={() => setStep(i, { to: undefined })}>Best fit</button>
                    {d.crew.map((id) => (
                      <button key={id} className={`chip small${s.to === id ? ' on' : ''}`} onClick={() => setStep(i, { to: id })}><Mark seed={agentOf(id, agents).mark} size={12} />{agentOf(id, agents).short}</button>
                    ))}
                  </div>
                </div>
                {d.steps.length > 1 && <button className="iconbtn" aria-label="Remove step" onClick={() => set({ steps: d.steps.filter((_, k) => k !== i) })}><IconClose /></button>}
              </li>
            ))}
          </ol>
          <div className="row">
            <button className="btn small quiet" onClick={() => set({ steps: [...d.steps, { text: '' }] })}><IconPlus />Add a step</button>
            <span className="hint">Write <code>{'{{date}}'}</code> for today, <code>{'{{last}}'}</code> for how the previous run ended.</span>
          </div>
        </section>

        <section className="group rise" style={{ '--i': 2 } as CSSProperties}>
          <h2>Crew</h2>
          <div className="chips">
            {present.map((a) => (
              <button key={a.id} className={`chip${d.crew.includes(a.id) ? ' on' : ''}`} disabled={!!unavailable(a) && !d.crew.includes(a.id)} onClick={() => toggleCrew(a.id)} title={unavailable(a) ?? a.good}>
                <Mark seed={a.mark} size={14} />{a.short}
              </button>
            ))}
          </div>
        </section>

        <section className="group rise" style={{ '--i': 3 } as CSSProperties}>
          <h2>When</h2>
          <div className="row wrap">
            <span className="seg">
              <button className={!d.every ? 'on' : ''} onClick={() => set({ every: undefined })}>When I run it</button>
              {EVERY.map((e) => <button key={e.id} className={d.every === e.id ? 'on' : ''} onClick={() => set({ every: e.id })}>{e.name}</button>)}
            </span>
            {d.every === 'week' && (
              <select className="select" value={d.day} onChange={(e) => set({ day: Number(e.target.value) })}>
                {DAYS.map((name, i) => <option key={name} value={i}>{name}</option>)}
              </select>
            )}
            {d.every && d.every !== 'hour' && <input className="select mono" type="time" value={d.at} onChange={(e) => set({ at: e.target.value })} />}
            {d.every === 'hour' && (
              <label className="row quiet">at minute<input className="select mono" type="number" min={0} max={59} value={Number(d.at.split(':')[1] ?? 0)} onChange={(e) => set({ at: `00:${String(Math.min(59, Math.max(0, Number(e.target.value) || 0))).padStart(2, '0')}` })} /></label>
            )}
          </div>
          <p className="hint">Runs while Lunchbox is open. A run missed while it was closed starts when it opens, if it was due in the last six hours.</p>
        </section>

        <section className="group rise" style={{ '--i': 4 } as CSSProperties}>
          <h2>Where and how</h2>
          <div className="settings">
            <div className="setting">
              <div className="grow"><b>Folder</b><span className="mono">{short(d.workspace)}</span></div>
              <button className="btn small quiet" onClick={pick}><IconFolder />Choose</button>
            </div>
            <div className="setting">
              <div className="grow"><b>Pack</b><span>{packs.find((p) => p.id === d.pack)?.line ?? 'No pack, a general room'}</span></div>
              <select className="select" value={d.pack ?? ''} onChange={(e) => set({ pack: e.target.value || undefined })}>
                <option value="">None</option>
                {packs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="setting">
              <div className="grow"><b>Mode</b><span>{ACCESS.find((a) => a.id === d.access)?.line}</span></div>
              <span className="seg">{ACCESS.map((a) => <button key={a.id} className={d.access === a.id ? 'on' : ''} onClick={() => set({ access: a.id })}>{a.name}</button>)}</span>
            </div>
          </div>
          {d.access === 'ask' && <p className="hint warn">In Ask mode a flow stops at the first edit and waits for you. Plan or Auto suit unattended runs better.</p>}
        </section>

        <footer className="editorfoot rise" style={{ '--i': 5 } as CSSProperties}>
          {d.id && <button className="btn small quiet danger" onClick={remove}>Delete</button>}
          <span className="spacer" />
          <button className="btn quiet" disabled={busy} onClick={() => go({ name: 'flows' })}>Cancel</button>
          <button className="btn quiet" disabled={busy} onClick={() => save(true)}><IconPlay />Save and run</button>
          <button className="btn" disabled={busy} onClick={() => save()}>{d.id ? 'Save' : 'Create flow'}</button>
        </footer>
      </div>
    </div>
  )
}
