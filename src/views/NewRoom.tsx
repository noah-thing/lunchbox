import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { PLAYBOOKS } from '../../shared/skills'
import type { Skill } from '../../shared/types'
import { Band } from '../ui/Band'
import { Loader, Mark } from '../ui/bits'
import { IconFolder, IconFolderPlus } from '../ui/icons'
import { Menu } from '../ui/Access'
import { agentOf, ago, desk, machine, short, unavailable, upcoming, useApp, type Access, reason } from '../lib/desk'
import type { View } from '../App'
import { Composer } from './Composer'

const FEATURED = ['feature', 'deep', 'qa', 'launch']

// Below the composer: what is going on and where to pick up. Hidden on a fresh install so the
// first screen stays a single question.
function Glance({ go }: { go: (v: View) => void }) {
  const rooms = useApp((s) => s.rooms).filter((r) => !r.archived)
  const flows = useApp((s) => s.flows)
  const running = useApp((s) => s.running)
  const agents = useApp((s) => s.agents)
  const recent = [...rooms].sort((a, b) => Number(b.waiting) - Number(a.waiting) || Number(b.busy) - Number(a.busy) || b.updated - a.updated).slice(0, 3)
  const next = flows.filter((f) => f.on && f.next).sort((a, b) => a.next! - b.next!).slice(0, 3)
  const featured = FEATURED.map((id) => PLAYBOOKS.find((p) => p.id === id)!).filter(Boolean)
  if (!rooms.length && !flows.length) return null
  return (
    <div className="glance rise" style={{ '--i': 6 } as CSSProperties}>
      <section>
        <h3>Continue</h3>
        {recent.map((r) => (
          <button key={r.id} className="glancerow" onClick={() => go({ name: 'room', id: r.id })}>
            <span className="crewmarks">{r.crew.slice(0, 3).map((id) => <Mark key={id} seed={agentOf(id, agents).mark} size={12} />)}</span>
            <span className="grow">{r.name}</span>
            {r.waiting ? <i className="tag warn">needs you</i> : r.busy ? <Loader size={10} /> : <small>{ago(r.updated)}</small>}
          </button>
        ))}
      </section>
      <section>
        <h3>Scheduled</h3>
        {running.map((r) => {
          const f = flows.find((x) => x.id === r.flow)
          return <button key={r.room} className="glancerow" onClick={() => go({ name: 'room', id: r.room })}><Loader size={10} /><span className="grow">{f?.name}</span><small>step {r.step}/{r.of}</small></button>
        })}
        {next.map((f) => <button key={f.id} className="glancerow" onClick={() => go({ name: 'flows', edit: f.id })}><span className="grow">{f.name}</span><small>{upcoming(f.next!)}</small></button>)}
        {!next.length && !running.length && <button className="glancerow dim" onClick={() => go({ name: 'flows' })}><span className="grow">Nothing scheduled. Set up a flow</span></button>}
      </section>
      <section>
        <h3>Playbooks</h3>
        {featured.map((p) => <button key={p.id} className="glancerow" onClick={() => go({ name: 'library' })}><span className="grow">{p.name}</span><small>{p.field}</small></button>)}
      </section>
    </div>
  )
}

function defaultCrew(ids: string[], preferred: string[]) {
  const fromSettings = preferred.filter((id) => ids.includes(id))
  if (fromSettings.length) return fromSettings
  return ids.slice(0, 3)
}

// The page is centred, so anything that changes its height, a longer message or a second row of
// ideas, moves all of it. It travels to its new place instead of jumping there. A window being
// resized moves it every frame and takes its places.
function useSettle() {
  const body = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    let top = el.offsetTop
    let win = `${innerWidth} ${innerHeight}`
    const born = performance.now()
    const ro = new ResizeObserver(() => {
      const was = top + new DOMMatrix(getComputedStyle(el).transform).m42
      const same = win === `${innerWidth} ${innerHeight}`
      top = el.offsetTop
      win = `${innerWidth} ${innerHeight}`
      // The first second belongs to the page rising in.
      if (!same || Math.abs(was - top) < 1 || performance.now() - born < 1000 || matchMedia('(prefers-reduced-motion: reduce)').matches) return
      for (const a of el.getAnimations()) if (a.id === 'settle') a.cancel()
      el.animate([{ transform: `translateY(${was - top}px)` }, { transform: 'none' }], { id: 'settle', duration: 260, easing: 'cubic-bezier(.23,1,.32,1)' })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return body
}

const skillText = (s: Skill) => `${s.brief}\n\nSteps that worked last time:\n${s.steps.map((x) => `- ${x}`).join('\n')}`

export function NewRoom({ onCreated, go, say, access, setAccess, workspace, setWorkspace, skill, pack: startPack, text, send, suggested }: {
  say: (t: string) => void
  onCreated: (id: string) => void; go: (v: View) => void; access: Access; setAccess: (a: Access) => void; workspace: string; setWorkspace: (w: string) => void; skill?: Skill; pack?: string; text?: string; send?: boolean; suggested?: string[]
}) {
  const agents = useApp((s) => s.agents)
  const packs = useApp((s) => s.packs)
  const skills = useApp((s) => s.skills)
  const settings = useApp((s) => s.settings)
  const env = useApp((s) => s.env)
  const usable = agents.filter((a) => !unavailable(a)).sort((a, b) => Number(b.tools) - Number(a.tools)).map((a) => a.id)
  // A playbook's crew is taken as far as those agents are set up here; with none of them, the usual crew.
  const [chosen, setChosen] = useState<string[] | null>(() => {
    if (skill && skill.crew.every((c) => usable.includes(c))) return skill.crew
    const ready = (suggested ?? []).filter((c) => usable.includes(c))
    return ready.length ? ready : null
  })
  const crew = chosen ?? defaultCrew(usable, settings.defaultCrew)
  const [pack, setPack] = useState<string | undefined>(skill?.pack ?? startPack)
  const [draft, setDraft] = useState<{ text: string; files?: string[]; n: number } | undefined>(() => (skill ? { text: skillText(skill), n: 1 } : text ? { text, n: 1 } : undefined))
  const useSkill = (s: Skill) => {
    if (s.crew.every((c) => usable.includes(c))) setChosen(s.crew)
    if (s.pack) setPack(s.pack)
    setDraft({ text: skillText(s), n: Date.now() })
  }
  const [arena, setArena] = useState(false)
  // Studio carries over from the last room started, so someone who works that way keeps it on.
  // Expert costs more turns, so every new room starts without it and it is switched on per room.
  const [studio, setStudio] = useState(false)
  const [starting, setStarting] = useState(false)
  const made = useRef<{ id: string } | null>(null)
  const current = packs.find((p) => p.id === pack)
  const ideas = current?.ideas ?? ['Review this folder and tell me what to fix first', 'Research a topic with sources', 'Build a small tool and test it']

  const start = async (text: string, files?: string[]) => {
    if (!crew.length || starting) return
    setStarting(true)
    // If the room can't be made, the person keeps what they wrote and hears why.
    try {
      // A room made by an earlier try whose message failed is used again, not left empty beside a new one.
      const meta = made.current ?? await desk.call('room:create', { crew, workspace, pack, about: text, studio })
      if (!meta) throw new Error('The room could not be created. Check that the folder can be written to.')
      made.current = meta
      if (workspace) remember(workspace)
      await desk.call('room:send', meta.id, text, access, arena, files)
      onCreated(meta.id)
    } catch (e) {
      setStarting(false)
      setDraft({ text, files, n: Date.now() })
      say(reason(e))
    }
  }
  // A room opened to send a message straight away, such as making a theme with an agent, sends it
  // the moment the crew is known.
  const sent = useRef(false)
  useEffect(() => {
    if (!send || !text || sent.current || !crew.length) return
    sent.current = true
    start(text)
  })
  // Three packs sit beside General and the rest are behind More, which carries the name of the one
  // picked from it. The row is the same length whatever is chosen, so it never wraps.
  const shownPacks = packs.slice(0, 3)
  const morePacks = packs.slice(3)
  const picked = morePacks.find((p) => p.id === pack)
  const pick = async () => { const p = await desk.call('pick'); if (p) setWorkspace(p) }
  const recent = recents().filter((r) => r !== workspace)
  const body = useSettle()
  const label = crew.length ? crew.map((id) => agentOf(id, agents).bin ?? agentOf(id, agents).short.toLowerCase()).join(' + ') : 'no agents yet'

  return (
    <div className={`newroom${starting ? ' starting' : ''}`}>
      <div className="newbody" ref={body}>
        <Band rows={9} label={label} busy={starting} patterned />
        <h1 className="rise" style={{ '--i': 1 } as CSSProperties}>What are we working on?</h1>
        <div className="rise" style={{ '--i': 2 } as CSSProperties}>
          {crew.length ? (
            <Composer crew={crew} setCrew={setChosen} onSend={start} access={access} setAccess={setAccess} draft={draft} arena={arena} setArena={setArena} studio={studio} setStudio={setStudio} pack={pack} folder={workspace}
              placeholder="Describe the goal in your own words. The crew plans it, splits it up and checks each other’s work." />
          ) : (
            <div className="noagents">
              <b>No agent is ready yet.</b>
              <span>Install Claude Code, Codex, Grok or Antigravity, or add an API key or a local model. Lunchbox picks them up on its own.</span>
              <button className="btn small" onClick={() => go({ name: 'agents' })}>Set up an agent</button>
            </div>
          )}
        </div>
        <div className="newmeta rise" style={{ '--i': 3 } as CSSProperties}>
          <Menu label="Where the room works" className="foldermenu" button={<><IconFolder />{workspace ? <span className="mono">{short(workspace)}</span> : 'New folder for this room'}</>}>
            {(close) => (
              <>
                <button className={`item${!workspace ? ' on' : ''}`} onClick={() => { setWorkspace(''); close() }}>
                  <IconFolderPlus />
                  <span className="grow"><b>New folder for this room</b><span>Inside {short(env.cwd)}, named after what you ask</span></span>
                </button>
                {recent.slice(0, 4).map((r) => (
                  <button key={r} className="item" onClick={() => { setWorkspace(r); close() }}>
                    <IconFolder />
                    <span className="grow"><b className="mono">{short(r)}</b><span>Used recently</span></span>
                  </button>
                ))}
                <button className="item" onClick={() => { close(); pick() }}>
                  <IconFolder />
                  <span className="grow"><b>Choose a folder…</b><span>An existing project on {machine()}</span></span>
                </button>
              </>
            )}
          </Menu>
          <span className="divider" />
          <button className={`chip${!pack ? ' on' : ''}`} onClick={() => setPack(undefined)}>General</button>
          {shownPacks.map((p) => <button key={p.id} className={`chip${pack === p.id ? ' on' : ''}`} onClick={() => setPack(p.id)} title={p.line}>{p.name}</button>)}
          {morePacks.length > 0 && (
            <Menu label="More packs" className={`packmenu${picked ? ' on' : ''}`} button={<span className="pilltext">{picked?.name ?? 'More'}</span>}>
              {(close) => morePacks.map((p) => (
                <button key={p.id} role="menuitemradio" aria-checked={pack === p.id} className={`item${pack === p.id ? ' on' : ''}`} onClick={() => { setPack(p.id); close() }}>
                  <span className="grow"><b>{p.name}</b><span>{p.line}</span></span>
                </button>
              ))}
            </Menu>
          )}
        </div>
        <div className="ideas rise" style={{ '--i': 4 } as CSSProperties}>
          {ideas.map((i) => <button key={i} onClick={() => setDraft({ text: i, n: Date.now() })}>{i}</button>)}
        </div>
        {skills.length > 0 && (
          <div className="skills rise" style={{ '--i': 5 } as CSSProperties}>
            <span className="label">Your skills</span>
            {skills.slice(0, 4).map((s) => (
              <button key={s.id} onClick={() => useSkill(s)}>
                <b>{s.name}</b><span>{s.steps.length} step{s.steps.length === 1 ? '' : 's'}</span>
              </button>
            ))}
          </div>
        )}
        <Glance go={go} />
      </div>
    </div>
  )
}

// Folders you picked before, newest first. A convenience kept on this machine only.
function recents(): string[] {
  try { const list = JSON.parse(localStorage.getItem('lb.recentFolders') ?? '[]'); return Array.isArray(list) ? list.filter((f) => typeof f === 'string') : [] } catch { return [] }
}
function remember(folder: string) {
  try { localStorage.setItem('lb.recentFolders', JSON.stringify([folder, ...recents().filter((f) => f !== folder)].slice(0, 6))) } catch {}
}
