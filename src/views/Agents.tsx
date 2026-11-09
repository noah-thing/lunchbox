import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { AgentInfo, Pull } from '../../shared/types'
import { Loader, Mark, Meter } from '../ui/bits'
import { clock, desk, money, reload, tokens, unavailable, useApp } from '../lib/desk'

const GROUPS: { via: AgentInfo['via'][]; title: string; line: string }[] = [
  { via: ['cli'], title: 'On this computer', line: 'Command line agents with their own login and plan. Lunchbox runs the real tool.' },
  { via: ['local'], title: 'Local models', line: 'Free and private. Nothing leaves the machine.' },
  { via: ['api'], title: 'With an API key', line: 'Pay per token. Keys are sealed with the system keychain.' },
]

export function Agents({ say }: { say: (t: string) => void }) {
  const agents = useApp((s) => s.agents)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = async () => { setBusy(true); await reload.agents(); setBusy(false); say('Checked again') }
  let n = 0
  return (
    <div className="page">
      <header className="pagehead row">
        <div className="grow">
          <h1>Agents</h1>
          <p>When one runs out or fails, the room hands its work to the next one in the crew with the same memory.</p>
        </div>
        <button className="btn small quiet" onClick={refresh} disabled={busy}>{busy ? <Loader size={10} /> : 'Check again'}</button>
      </header>
      {GROUPS.map((g) => {
        const list = agents.filter((a) => g.via.includes(a.via))
        if (!list.length) return null
        return (
          <section key={g.title} className="agroup">
            <h2>{g.title}<span>{g.line}</span></h2>
            <div className="agents">
              {list.map((a) => <AgentRow key={a.id} a={a} i={n++} open={open === a.id} toggle={() => setOpen(open === a.id ? null : a.id)} say={say} />)}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function AgentRow({ a, i, open, toggle, say }: { a: AgentInfo; i: number; open: boolean; toggle: () => void; say: (t: string) => void }) {
  const ledger = useApp((s) => s.ledger)
  const settings = useApp((s) => s.settings)
  const why = unavailable(a)
  const today = ledger?.today[a.id]
  const week = ledger?.week[a.id]
  const wins = ledger?.arena[a.id] ?? 0
  const budget = settings.budgets[a.id] ?? 0
  const spent = ledger?.spent[a.id]
  const s = a.setup
  const state = !a.found ? (a.via === 'api' ? 'No key' : 'Not installed') : s && !s.running ? 'Not running' : s && !a.ready ? 'No chat model' : why ? 'Unavailable' : 'Ready'
  return (
    <div className={`agent${open ? ' open' : ''}${a.found ? '' : ' missing'}`} style={{ '--i': i } as CSSProperties}>
      <button className="agenthead" onClick={toggle} aria-expanded={open}>
        <Mark seed={a.mark} size={22} />
        <span className="aname"><b>{a.name}</b><span>{a.maker}{a.version ? ` · ${a.version}` : ''}</span></span>
        <span className="grow agood">{why && a.found ? why : a.good}</span>
        <span className="aleft">
          {budget > 0 ? <Meter value={Math.max(0, 1 - (today?.cost ?? 0) / budget)} cells={14} tone={(today?.cost ?? 0) > budget * 0.75 ? 'warn' : undefined} /> : null}
          <span>{today ? `${tokens(today.input + today.output + today.cached)} today${today.cost ? `, ${money(today.cost)}` : ''}` : state}</span>
        </span>
      </button>
      {open && (
        <div className="agentbody">
          {a.note && <p className="anote">{a.note}</p>}
          {a.setup && <LocalSetupBox a={a} say={say} />}
          {a.via === 'api' && <KeyField a={a} say={say} />}
          {a.found && (!a.setup || a.ready) && <ModelField a={a} />}
          {a.found && a.via !== 'local' && (
            <label className="field">
              <span>Daily budget</span>
              <input type="number" min={0} step={0.5} placeholder="No limit" defaultValue={budget || ''}
                onBlur={(e) => reload.settings({ budgets: { ...settings.budgets, [a.id]: Number(e.target.value) || 0 } })} />
              <small>US dollars. Over it, the room moves work to the next agent.</small>
            </label>
          )}
          <div className="astats">
            <span><b>{week ? tokens(week.input + week.output + week.cached) : 0}</b> tokens this week</span>
            {week && week.cached > 0 && <span><b>{Math.round((week.cached / (week.input + week.cached)) * 100)}%</b> read from cache</span>}
            {week && week.cost > 0 && <span><b>{money(week.cost)}</b> this week</span>}
            <span><b>{wins}</b> side by side {wins === 1 ? 'win' : 'wins'}</span>
          </div>
          <div className="row">
            {a.found && (
              <button className="btn small quiet" onClick={() => reload.settings({ disabled: settings.disabled.includes(a.id) ? settings.disabled.filter((d) => d !== a.id) : [...settings.disabled, a.id] })}>
                {settings.disabled.includes(a.id) ? 'Turn on' : 'Turn off'}
              </button>
            )}
            {spent && spent.until > Date.now() && (
              <button className="btn small quiet" onClick={() => { desk.call('spent:clear', a.id); say(`${a.short} is back in rotation`) }}>Back already? Clear the limit ({clock(spent.until)})</button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const PROVIDER: Record<string, { key: string; url: string; hint: string }> = {
  'claude-api': { key: 'anthropic', url: 'https://console.anthropic.com/settings/keys', hint: 'sk-ant-…' },
  'openai-api': { key: 'openai', url: 'https://platform.openai.com/api-keys', hint: 'sk-…' },
  'grok-api': { key: 'xai', url: 'https://console.x.ai', hint: 'xai-…' },
  'gemini-api': { key: 'google', url: 'https://aistudio.google.com/apikey', hint: 'AIza…' },
  openrouter: { key: 'openrouter', url: 'https://openrouter.ai/keys', hint: 'sk-or-…' },
}

function KeyField({ a, say }: { a: AgentInfo; say: (t: string) => void }) {
  const p = PROVIDER[a.id]
  const [value, setValue] = useState('')
  const [masked, setMasked] = useState<string>('')
  const [saving, setSaving] = useState(false)
  useEffect(() => { desk.call('keys').then((k: Record<string, string>) => setMasked(k?.[p.key] ?? '')) }, [p.key, a.found])
  const save = async (key: string) => {
    setSaving(true)
    await desk.call('keys:set', p.key, key)
    await reload.agents()
    setSaving(false)
    setValue('')
    say(key ? 'Key saved' : 'Key removed')
  }
  return (
    <label className="field">
      <span>API key</span>
      <div className="row">
        <input type="password" placeholder={masked || p.hint} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) save(value) }} />
        <button className="btn small" disabled={!value.trim() || saving} onClick={() => save(value)}>{saving ? <Loader size={10} /> : 'Save'}</button>
        {masked && <button className="btn small quiet" onClick={() => save('')}>Remove</button>}
      </div>
      <small>Get one at <a href={p.url} target="_blank" rel="noreferrer">{p.url.replace('https://', '')}</a></small>
    </label>
  )
}

function ModelField({ a }: { a: AgentInfo }) {
  const settings = useApp((s) => s.settings)
  const [models, setModels] = useState<string[]>(a.models ?? [])
  const [error, setError] = useState('')
  useEffect(() => {
    if (a.via === 'cli') return
    desk.call('agents:models', a.id).then((r: string[] | { error: string }) => (Array.isArray(r) ? setModels(r) : setError(r?.error ?? '')))
  }, [a.id, a.via, a.found])
  const value = settings.models[a.id] ?? ''
  return (
    <label className="field">
      <span>Model</span>
      <input list={`models-${a.id}`} placeholder={a.via === 'cli' ? 'The default from its own config' : a.model ?? 'Picked for you'} defaultValue={value}
        onBlur={(e) => { if (e.target.value.trim() !== value) reload.settings({ models: { ...settings.models, [a.id]: e.target.value.trim() } }) }} />
      <datalist id={`models-${a.id}`}>{models.slice(0, 200).map((m) => <option key={m} value={m} />)}</datalist>
      <small>{error || (a.via === 'cli' ? 'Leave empty to use what you set up in the tool itself.' : `${models.length} available`)}</small>
    </label>
  )
}

// Pull progress lives outside the page so leaving Agents mid download keeps the bar where it was.
const pulls = new Map<string, Pull>()
const watchers = new Set<() => void>()
let snapshot: Pull[] = []
desk.on('local:pull', (p: Pull) => {
  pulls.set(p.model, p)
  if (p.finished) setTimeout(() => { pulls.delete(p.model); snapshot = [...pulls.values()]; watchers.forEach((w) => w()) }, 1600)
  snapshot = [...pulls.values()]
  watchers.forEach((w) => w())
})
export const usePulls = () => useSyncExternalStore((w) => { watchers.add(w); return () => watchers.delete(w) }, () => snapshot)

const gb = (n: number) => (n / 2 ** 30).toFixed(n >= 10 * 2 ** 30 ? 0 : 1)

// Text progress, the way a terminal draws it: [#######.......]  48%  2.5 of 5.2 GB
export function PullBar({ p }: { p: Pull }) {
  const share = p.total ? p.done / p.total : 0
  const W = 28
  const lit = Math.round(share * W)
  return (
    <div className={`pullbar${p.error ? ' failed' : p.finished ? ' done' : ''}`} role="progressbar" aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100}>
      <span className="bar">[<b>{'#'.repeat(lit)}</b>{'.'.repeat(W - lit)}]</span>
      <span>{p.error ? p.error : p.finished ? 'ready' : p.total ? `${String(Math.round(share * 100)).padStart(3)}%  ${gb(p.done)} of ${gb(p.total)} GB` : p.status.toLowerCase()}</span>
    </div>
  )
}

export function LocalSetupBox({ a, say }: { a: AgentInfo; say: (t: string) => void }) {
  const s = a.setup!
  const [starting, setStarting] = useState(false)
  const [custom, setCustom] = useState('')
  const all = usePulls()
  const mine = all.filter((p) => p.agent === a.id)
  const begin = async () => {
    setStarting(true)
    const r = await desk.call('local:start', a.id)
    setStarting(false)
    say(r.ok ? `${a.name} is running` : r.error)
  }
  const get = (model: string) => { if (model.trim()) desk.call('local:pull', model.trim()) }
  const open = () => window.open(s.download, '_blank')

  if (!s.installed && !s.running) return (
    <div className="localbox">
      <p>{a.id === 'llamacpp' ? 'Nothing is listening on port 8080. Start llama-server, or any server that speaks the OpenAI API, and press Check again.' : `${a.name} is not on this computer yet. It is free; once it is installed, come back and Lunchbox finds it on its own.`}</p>
      <div className="row"><button className="btn small" onClick={open}>{a.id === 'llamacpp' ? 'llama.cpp on GitHub' : `Get ${a.name}`}</button></div>
    </div>
  )
  if (!s.running) return (
    <div className="localbox">
      <p>{a.id === 'llamacpp' ? 'llama-server is installed but not running. Start it with a model, for example: llama-server -hf ggml-org/gemma-3-4b-it-GGUF' : `${a.name} is installed but its server is off.`}</p>
      {a.id !== 'llamacpp' && <div className="row"><button className="btn small" disabled={starting} onClick={begin}>{starting ? <><Loader size={10} />Starting</> : `Start ${a.name}`}</button></div>}
    </div>
  )
  if (a.id !== 'ollama') return a.ready ? null : (
    <div className="localbox"><p>The server is running with no chat model loaded. Load one in {a.name} and press Check again.</p></div>
  )
  return (
    <div className="localbox">
      {!a.ready && s.suggest && !mine.length && (
        <>
          <p>Ollama is running with no chat model yet. This one fits the memory on this computer.</p>
          <div className="row"><button className="btn small" onClick={() => get(s.suggest!.model)}>Download {s.suggest.model}<span className="quiet">{s.suggest.size}</span></button></div>
        </>
      )}
      {mine.map((p) => (
        <div key={p.model} className="pullrow">
          <span className="mono">{p.model}</span>
          <PullBar p={p} />
          {!p.finished && !p.error && <button className="btn small quiet" onClick={() => desk.call('local:cancel', p.model)}>Stop</button>}
        </div>
      ))}
      {a.ready && (
        <label className="field">
          <span>Add a model</span>
          <div className="row">
            <input placeholder="Any name from ollama.com/library, like gemma3 or qwen3:14b" value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { get(custom); setCustom('') } }} />
            <button className="btn small" disabled={!custom.trim()} onClick={() => { get(custom); setCustom('') }}>Download</button>
          </div>
        </label>
      )}
    </div>
  )
}
