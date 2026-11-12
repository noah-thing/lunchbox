import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { Loader, Mark } from '../ui/bits'
import { IconBack, IconBrowser, IconCamera, IconClose, IconCode, IconForward, IconReload, IconStop } from '../ui/icons'
import { agentOf, desk, reason, useApp } from '../lib/desk'
import { YOU } from '../../shared/tabs'

type Device = 'desktop' | 'tablet' | 'phone'
type Tab = { id: string; who: string; room?: string; url: string; title: string; loading: boolean; back: boolean; forward: boolean; device: Device; action?: string; busy: boolean }
type State = { tabs: Tab[]; active: string | null; shown: boolean }

const WIDTH: Record<Device, number> = { desktop: 0, tablet: 820, phone: 390 }
const BLANK: Tab = { id: YOU, who: YOU, url: '', title: '', loading: false, back: false, forward: false, device: 'desktop', busy: false }
const EMPTY: State = { tabs: [], active: null, shown: false }

export function useBrowser() {
  const [s, setS] = useState<State>(EMPTY)
  useEffect(() => {
    desk.call('browser').then((x) => x && setS(x))
    return desk.on('browser', setS)
  }, [])
  return s
}

// The native view is drawn above the whole window, so a dialog or sheet opened over the page would
// sit behind it. The view steps aside while one is up. Toasts and the update banner do not count:
// they come and go on their own, and the page blinking out for each would be worse than missing one.
const OVER = '.scrim, [role=dialog]'
function useOverlaid() {
  const [over, setOver] = useState(() => !!document.querySelector(OVER))
  useEffect(() => {
    const mo = new MutationObserver(() => setOver(!!document.querySelector(OVER)))
    mo.observe(document.body, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [])
  return over
}

// The page is a native view drawn into the hole this frame leaves. The frame tells the main
// process where the hole is whenever it moves, and takes the page away when it unmounts.
export function Browser({ say, covered }: { say: (t: string) => void; covered: boolean }) {
  const web = useBrowser()
  // The person's page is always there to go back to, even before it has opened anything.
  const tabs = web.tabs.some((t) => t.id === YOU) ? web.tabs : [BLANK, ...web.tabs]
  const s = tabs.find((t) => t.id === web.active) ?? tabs[0]
  const hole = useRef<HTMLDivElement>(null)
  const [typed, setTyped] = useState<string | null>(null)
  const [local, setLocal] = useState<{ port: number; title: string }[] | null>(null)
  const agents = useApp((x) => x.agents)
  const rooms = useApp((x) => x.rooms)
  const open = !!s.url
  const hidden = useOverlaid() || covered

  useEffect(() => { if (!open) desk.call('browser:local').then(setLocal, () => setLocal([])) }, [open])
  // What was being typed belongs to the page it was typed on.
  useEffect(() => setTyped(null), [s.id])

  useLayoutEffect(() => {
    const el = hole.current
    if (!el || !open || hidden) { desk.call('browser:place', null); return }
    const place = () => {
      const r = el.getBoundingClientRect()
      desk.call('browser:place', { x: r.left, y: r.top, width: r.width, height: r.height })
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    addEventListener('resize', place)
    return () => { ro.disconnect(); removeEventListener('resize', place) }
  }, [open, hidden, s.device])
  useEffect(() => () => { desk.call('browser:place', null) }, [])

  const go = async (e?: FormEvent, url = typed ?? '') => {
    e?.preventDefault()
    if (!url.trim()) return
    setTyped(null)
    try { await desk.call('browser:open', url.trim()) } catch (err) { say(reason(err)) }
  }
  const shot = async () => { try { await desk.call('browser:shot'); say('Screenshot saved to Downloads') } catch (e) { say(reason(e)) } }

  let host = '', rest = ''
  try { const u = new URL(s.url); host = u.host; rest = u.pathname + u.search === '/' ? '' : u.pathname + u.search } catch { host = s.url }
  const secure = s.url.startsWith('https://')
  const width = WIDTH[s.device]

  return (
    <div className={`browser${s.busy ? ' driven' : ''}`}>
      <div className="bbar">
        <span className="bnav">
          <button className="iconbtn" disabled={!s.back} onClick={() => desk.call('browser:nav', 'back')} aria-label="Back"><IconBack /></button>
          <button className="iconbtn" disabled={!s.forward} onClick={() => desk.call('browser:nav', 'forward')} aria-label="Forward"><IconForward /></button>
          <button className="iconbtn" disabled={!open} onClick={() => desk.call('browser:nav', s.loading ? 'stop' : 'reload')} aria-label={s.loading ? 'Stop' : 'Reload'}>{s.loading ? <IconStop /> : <IconReload />}</button>
        </span>
        <form className={`address${typed !== null ? ' editing' : ''}`} onSubmit={go}>
          {s.loading && <i className="bprogress" />}
          {typed === null && open ? (
            <button type="button" className="addr" onClick={() => setTyped(s.url)} title={s.url}>
              <span className={`lock${secure ? '' : ' open'}`}>{secure ? 'https' : 'http'}</span>
              <b>{host}</b><span className="path">{rest}</span>
            </button>
          ) : (
            <input autoFocus={typed !== null} value={typed ?? ''} onChange={(e) => setTyped(e.target.value)} onBlur={() => open && setTyped(null)} onKeyDown={(e) => e.key === 'Escape' && setTyped(null)} placeholder="Search or type a URL, localhost works" spellCheck={false} />
          )}
        </form>
        <span className="seg small">
          {(['desktop', 'tablet', 'phone'] as Device[]).map((d) => <button key={d} className={s.device === d ? 'on' : ''} onClick={() => desk.call('browser:device', d)}>{d[0].toUpperCase() + d.slice(1)}</button>)}
        </span>
        <button className="iconbtn" disabled={!open} onClick={shot} aria-label="Screenshot" title="Screenshot"><IconCamera /></button>
        <button className="iconbtn" disabled={!open} onClick={() => desk.call('browser:devtools')} aria-label="Developer tools" title="Developer tools"><IconCode /></button>
      </div>

      {tabs.length > 1 && (
        <div className="btabs" role="tablist" aria-label="Browser pages">
          {tabs.map((t) => {
            const agent = t.who === YOU ? null : agentOf(t.who, agents)
            const name = agent ? agent.short : 'You'
            const room = t.room ? rooms.find((r) => r.id === t.room)?.name : undefined
            const doing = t.action ?? (t.title || hostOf(t.url) || (agent ? 'Waiting' : 'New page'))
            return (
              <div key={t.id} className={`btab${t.id === s.id ? ' on' : ''}${t.busy ? ' busy' : ''}`}>
                <button role="tab" aria-selected={t.id === s.id} title={room ? `${name} in ${room}` : name} onClick={() => desk.call('browser:select', t.id)}>
                  {agent ? <Mark seed={agent.mark} size={13} active={t.busy} /> : <IconBrowser />}
                  <b>{name}</b>
                  <span>{doing}</span>
                </button>
                {(agent || t.url) && <button className="btabx" onClick={() => desk.call('browser:close', t.id)} aria-label={agent ? `Close ${name}'s page` : 'Close your page'} title="Close"><IconClose /></button>}
              </div>
            )
          })}
        </div>
      )}

      <div className="bstage">
        {open ? (
          <div className={`bdevice ${s.device}`} style={width ? ({ '--w': `${width}px` } as CSSProperties) : undefined}>
            <div ref={hole} className="bhole">{covered && <span className="quiet">The page is behind this window</span>}</div>
          </div>
        ) : (
          <div className="bstart">
            <pre className="bart" aria-hidden="true">{ART}</pre>
            <h2>A browser your agents can use</h2>
            <p>Open anything here, or let the crew do it: they read pages, click, type and take screenshots while you watch. Try asking a room to check the site you are building.</p>
            <form className="bstartform" onSubmit={go}>
              <input autoFocus value={typed ?? ''} onChange={(e) => setTyped(e.target.value)} placeholder="Search or type a URL" spellCheck={false} />
            </form>
            <div className="bquick">
              {local === null && <span className="quiet row"><Loader size={10} />Looking for local servers</span>}
              {local?.map((l) => (
                <button key={l.port} className="chip" onClick={() => go(undefined, `localhost:${l.port}`)}><i className="livedot" />localhost:{l.port}{l.title && <small>{l.title}</small>}</button>
              ))}
              {local?.length === 0 && <span className="quiet">No dev server running on the usual ports.</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const hostOf = (url: string) => { try { return new URL(url).host } catch { return '' } }

const ART = String.raw`
 .-----------------------------------.
 |  o o o   ( ..................  )  |
 |-----------------------------------|
 |   ##########     :::::::::::::    |
 |   ##########     :::::::::        |
 |   ##########     :::::::::::      |
 |                                   |
 |   [ ===== ]   [ ===== ]   [ === ] |
 '-----------------------------------'`
