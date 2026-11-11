import { useEffect, useState } from 'react'
import type { Connector } from '../../shared/types'
import { Loader, Mark } from '../ui/bits'
import { logoOf } from '../../shared/logos'
import { IconClose } from '../ui/icons'
import { desk, now, reload, useApp } from '../lib/desk'

type Kind = Connector['kind']
type Preset = Partial<Connector> & { label: string; keyUrl?: string; free?: boolean }

// Starting points only: every field stays editable, and anything not listed works the same way.
const PRESETS: Record<Kind, Preset[]> = {
  openai: [
    { label: 'OpenRouter free models', name: 'OpenRouter Free', base: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', keyUrl: 'https://openrouter.ai/keys', free: true },
    { label: 'Google AI Studio', name: 'Gemini Free', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-flash-latest', keyUrl: 'https://aistudio.google.com/apikey', free: true },
    { label: 'GitHub Models', name: 'GitHub Models', base: 'https://models.github.ai/inference', keyUrl: 'https://github.com/settings/personal-access-tokens', free: true },
    { label: 'NVIDIA NIM', name: 'NVIDIA', base: 'https://integrate.api.nvidia.com/v1', keyUrl: 'https://build.nvidia.com', free: true },
    { label: 'DeepSeek', name: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyUrl: 'https://platform.deepseek.com/api_keys' },
    { label: 'Groq', name: 'Groq', base: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys', free: true },
    { label: 'Mistral', name: 'Mistral', base: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys' },
    { label: 'Together', name: 'Together', base: 'https://api.together.xyz/v1', keyUrl: 'https://api.together.ai/settings/api-keys' },
    { label: 'Fireworks', name: 'Fireworks', base: 'https://api.fireworks.ai/inference/v1', keyUrl: 'https://fireworks.ai/account/api-keys' },
    { label: 'Cerebras', name: 'Cerebras', base: 'https://api.cerebras.ai/v1', keyUrl: 'https://cloud.cerebras.ai', free: true },
    { label: 'Kimi', name: 'Kimi', base: 'https://api.moonshot.ai/v1', keyUrl: 'https://platform.moonshot.ai/console/api-keys' },
    { label: 'DeepInfra', name: 'DeepInfra', base: 'https://api.deepinfra.com/v1/openai', keyUrl: 'https://deepinfra.com/dash/api_keys' },
    { label: 'Perplexity', name: 'Perplexity', base: 'https://api.perplexity.ai', model: 'sonar', keyUrl: 'https://www.perplexity.ai/settings/api' },
    { label: 'A server I run', name: 'My server', base: 'http://127.0.0.1:8000/v1' },
  ],
  anthropic: [
    { label: 'A proxy or gateway', name: 'Claude gateway', base: 'https://' },
  ],
  cli: [
    { label: 'OpenCode', name: 'OpenCode', command: 'opencode', args: 'run {prompt}', free: true },
    { label: 'Qoder', name: 'Qoder', command: 'qodercli', args: '-p {prompt}' },
    { label: 'Crush', name: 'Crush', command: 'crush', args: 'run {prompt}' },
    { label: 'Aider', name: 'Aider', command: 'aider', args: '--message {prompt} --yes-always --no-pretty' },
    { label: 'Goose', name: 'Goose', command: 'goose', args: 'run -t {prompt}' },
    { label: 'Cursor Agent', name: 'Cursor Agent', command: 'cursor-agent', args: '-p {prompt} --output-format text' },
    { label: 'Qwen Code', name: 'Qwen Code', command: 'qwen', args: '-p {prompt}' },
    { label: 'Amp', name: 'Amp', command: 'amp', args: '-x {prompt}' },
    { label: 'My own script', name: 'My script', command: '', args: '{prompt}' },
  ],
}

// OpenCode runs its free models without a key, so it is one click away instead of behind the form.
export const OPENCODE: Connector = { id: 'my-opencode', name: 'OpenCode', kind: 'cli', command: 'opencode', args: 'run {prompt}', output: 'text' }
export const OPENCODE_INSTALL = 'npm install -g opencode-ai'
export const hasOpenCode = (list: Connector[]) => list.some((c) => c.kind === 'cli' && /^opencode(\.cmd|\.exe)?$/i.test((c.command ?? '').trim()))
// Reads the connectors at the moment it runs, so a click on a menu drawn earlier cannot drop one
// added since, and a second click while the first is saving waits for it instead of saving again.
let adding: Promise<string> | null = null
export function addOpenCode(): Promise<string> {
  adding ??= (async () => {
    const list = now().settings.connectors ?? []
    const have = list.find((c) => hasOpenCode([c]))
    if (have) return have.id
    const taken = new Set(list.map((c) => c.id))
    let id = OPENCODE.id
    for (let n = 2; taken.has(id); n++) id = `${OPENCODE.id}-${n}`
    await reload.settings({ connectors: [...list, { ...OPENCODE, id }] })
    return id
  })().finally(() => { adding = null })
  return adding
}
export const openCodeFound = () => desk.call('connector:installed', ['opencode']).then((r: Record<string, boolean>) => !!r.opencode).catch(() => false)

const KINDS: { id: Kind; name: string; line: string }[] = [
  { id: 'openai', name: 'API, OpenAI format', line: 'Most providers and local servers speak this.' },
  { id: 'anthropic', name: 'API, Anthropic format', line: 'Gateways and proxies in front of Claude.' },
  { id: 'cli', name: 'Command line agent', line: 'Any tool you run in a terminal with a prompt.' },
]

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'connector'

// Add or change a connector. Closes on Escape, on a click outside and with the close button.
export function ConnectorSheet({ edit, close, say }: { edit?: Connector; close: () => void; say: (t: string) => void }) {
  const settings = useApp((s) => s.settings)
  const [c, setC] = useState<Connector>(edit ?? { id: '', name: '', kind: 'openai', base: '', model: '', command: '', args: '{prompt}', output: 'text' })
  const [key, setKey] = useState('')
  const [keyUrl, setKeyUrl] = useState<string>()
  const [check, setCheck] = useState<{ ok: boolean; note: string; models?: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [found, setFound] = useState<Record<string, boolean>>({})
  const put = (p: Partial<Connector>) => { setC((x) => ({ ...x, ...p })); setCheck(null) }

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    addEventListener('keydown', esc)
    desk.call('connector:installed', PRESETS.cli.map((p) => p.command).filter(Boolean)).then(setFound).catch(() => {})
    return () => removeEventListener('keydown', esc)
  }, [])

  const ready = c.name.trim() && (c.kind === 'cli' ? (c.command ?? '').trim() : /^https?:\/\/.+/.test(c.base ?? ''))
  const test = async () => { setBusy(true); setCheck(await desk.call('connector:test', c, key).catch((e: Error) => ({ ok: false, note: e.message }))); setBusy(false) }
  const save = async () => {
    const taken = new Set((settings.connectors ?? []).map((x) => x.id))
    let id = c.id || `my-${slug(c.name)}`
    for (let n = 2; !c.id && taken.has(id); n++) id = `my-${slug(c.name)}-${n}`
    const next = { ...c, id, name: c.name.trim() }
    if (key.trim()) await desk.call('keys:set', `conn:${id}`, key.trim())
    await reload.settings({ connectors: [...(settings.connectors ?? []).filter((x) => x.id !== id), next] })
    say(edit ? `${next.name} updated` : `${next.name} added to your agents`)
    close()
  }

  return (
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="sheetcard connect" role="dialog" aria-label="Add a connector">
        <header className="row">
          <div className="grow"><h2>{edit ? `Change ${edit.name}` : 'Add a connector'}</h2><p className="quiet">Anything that is not built in, as a full member of the crew.</p></div>
          <button className="iconbtn" onClick={close} aria-label="Close"><IconClose /></button>
        </header>

        {!edit && (
          <div className="kinds">
            {KINDS.map((k) => (
              <button key={k.id} className={c.kind === k.id ? 'on' : ''} onClick={() => put({ kind: k.id })}>
                <b>{k.name}</b><span>{k.line}</span>
              </button>
            ))}
          </div>
        )}

        <div className="presets">
          {PRESETS[c.kind].map((p) => (
            <button key={p.label} onClick={() => { const { label, keyUrl: url, ...rest } = p; put(rest); setKeyUrl(url) }}>
              <Mark seed={logoOf({ ...p, kind: c.kind })} size={12} />{p.label}{p.free && <small>free</small>}{p.command && found[p.command] && <i title="Installed on this computer" />}
            </button>
          ))}
        </div>

        <label className="field"><span>Name</span><input value={c.name} placeholder="What the crew calls it" onChange={(e) => put({ name: e.target.value })} /></label>
        {c.kind === 'cli' ? (
          <>
            <label className="field"><span>Command</span><input value={c.command} placeholder="aider, or /path/to/tool" onChange={(e) => put({ command: e.target.value })} /></label>
            <label className="field">
              <span>Arguments</span>
              <input value={c.args} placeholder="--message {prompt}" onChange={(e) => put({ args: e.target.value })} />
              <small>{'{prompt}'} is the request, {'{file}'} a file holding it, {'{model}'} and {'{cwd}'} as named. Leave them out to send the request on standard input.</small>
            </label>
            <div className="seg">
              <button className={c.output !== 'stream-json' ? 'on' : ''} onClick={() => put({ output: 'text' })}>Plain text out</button>
              <button className={c.output === 'stream-json' ? 'on' : ''} onClick={() => put({ output: 'stream-json' })}>Claude style JSON out</button>
            </div>
            <p className="hint">A command line connector runs with your permissions. The access mode in the composer cannot limit it, so pick tools you trust.</p>
          </>
        ) : (
          <>
            <label className="field"><span>Address</span><input value={c.base} placeholder="https://api.example.com/v1" onChange={(e) => put({ base: e.target.value })} /></label>
            <label className="field">
              <span>API key</span>
              <input type="password" value={key} placeholder={edit ? 'Saved in the keychain, type to replace' : 'Leave empty if the server needs none'} onChange={(e) => { setKey(e.target.value); setCheck(null) }} />
              <small>{keyUrl ? <>Get one at <a href={keyUrl} target="_blank" rel="noreferrer">{keyUrl.replace('https://', '')}</a>. </> : ''}Sealed with the system keychain.</small>
            </label>
            <label className="field">
              <span>Model</span>
              {check?.models?.length ? (
                <select value={c.model ?? ''} onChange={(e) => put({ model: e.target.value })}>
                  <option value="">Pick one</option>
                  {check.models.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              ) : <input value={c.model} placeholder="Test the connection to pick from a list" onChange={(e) => put({ model: e.target.value })} />}
            </label>
          </>
        )}

        <div className="row">
          <button className="btn small quiet" disabled={!ready || busy} onClick={test}>{busy ? <Loader size={10} /> : 'Test'}</button>
          {check && <span className={`checknote${check.ok ? '' : ' bad'}`}>{check.note}</span>}
          <span className="grow" />
          <button className="btn small quiet" onClick={close}>Cancel</button>
          <button className="btn small" disabled={!ready} onClick={save}>{edit ? 'Save' : 'Add'}</button>
        </div>
      </div>
    </div>
  )
}

export async function removeConnector(id: string, connectors: Connector[]) {
  await desk.call('keys:set', `conn:${id}`, '')
  await reload.settings({ connectors: connectors.filter((c) => c.id !== id) })
}
