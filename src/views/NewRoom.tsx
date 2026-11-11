import { useState, type CSSProperties } from 'react'
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

const skillText = (s: Skill) => `${s.brief}\n\nSteps that worked last time:\n${s.steps.map((x) => `- ${x}`).join('\n')}`

export function NewRoom({ onCreated, go, say, access, setAccess, workspace, setWorkspace, skill, pack: startPack, text }: {
  say: (t: string) => void
  onCreated: (id: string) => void; go: (v: View) => void; access: Access; setAccess: (a: Access) => void; workspace: string; setWorkspace: (w: string) => void; skill?: Skill; pack?: string; text?: string
}) {
  const agents = useApp((s) => s.agents)
  const packs = useApp((s) => s.packs)
  const skills = useApp((s) => s.skills)
  const settings = useApp((s) => s.settings)
  const env = useApp((s) => s.env)
  const usable = agents.filter((a) => !unavailable(a)).sort((a, b) => Number(b.tools) - Number(a.tools)).map((a) => a.id)
  const [chosen, setChosen] = useState<string[] | null>(() => (skill && skill.crew.every((c) => usable.includes(c)) ? skill.crew : null))
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
  const [studio, setStudio] = useState(() => { try { return localStorage.getItem('lb.studio') === '1' } catch { return false } })
  const pickStudio = (on: boolean) => { setStudio(on); try { localStorage.setItem('lb.studio', on ? '1' : '0') } catch {} }
  const [starting, setStarting] = useState(false)
  const current = packs.find((p) => p.id === pack)
  const ideas = current?.ideas ?? ['Review this folder and tell me what to fix first', 'Research a topic with sources', 'Build a small tool and test it']

  const start = async (text: string, files?: string[]) => {
    if (!crew.length || starting) return
    setStarting(true)
    // If the room can't be made, the person keeps what they wrote and hears why.
    try {
      const meta = await desk.call('room:create', { crew, workspace, pack, about: text, studio })
      if (!meta) throw new Error('The room could not be created. Check that the folder can be written to.')
      if (workspace) remember(workspace)
      await desk.call('room:send', meta.id, text, access, arena, files)
      onCreated(meta.id)
    } catch (e) {
      setStarting(false)
      setDraft({ text, files, n: Date.now() })
      say(reason(e))
    }
  }
  const shownPacks = packs.filter((p, i) => i < 4 || p.id === pack)
  const morePacks = packs.filter((p) => !shownPacks.includes(p))
  const pick = async () => { const p = await desk.call('pick'); if (p) setWorkspace(p) }
  const recent = recents().filter((r) => r !== workspace)
  const label = crew.length ? crew.map((id) => agentOf(id, agents).bin ?? agentOf(id, agents).short.toLowerCase()).join(' + ') : 'no agents yet'

  return (
    <div className={`newroom${starting ? ' starting' : ''}`}>
      <div className="newbody">
        <Band rows={9} label={label} busy={starting} patterned />
        <h1 className="rise" style={{ '--i': 1 } as CSSProperties}>What are we working on?</h1>
        <div className="rise" style={{ '--i': 2 } as CSSProperties}>
          {crew.length ? (
            <Composer crew={crew} setCrew={setChosen} onSend={start} access={access} setAccess={setAccess} draft={draft} arena={arena} setArena={setArena} studio={studio} setStudio={pickStudio} pack={pack} folder={workspace}
              placeholder="Describe the goal in your own words. The crew plans it, splits it up and checks each other’s work." />
          ) : (
            <div className="noagents">
              <b>No agent is ready yet.</b>
              <span>Install Claude Code, Codex, Grok or Gemini CLI, or add an API key or a local model. Lunchbox picks them up on its own.</span>
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
            <select className="chip select" value="" onChange={(e) => e.target.value && setPack(e.target.value)} aria-label="More packs">
              <option value="">More</option>
              {morePacks.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
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
                <b>{s.name}</b><span>{s.steps.length} steps</span>
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
  try { return JSON.parse(localStorage.getItem('lb.recentFolders') ?? '[]') } catch { return [] }
}
function remember(folder: string) {
  try { localStorage.setItem('lb.recentFolders', JSON.stringify([folder, ...recents().filter((f) => f !== folder)].slice(0, 6))) } catch {}
}
