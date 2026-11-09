import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import type { AgentInfo } from '../../shared/types'
import { Mark } from '../ui/bits'
import { Band } from '../ui/Band'
import { IconFolder } from '../ui/icons'
import { flow } from '../App'
import { desk, isDesktop, machine, short, useApp } from '../lib/desk'

const STEPS = 4
const r = (i: number) => ({ '--i': i }) as CSSProperties

// One band of code characters stays at the top through every step: it spells the name on the
// welcome, then the word dissolves into it and its label says what the step is doing.
export function Onboarding({ onDone, workspace, theme, setTheme }: {
  onDone: (folder: string | null) => void; workspace: string; theme: 'dark' | 'light'; setTheme: (t: 'dark' | 'light', e?: MouseEvent) => void
}) {
  const [step, setStep] = useState(0)
  const [folder, setFolder] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const next = () => flow(() => setStep((s) => Math.min(STEPS - 1, s + 1)))
  const back = () => flow(() => setStep((s) => Math.max(0, s - 1)))
  const done = () => { setLeaving(true); setTimeout(() => onDone(folder), 560) }
  useEffect(() => {
    if (step === 0) setLabel('')
    if (step === 2) setLabel(theme === 'dark' ? 'ink on black' : 'ink on paper')
    if (step === 3) setLabel('choosing a workspace')
  }, [step, theme])

  return (
    <div className={`onboard${leaving ? ' leaving' : ''}`}>
      <div className="obdrag" />
      <div className="obcol">
        <Band rows={11} word={step === 0 ? 'LUNCHBOX' : undefined} label={label} busy={busy} className="obband" />
        <div className="obsteps" aria-label={`Step ${step + 1} of ${STEPS}`}>
          {Array.from({ length: STEPS }, (_, i) => <i key={i} className={i < step ? 'on' : i === step ? 'cur' : ''}><b /></i>)}
          {step > 0 && <button className="obback" onClick={back}>Back</button>}
        </div>
        {step === 0 && <Welcome onNext={next} />}
        {step === 1 && <Agents onNext={next} setLabel={setLabel} setBusy={setBusy} />}
        {step === 2 && <Look theme={theme} setTheme={setTheme} onNext={next} />}
        {step === 3 && <Folder folder={folder ?? workspace} pick={async () => { const p = await desk.call('pick'); if (p) setFolder(p) }} onDone={done} />}
      </div>
    </div>
  )
}

function useEnter(fn: () => void, when = true) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!when) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName !== 'BUTTON') ref.current() }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [when])
}

function Welcome({ onNext }: { onNext: () => void }) {
  useEnter(onNext)
  return (
    <div className="obpage first">
      <h1 className="rise" style={r(0)}>Every AI you use, working as one.</h1>
      <p className="rise" style={r(1)}>Bring the agents already on {machine()} into one room. They share what they know, ask each other for help and check each other’s work.</p>
      <div className="obfacts rise" style={r(2)}>
        <span><b>Shared memory</b>Every agent knows what the room knows</span>
        <span><b>Handoffs</b>When one runs out, the next takes over</span>
        <span><b>Proof</b>Claims are checked against what really ran</span>
      </div>
      <button className="btn big rise" style={r(3)} onClick={onNext}>Get started <kbd>↵</kbd></button>
    </div>
  )
}

function Agents({ onNext, setLabel, setBusy }: { onNext: () => void; setLabel: (l: string) => void; setBusy: (b: boolean) => void }) {
  const [list, setList] = useState<AgentInfo[] | null>(null)
  const [shown, setShown] = useState(0)
  const cached = useApp((s) => s.agents)
  useEffect(() => {
    let alive = true
    setLabel(`looking for agents on ${machine()}`)
    setBusy(true)
    Promise.all([desk.call('agents:refresh'), new Promise((ok) => setTimeout(ok, 1200))]).then(([found]) => {
      if (!alive) return
      const all = (found as AgentInfo[] | null) ?? cached
      setList(all.filter((a) => a.via !== 'api').sort((a, b) => Number(b.found) - Number(a.found)))
      setBusy(false)
    })
    return () => { alive = false }
  }, [])
  const found = list?.filter((a) => a.found) ?? []
  const missing = list?.filter((a) => !a.found) ?? []
  useEffect(() => { if (list) setLabel(found.length ? found.map((a) => a.bin ?? a.short.toLowerCase()).join(' + ') : 'no agents found') }, [list])
  useEffect(() => {
    if (!list || shown >= found.length) return
    const t = setTimeout(() => setShown((s) => s + 1), 140)
    return () => clearTimeout(t)
  }, [list, shown, found.length])
  const settled = !!list && shown >= found.length
  useEnter(onNext, settled)
  return (
    <div className="obpage">
      <h1 className="rise" style={r(0)}>{!list ? 'Looking for your agents' : found.length ? `${found.length} ${found.length === 1 ? 'agent' : 'agents'} found` : 'No agents found yet'}</h1>
      <p className="rise" style={r(1)}>Each keeps its own login and plan. Lunchbox runs the real tool, with nothing in between.</p>
      <div className="agentlist">
        {!list && Array.from({ length: 3 }, (_, i) => <div key={i} className="arow ghost" style={r(i)}><i /><b /><span className="spacer" /><code /></div>)}
        {found.slice(0, shown).map((a) => (
          <div key={a.id} className="arow">
            <Mark seed={a.mark} size={18} blink={1} />
            <b>{a.name}</b>
            {a.note && <span className="anote">{a.note}</span>}
            <span className="spacer" />
            <code>{a.bin ?? a.via} {a.version}</code>
          </div>
        ))}
        {settled && missing.length > 0 && <div className="amissing">Not installed: {missing.map((m) => m.name).join(', ')}. API keys can be added later in Agents.</div>}
      </div>
      {!isDesktop && settled && <span className="obnote">Browser preview. Open the desktop app to find real agents.</span>}
      <button className="btn big" disabled={!settled} onClick={onNext}>Continue <kbd>↵</kbd></button>
    </div>
  )
}

function Look({ theme, setTheme, onNext }: { theme: 'dark' | 'light'; setTheme: (t: 'dark' | 'light', e?: MouseEvent) => void; onNext: () => void }) {
  useEnter(onNext)
  return (
    <div className="obpage">
      <h1 className="rise" style={r(0)}>Dark or light?</h1>
      <p className="rise" style={r(1)}>Change it any time in Settings.</p>
      <div className="looks rise" style={r(2)}>
        {(['dark', 'light'] as const).map((t) => (
          <button key={t} className={`lookcard ${t}${theme === t ? ' on' : ''}`} onClick={(e) => setTheme(t, e)} aria-pressed={theme === t}>
            <span className="mini" aria-hidden="true">
              <span className="mside"><i /><i /><i /></span>
              <span className="msheet"><i className="l1" /><i className="l2" /><i className="l3" /><i className="mbox" /></span>
            </span>
            <b>{t === 'dark' ? 'Dark' : 'Light'}</b>
          </button>
        ))}
      </div>
      <button className="btn big rise" style={r(3)} onClick={onNext}>Continue <kbd>↵</kbd></button>
    </div>
  )
}

function Folder({ folder, pick, onDone }: { folder: string; pick: () => void; onDone: () => void }) {
  useEnter(onDone)
  return (
    <div className="obpage">
      <h1 className="rise" style={r(0)}>Where should they work?</h1>
      <p className="rise" style={r(1)}>Pick a project folder. While you chat you decide how much they may touch, from Plan to Full access.</p>
      <button className="folderpick rise" style={r(2)} onClick={pick}>
        <IconFolder />
        <code className="grow">{short(folder) || 'Choose a folder'}</code>
        <span>Change</span>
      </button>
      <button className="btn big rise" style={r(3)} onClick={onDone}>Open Lunchbox <kbd>↵</kbd></button>
    </div>
  )
}
