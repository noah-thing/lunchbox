import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import type { AgentInfo } from '../../shared/types'
import { Mark } from '../ui/bits'
import { Band } from '../ui/Band'
import { Logo } from '../ui/Logo'
import { IconFolder } from '../ui/icons'
import { flow } from '../App'
import { desk, isDesktop, machine, short, useApp } from '../lib/desk'
import { LocalSetupBox } from './Agents'

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
    // Enter on a focused button, link or field does its own thing and must not also move on.
    const key = (e: KeyboardEvent) => { if (e.key === 'Enter' && !e.defaultPrevented && !(e.target as HTMLElement)?.closest?.('button, a, input, textarea, select, [contenteditable=true]')) ref.current() }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [when])
}

function Welcome({ onNext }: { onNext: () => void }) {
  useEnter(onNext)
  return (
    <div className="obpage first">
      <Logo size={36} className="oblogo rise" />
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
    }).catch(() => { if (alive) { setList(cached.filter((a) => a.via !== 'api')); setBusy(false) } })
    return () => { alive = false }
  }, [])
  const rescan = () => desk.call('agents:refresh').then((all: AgentInfo[]) => {
    setList(all.filter((a) => a.via !== 'api').sort((x, y) => Number(y.found) - Number(x.found)))
    setShown(all.length)
  })
  // A model finishing its download or a server starting refreshes the agents; follow along.
  useEffect(() => { if (list) setList(cached.filter((a) => a.via !== 'api').sort((x, y) => Number(y.found) - Number(x.found))) }, [cached])
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
      <h1 className="rise" style={r(0)}>{!list ? 'Looking for your agents' : found.length ? `${found.filter((a) => a.ready).length} of ${found.length} agents ready` : 'No agents found yet'}</h1>
      <p className="rise" style={r(1)}>Each keeps its own login and plan. Lunchbox runs the real tool, with nothing in between.</p>
      <div className="agentlist">
        {!list && Array.from({ length: 3 }, (_, i) => <div key={i} className="arow ghost" style={r(i)}><i /><b /><span className="spacer" /><code /></div>)}
        {found.slice(0, shown).map((a) => {
          const step = a.setup && !a.ready ? (!a.setup.running ? 'server off' : 'no chat model') : ''
          return [
            <div key={a.id} className="arow">
              <Mark seed={a.mark} size={18} blink={1} />
              <b>{a.name}</b>
              <span className="spacer" />
              <code className={step ? 'todo' : ''}>{step || `${a.bin ?? a.via} ${a.version ?? ''}`}</code>
            </div>,
            settled && step && a.id !== 'llamacpp' ? <div key={a.id + 'fix'} className="unfold obfix"><div><div className="obfixbox"><LocalSetupBox a={a} say={() => rescan()} /></div></div></div> : null,
          ]
        })}
        {settled && missing.length > 0 && (
          <div className="unfold late"><div>
          <div className="obmissing">
            <small>Not on {machine()} yet</small>
            {missing.map((m) => <Missing key={m.id} a={m} />)}
            <div className="row">
              <button className="btn small quiet" onClick={rescan}>Check again</button>
              <span className="quiet">API keys can be added any time in Agents.</span>
            </div>
          </div>
          </div></div>
        )}
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
      <h1 className="rise" style={r(0)}>Your work goes in the Lunchbox folder</h1>
      <p className="rise" style={r(1)}>Each room gets a folder of its own in here, named after what you asked. To work in one of your projects, pick it from the folder menu under the message box.</p>
      <button className="folderpick rise" style={r(2)} onClick={pick}>
        <IconFolder />
        <code className="grow">{short(folder) || 'Choose a folder'}</code>
        <span>Change</span>
      </button>
      <button className="btn big rise" style={r(3)} onClick={onDone}>Open Lunchbox <kbd>↵</kbd></button>
    </div>
  )
}

// The one line each tool's makers publish for installing it. Agents without one link to their page.
const INSTALL: Record<string, { cmd?: string; url: string }> = {
  claude: { cmd: 'npm install -g @anthropic-ai/claude-code', url: 'https://claude.com/claude-code' },
  codex: { cmd: 'npm install -g @openai/codex', url: 'https://github.com/openai/codex' },
  gemini: { cmd: 'npm install -g @google/gemini-cli', url: 'https://github.com/google-gemini/gemini-cli' },
  grok: { url: 'https://x.ai' },
  ollama: { url: 'https://ollama.com/download' },
  lmstudio: { url: 'https://lmstudio.ai' },
  llamacpp: { cmd: navigator.platform.startsWith('Win') ? 'winget install llama.cpp' : /Mac/.test(navigator.platform) ? 'brew install llama.cpp' : undefined, url: 'https://github.com/ggml-org/llama.cpp' },
}

function Missing({ a }: { a: AgentInfo }) {
  const how = INSTALL[a.id]
  const [copied, setCopied] = useState(false)
  if (!how) return null
  const copy = () => { navigator.clipboard.writeText(how.cmd!); setCopied(true); setTimeout(() => setCopied(false), 1400) }
  return (
    <div className="obmiss">
      <Mark seed={a.mark} size={14} />
      <span className="name" title={a.note}>{a.name}{a.note && a.via === 'cli' && <span className="quiet"> is here, but does not start</span>}</span>
      {how.cmd ? <button className="cmd" onClick={copy} title="Copy">{copied ? 'copied' : `$ ${how.cmd}`}</button> : <a className="cmd" href={how.url} target="_blank" rel="noreferrer">{how.url.replace('https://', '')}</a>}
    </div>
  )
}
