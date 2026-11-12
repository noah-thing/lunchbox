import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Connector } from '../../shared/types'
import { logoOf } from '../../shared/logos'
import { Loader, Mark } from '../ui/bits'
import { IconCheck } from '../ui/icons'
import { desk, now, reload, useApp } from '../lib/desk'
import { addOpenCode, hasOpenCode, OPENCODE_INSTALL, openCodeFound } from './Connect'
import type { View } from '../App'

// Models anyone can use without paying, checked on 12 November 2026. No card, no trial that runs
// out; a free key at most. Each says plainly what happens to the prompts sent to it.
type Way = 'opencode' | 'none' | 'key' | 'local'
type Free = {
  id: string
  name: string
  what: string
  limit: string
  data: string
  warn?: boolean
  way: Way
  base?: string
  model?: string
  // Models the test lists are searched for these, in order, when the preferred one is missing.
  prefer?: RegExp[]
  keyUrl?: string
  keyLooks?: RegExp
  first?: string
}

const FREE: Free[] = [
  { id: 'opencode', name: 'OpenCode', way: 'opencode', what: 'About a dozen free models from several labs, as a full coding agent.', limit: 'No key, no account', data: 'Some of its free models use prompts to improve the model.', warn: true },
  { id: 'kilo', name: 'Kilo Free', way: 'none', base: 'https://api.kilo.ai/api/gateway', model: 'kilo-auto/free', what: 'Picks a free model for each message.', limit: 'No key · 200 messages an hour', data: 'Runs on trial endpoints, so prompts may be logged.', warn: true },
  { id: 'local', name: 'Local models', way: 'local', what: 'Ollama, LM Studio or llama.cpp, running on your own computer.', limit: 'No key · no limits', data: 'Nothing leaves your computer.' },
  { id: 'openrouter', name: 'OpenRouter', way: 'key', base: 'https://openrouter.ai/api/v1', model: 'openrouter/free', keyUrl: 'https://openrouter.ai/settings/keys', keyLooks: /^sk-or-/, what: 'A rotating set of free models from many labs, behind one key.', limit: 'Free key · 50 messages a day', data: 'Each model sets its own logging. Exclude ones that train in OpenRouter\'s privacy settings.' },
  { id: 'gemini', name: 'Google AI Studio', way: 'key', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash', prefer: [/gemini-3\.\d+-flash$/, /flash/], keyUrl: 'https://aistudio.google.com/apikey', keyLooks: /^AIza/, what: 'Gemini Flash, fast and capable, with a daily free allowance.', limit: 'Free key · daily limit', data: 'Google may use free-tier prompts to improve its products.', warn: true },
  { id: 'groq', name: 'Groq', way: 'key', base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', prefer: [/gpt-oss-120b/, /gpt-oss/], keyUrl: 'https://console.groq.com/keys', keyLooks: /^gsk_/, what: 'GPT-OSS 120B at very high speed.', limit: 'Free key · about 1,000 messages a day', data: 'No card needed.' },
  { id: 'mistral', name: 'Mistral', way: 'key', base: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', prefer: [/mistral-small/, /codestral/], keyUrl: 'https://console.mistral.ai/api-keys', first: 'Choose the free Experiment plan, then create a key.', what: 'Mistral Small and Codestral on the free Experiment plan.', limit: 'Free key · rate limited', data: 'May train on prompts until you turn it off under Privacy.', warn: true },
  { id: 'nvidia', name: 'NVIDIA', way: 'key', base: 'https://integrate.api.nvidia.com/v1', prefer: [/nemotron/, /llama/], keyUrl: 'https://build.nvidia.com', keyLooks: /^nvapi-/, first: 'Sign in, then open Settings and API Keys.', what: 'Open models hosted by NVIDIA, Nemotron among them.', limit: 'Free key · about 40 messages a minute', data: 'Trial terms, for personal use. Prompts may be logged.', warn: true },
]

const NONE: Connector[] = []

export function FreeModels({ go, say }: { go: (v: View) => void; say: (t: string) => void }) {
  // The list itself from the store, with the default outside the selector, so an empty list is not
  // a new array on every render.
  const saved = useApp((s) => s.settings.connectors)
  const connectors = saved ?? NONE
  const added = (f: Free) => f.way === 'opencode' ? hasOpenCode(connectors) : !!f.base && connectors.some((c) => c.base === f.base)
  return (
    <div className="page">
      <div className="pagebody wide free">
        <header className="pagehead rise">
          <h1>Free models</h1>
          <p>Models you can use without paying anything. Some need nothing at all; the rest need a free key, which takes about a minute. None ask for a card.</p>
        </header>
        <div className="freegrid">
          {FREE.map((f, i) => <FreeCard key={f.id} f={f} i={i} added={added(f)} connectors={connectors} go={go} say={say} />)}
        </div>
        <p className="freenote rise" style={{ '--i': 3 } as CSSProperties}>Checked on 12 November 2026. Free offers change; if one stops working, its card will say why when you connect.</p>
      </div>
    </div>
  )
}

function FreeCard({ f, i, added, connectors, go, say }: { f: Free; i: number; added: boolean; connectors: Connector[]; go: (v: View) => void; say: (t: string) => void }) {
  const [state, setState] = useState<'idle' | 'key' | 'busy' | 'install'>('idle')
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  // Back from the key page with a key copied: it goes into the field by itself.
  useEffect(() => {
    if (state !== 'key' || !f.keyLooks) return
    const look = () => desk.call('clipboard:key', f.id).then((t: string) => { if (t) setKey((k) => k || t) }).catch(() => {})
    addEventListener('focus', look)
    return () => removeEventListener('focus', look)
  }, [state, f.keyLooks])

  // Read at the moment of saving, so two cards connecting at once both land.
  const save = async (c: Connector, k = '') => {
    const connectors = now().settings.connectors ?? []
    const taken = new Set(connectors.map((x) => x.id))
    let id = `free-${f.id}`
    for (let n = 2; taken.has(id); n++) id = `free-${f.id}-${n}`
    if (k) await desk.call('keys:set', `conn:${id}`, k)
    await reload.settings({ connectors: [...connectors, { ...c, id }] })
  }

  const connect = async () => {
    setError('')
    setState('busy')
    try {
      if (f.way === 'opencode') {
        if (!(await openCodeFound())) { setState('install'); return }
        await addOpenCode()
      } else {
        const c: Connector = { id: '', name: f.name, kind: 'openai', base: f.base, model: f.model }
        const check = await desk.call('connector:test', c, key.trim()) as { ok: boolean; note?: string; models?: string[] }
        if (!check.ok) throw new Error(check.note || 'It did not answer')
        const list = check.models ?? []
        const model = f.model && (!list.length || list.includes(f.model)) ? f.model : (f.prefer ?? []).map((re) => list.find((m) => re.test(m))).find(Boolean) ?? list[0]
        if (!model) throw new Error('It answered but listed no models to use')
        await save({ ...c, model }, key.trim())
      }
      say(`${f.name} added to your agents`)
      setState('idle')
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error:\s*/, '') : String(e))
      setState(f.way === 'key' ? 'key' : 'idle')
    }
  }

  const getKey = () => {
    window.open(f.keyUrl, '_blank')
    setState('key')
    requestAnimationFrame(() => field.current?.focus())
  }

  return (
    <article className={`freecard rise${added ? ' on' : ''}`} style={{ '--i': i + 1 } as CSSProperties}>
      <header>
        <Mark seed={f.way === 'local' ? 'ollama' : f.way === 'opencode' ? 'opencode' : logoOf({ kind: 'openai', base: f.base })} size={20} />
        <span className="freename"><b>{f.name}</b><span className="freelimit">{f.limit}</span></span>
      </header>
      <p>{f.what}</p>
      <p className={`freedata${f.warn ? ' warn' : ''}`}>{f.data}</p>
      {state === 'key' && (
        <div className="freekey">
          {f.first && <small>{f.first}</small>}
          <input ref={field} type="password" value={key} placeholder="Paste your free key" onChange={(e) => { setKey(e.target.value); setError('') }}
            onKeyDown={(e) => { if (e.key === 'Enter' && key.trim()) connect() }} spellCheck={false} />
        </div>
      )}
      {state === 'install' && (
        <div className="freekey">
          <small>OpenCode is not installed yet. Run this in a terminal, then add it.</small>
          <button className="freecmd" onClick={() => { navigator.clipboard.writeText(OPENCODE_INSTALL).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400) }).catch(() => {}) }}>
            <code>{OPENCODE_INSTALL}</code><span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      )}
      {error && <p className="freeerr">{error}</p>}
      <div className="freeact">
        {added ? <span className="freeon"><IconCheck />In your agents</span>
          : f.way === 'local' ? <button className="btn small" onClick={() => go({ name: 'agents' })}>Set up</button>
          : state === 'busy' ? <button className="btn small" disabled><Loader size={10} /></button>
          : f.way === 'key' && state !== 'key' ? <button className="btn small" onClick={getKey}>Get a free key</button>
          : f.way === 'key' ? <>
              <button className="btn small quiet" onClick={() => window.open(f.keyUrl, '_blank')}>Open key page</button>
              <button className="btn small" disabled={!key.trim()} onClick={connect}>Connect</button>
            </>
          : <button className="btn small" onClick={connect}>{state === 'install' ? 'Check again' : 'Add'}</button>}
      </div>
    </article>
  )
}
