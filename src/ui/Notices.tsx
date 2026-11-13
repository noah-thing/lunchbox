import { useEffect, useState } from 'react'
import { useModal } from '../lib/modal'
import type { Notice, UpdateState } from '../../shared/types'
import { IconClose } from './icons'
import { desk, useApp } from '../lib/desk'

// Messages pushed from the signed feed, and the app's own update state, in three forms: a toast in
// the corner, a designed card for big news, and a banner across the top of the page.
export function Notices() {
  const [list, setList] = useState<Notice[]>([])
  const [update, setUpdate] = useState<UpdateState>({ state: 'idle' })
  const [later, setLater] = useState(false)
  // Restarting stops every agent, so a restart asked for mid task waits until the rooms are quiet.
  const busy = useApp((s) => s.rooms.some((r) => r.busy))
  const [queued, setQueued] = useState(false)
  const restart = () => { dispatchEvent(new CustomEvent('lb:restarting')); desk.call('update:install') }
  useEffect(() => { if (queued && !busy && update.state === 'ready') restart() }, [queued, busy, update.state])
  useEffect(() => {
    desk.call('notices').then((n: Notice[]) => setList(n ?? [])).catch(() => {})
    desk.call('update').then((u: UpdateState) => u && setUpdate(u)).catch(() => {})
    const a = desk.on('notices', (n) => setList((n as Notice[]) ?? []))
    const b = desk.on('update', (u) => setUpdate((old) => {
      const next = u as UpdateState
      // "Later" holds until a different version turns up, not until the next routine check.
      if ('version' in next && (!('version' in old) || old.version !== next.version)) setLater(false)
      return next
    }))
    return () => { a(); b() }
  }, [])
  const dismiss = (id: string) => { setList((l) => l.filter((n) => n.id !== id)); desk.call('notice:dismiss', id) }
  // lunchbox:update installs the waiting update, or fetches it first; anything else is a web link.
  const go = (n: Notice) => {
    if (n.action?.url === 'lunchbox:update') {
      if (update.state === 'ready') { if (busy) setQueued(true); else restart() }
      else if (update.state === 'available') desk.call('update:download')
      else if (update.state === 'manual') window.open(update.url, '_blank')
      else desk.call('update:check')
    } else if (n.action) window.open(n.action.url, '_blank')
    dismiss(n.id)
  }
  // The first time a version is ready, it gets a card with one button; after that the bar is enough.
  const [seen, setSeen] = useState(() => { try { return localStorage.getItem('lb.updateCard') ?? '' } catch { return '' } })
  const ready1 = update.state === 'ready' && seen !== update.version ? update.version : ''
  const closeCard = () => { setSeen(ready1); try { localStorage.setItem('lb.updateCard', ready1) } catch {} }
  // It waits while another dialog is open, so it never lands on top of one, and Escape closes it.
  const [clear, setClear] = useState(false)
  useEffect(() => {
    if (!ready1) return
    const look = () => setClear(!document.querySelector('.scrim:not(.updscrim)'))
    look()
    const t = setInterval(look, 800)
    return () => clearInterval(t)
  }, [ready1])

  const card = list.find((n) => n.kind === 'card')
  const showUpdate = !!ready1 && !card && clear
  useModal(showUpdate || !!card)
  useEffect(() => {
    if (!showUpdate) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeCard() }
    addEventListener('keydown', esc)
    return () => removeEventListener('keydown', esc)
  })
  const banner = list.find((n) => n.kind === 'banner')
  const toasts = list.filter((n) => n.kind === 'toast').slice(0, 3)
  const ready = !later && (update.state === 'ready' || update.state === 'manual' || update.state === 'available' || update.state === 'downloading')

  return (
    <>
      {ready ? (
        <div className="nbanner" role="status">
          <span className="grow">{update.state === 'ready' ? `Lunchbox ${update.version} is ready. It installs when you restart.` : update.state === 'downloading' ? `Downloading Lunchbox ${update.version}${update.progress ? `, ${Math.round(update.progress * 100)}%` : ''}` : `Lunchbox ${update.version} is out.`}</span>
          {update.state === 'ready' && (busy
            ? <button className="btn small" onClick={() => setQueued(true)} disabled={queued}>{queued ? 'Restarts when your agents finish' : 'Restart when agents finish'}</button>
            : <button className="btn small" onClick={restart}>Restart now</button>)}
          {update.state === 'available' && <button className="btn small" onClick={() => desk.call('update:download')}>Get it</button>}
          {update.state === 'manual' && <button className="btn small" onClick={() => window.open(update.url, '_blank')}>Download</button>}
          <button className="iconbtn" onClick={() => setLater(true)} aria-label="Later"><IconClose /></button>
        </div>
      ) : banner && (
        <div className="nbanner" role="status">
          <span className="grow"><b>{banner.title}</b>{banner.body && <span> {banner.body}</span>}</span>
          {banner.action && <button className="btn small" onClick={() => go(banner)}>{banner.action.label}</button>}
          <button className="iconbtn" onClick={() => dismiss(banner.id)} aria-label="Close"><IconClose /></button>
        </div>
      )}
      {toasts.length > 0 && (
        <div className="ntoasts">
          {toasts.map((n) => (
            <div key={n.id} className="ntoast" role="status">
              <div className="grow"><b>{n.title}</b>{n.body && <p>{n.body}</p>}{n.action && <button className="linkbtn" onClick={() => go(n)}>{n.action.label}</button>}</div>
              <button className="iconbtn" onClick={() => dismiss(n.id)} aria-label="Close"><IconClose /></button>
            </div>
          ))}
        </div>
      )}
      {showUpdate && (
        <div className="scrim center updscrim" onMouseDown={(e) => e.target === e.currentTarget && closeCard()}>
          <div className="ncard nupdate" role="dialog" aria-label={`Lunchbox ${ready1} is ready`}>
            <button className="iconbtn nclose" onClick={closeCard} aria-label="Close"><IconClose /></button>
            <div className="nbody">
              <span className="nkicker">Update</span>
              <h2>Lunchbox {ready1} is ready</h2>
              <p>It has downloaded in the background. Restart to finish; your rooms open again where you left them.</p>
              <div className="row">
                <span className="grow" />
                <button className="btn small quiet" onClick={closeCard}>Later</button>
                {busy
                  ? <button className="btn small" onClick={() => { setQueued(true); closeCard() }} disabled={queued}>{queued ? 'Restarts when your agents finish' : 'Restart when agents finish'}</button>
                  : <button className="btn small" autoFocus onClick={() => { closeCard(); restart() }}>Restart and update</button>}
              </div>
            </div>
          </div>
        </div>
      )}
      {card && (
        <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && dismiss(card.id)}>
          <div className="ncard" role="dialog" aria-label={card.title}>
            {card.image && <img src={card.image} alt="" />}
            <button className="iconbtn nclose" onClick={() => dismiss(card.id)} aria-label="Close"><IconClose /></button>
            <div className="nbody">
              <h2>{card.title}</h2>
              {card.body && <p>{card.body}</p>}
              <div className="row">
                <span className="grow" />
                <button className="btn small quiet" onClick={() => dismiss(card.id)}>Close</button>
                {card.action && <button className="btn small" onClick={() => go(card)}>{card.action.label}</button>}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
