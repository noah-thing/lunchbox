import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Report } from '../../shared/types'
import { Loader } from '../ui/bits'
import { IconClose } from '../ui/icons'
import { Toggle } from './Flows'
import { desk, mod, reason } from '../lib/desk'
import type { ReportOpen } from '../lib/report'

const KINDS: { id: Report['kind']; name: string; ask: string; icon: ReactNode }[] = [
  { id: 'bug', name: 'Something broke', ask: 'What were you doing, and what happened instead?', icon: <svg viewBox="0 0 16 16"><path d="M8 2.5v1.2M5.6 4.4 4.5 3.3M10.4 4.4l1.1-1.1M4.5 8H2.5M13.5 8h-2M4.6 11.6l-1.4 1.1M11.4 11.6l1.4 1.1" /><rect x="4.75" y="4.75" width="6.5" height="8.25" rx="3.25" /></svg> },
  { id: 'idea', name: 'An idea', ask: 'What would make Lunchbox better for you?', icon: <svg viewBox="0 0 16 16"><path d="M6 12.5h4M6.5 14.5h3M8 1.75a4.25 4.25 0 0 0-2.4 7.76c.5.35.9.9.9 1.5v.49h3v-.49c0-.6.4-1.15.9-1.5A4.25 4.25 0 0 0 8 1.75z" /></svg> },
  { id: 'question', name: 'A question', ask: 'Ask anything about how Lunchbox works.', icon: <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.25" /><path d="M6.2 6.3a1.85 1.85 0 1 1 2.6 1.7c-.5.22-.8.66-.8 1.2v.3" /><circle cx="8" cy="11.4" r=".2" strokeWidth="1.6" /></svg> },
]

// Feedback for the beta. It goes to the people building Lunchbox with the version, the system and
// recent errors attached, so nobody has to ask for them. Closes on the X, Cancel, a click outside
// or Escape; ⌘Enter sends.
export function ReportSheet({ open, close, say }: { open: ReportOpen; close: () => void; say: (t: string) => void }) {
  const [kind, setKind] = useState<Report['kind']>(open.kind ?? 'bug')
  const [text, setText] = useState('')
  const [contact, setContact] = useState('')
  const [attach, setAttach] = useState(true)
  const [diag, setDiag] = useState('')
  const [peek, setPeek] = useState(false)
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'queued'>('idle')
  const area = useRef<HTMLTextAreaElement>(null)
  const ready = !!(text.trim() || open.context)
  const k = KINDS.find((x) => x.id === kind)!

  const send = async () => {
    if (!ready || state !== 'idle') return
    setState('sending')
    try {
      const r = await desk.call('report:send', { kind, text: text.trim(), contact: contact.trim() || undefined, context: open.context, diagnostics: attach ? diag : undefined } satisfies Report)
      setState(r?.ok ? 'sent' : 'queued')
      setTimeout(close, 1800)
    } catch (e) {
      say(reason(e))
      setState('idle')
    }
  }
  useEffect(() => {
    desk.call('report:diagnostics').then((d: string) => setDiag(d ?? '')).catch(() => {})
    area.current?.focus()
  }, [])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() }
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  })

  return (
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="sheetcard fb" role="dialog" aria-label="Send feedback">
        {state === 'sent' || state === 'queued' ? (
          <div className="fbdone">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.5" /><path d="M7.5 12.3l3 3 6-6.3" /></svg>
            <b>{state === 'sent' ? 'Thank you, it is on its way' : 'Saved for later'}</b>
            <span>{state === 'sent' ? 'It goes straight to the people building Lunchbox.' : 'You are offline, so it goes out the next time Lunchbox starts.'}</span>
          </div>
        ) : (
          <>
            <header className="fbhead">
              <div className="grow">
                <h2>Send feedback <span className="fbtag">Beta</span></h2>
                <p>You are one of the first to use Lunchbox. Tell us what breaks and what you want.</p>
              </div>
              <button className="iconbtn" onClick={close} aria-label="Close"><IconClose /></button>
            </header>

            <div className="fbkinds" role="radiogroup" aria-label="Kind" style={{ '--at': KINDS.indexOf(k) } as CSSProperties}>
              <i className="fbpill" aria-hidden />
              {KINDS.map((x) => (
                <button key={x.id} role="radio" aria-checked={kind === x.id} className={kind === x.id ? 'on' : ''} onClick={() => { setKind(x.id); area.current?.focus() }}>
                  {x.icon}{x.name}
                </button>
              ))}
            </div>

            {open.context && (
              <div className="fbctx">
                <span>What the app showed</span>
                <pre>{open.context}</pre>
              </div>
            )}

            <label className="fbbox">
              <span>{k.ask}</span>
              <textarea ref={area} rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={open.context ? 'Anything you remember about what led up to it helps.' : 'A sentence or two is plenty.'} />
            </label>

            <label className="fbline">
              <span>Reply to</span>
              <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Email or X handle, if you want an answer" />
            </label>

            <div className="fbattach">
              <div className="grow">
                <b>Include system details</b>
                <span>The version, your system and recent errors. <button className="linkbtn" onClick={() => setPeek(!peek)}>{peek ? 'Hide' : 'See exactly what is sent'}</button></span>
              </div>
              <Toggle on={attach} set={setAttach} label="Include system details" />
            </div>
            {peek && <pre className="fbpeek">{attach ? diag || 'Nothing recorded yet.' : 'Nothing extra is sent.'}</pre>}

            <footer className="fbfoot">
              <span className="grow">No files, keys or conversations are sent unless you write them here.</span>
              <button className="btn small quiet" onClick={close}>Cancel</button>
              <button className="btn small fbsend" disabled={!ready || state === 'sending'} onClick={send}>
                {state === 'sending' ? <Loader size={10} /> : <>Send <kbd>{mod}↵</kbd></>}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
