import { useEffect, useState } from 'react'
import type { Report } from '../../shared/types'
import { Loader } from '../ui/bits'
import { IconClose } from '../ui/icons'
import { desk, reason } from '../lib/desk'
import type { ReportOpen } from '../lib/report'

const KINDS: { id: Report['kind']; name: string; hint: string }[] = [
  { id: 'bug', name: 'Something broke', hint: 'What were you doing, and what happened instead?' },
  { id: 'idea', name: 'An idea', hint: 'What would make Lunchbox better for you?' },
  { id: 'question', name: 'A question', hint: 'Ask anything about how Lunchbox works.' },
]

// The beta report sheet. It goes straight to the people building Lunchbox, with the version,
// the system and recent errors attached so nobody has to ask for them. Closes on the X, Cancel,
// a click outside or Escape.
export function ReportSheet({ open, close, say }: { open: ReportOpen; close: () => void; say: (t: string) => void }) {
  const [kind, setKind] = useState<Report['kind']>(open.kind ?? (open.context ? 'bug' : 'bug'))
  const [text, setText] = useState('')
  const [contact, setContact] = useState('')
  const [attach, setAttach] = useState(true)
  const [diag, setDiag] = useState('')
  const [sending, setSending] = useState(false)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    desk.call('report:diagnostics').then((d: string) => setDiag(d ?? '')).catch(() => {})
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    addEventListener('keydown', esc)
    return () => removeEventListener('keydown', esc)
  }, [])
  const send = async () => {
    setSending(true)
    try {
      const r = await desk.call('report:send', { kind, text: text.trim(), contact: contact.trim() || undefined, context: open.context, diagnostics: attach ? diag : undefined } satisfies Report)
      say(r?.ok ? 'Sent. Thank you, this goes straight to the people building Lunchbox.' : 'Saved. You are offline right now, so it goes out the next time Lunchbox starts.')
      close()
    } catch (e) {
      say(reason(e))
      setSending(false)
    }
  }
  return (
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="sheetcard report" role="dialog" aria-label="Send feedback">
        <header className="row">
          <div className="grow"><h2>Lunchbox beta</h2><p className="quiet">You are one of the first to use it. Tell us what breaks and what you want.</p></div>
          <button className="iconbtn" onClick={close} aria-label="Close"><IconClose /></button>
        </header>
        <div className="kinds">
          {KINDS.map((k) => <button key={k.id} className={kind === k.id ? 'on' : ''} onClick={() => setKind(k.id)}><b>{k.name}</b></button>)}
        </div>
        {open.context && <pre className="reportctx">{open.context}</pre>}
        <label className="field">
          <span>{KINDS.find((k) => k.id === kind)!.hint}</span>
          <textarea autoFocus rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={open.context ? 'Anything you remember about what led up to it helps.' : 'A sentence or two is plenty.'} />
        </label>
        <label className="field">
          <span>Email or X handle, if you want an answer</span>
          <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Optional" />
        </label>
        <div className="attachline">
          <label><input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} /> Attach the version, system and recent errors</label>
          <button className="linkbtn" onClick={() => setShown(!shown)}>{shown ? 'Hide' : 'See what is sent'}</button>
        </div>
        {shown && <pre className="reportctx">{diag || 'Nothing yet.'}</pre>}
        <div className="row">
          <span className="grow hint">No file contents, keys or conversations are sent unless you write them here.</span>
          <button className="btn small quiet" onClick={close}>Cancel</button>
          <button className="btn small" disabled={sending || (!text.trim() && !open.context)} onClick={send}>{sending ? <Loader size={10} /> : 'Send'}</button>
        </div>
      </div>
    </div>
  )
}
