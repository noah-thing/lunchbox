import { useState, type CSSProperties } from 'react'
import { PLAYBOOKS } from '../../shared/skills'
import type { Skill } from '../../shared/types'
import { Band } from '../ui/Band'
import { Loader, Mark } from '../ui/bits'
import { IconFolder } from '../ui/icons'
import { agentOf, ago, desk, short, unavailable, upcoming, useApp, type Access } from '../lib/desk'
import type { View } from '../App'
import { Composer } from './Composer'

const FEATURED = ['feature', 'deep', 'qa', 'launch']

// Below the composer: what is going on and where to pick up. Hidden on a fresh install so the
// first screen stays a single question.
function Glance({ go }: { go: (v: View) => void }) {
  const rooms = useApp((s) => s.rooms)
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

export function NewRoom({ onCreated, go, access, setAccess, workspace, setWorkspace, skill, pack: startPack, text }: {
  onCreated: (id: string) => void; go: (v: View) => void; access: Access; setAccess: (a: Access) => void; workspace: string; setWorkspace: (w: string) => void; skill?: Skill; pack?: string; text?: string
}) {
  const agents = useApp((s) => s.agents)
  const packs = useApp((s) => s.packs)
  const skills = useApp((s) => s.skills)
  const settings = useApp((s) => s.settings)
  const usable = agents.filter((a) => !unavailable(a)).sort((a, b) => Number(b.tools) - Number(a.tools)).map((a) => a.id)
  const [chosen, setChosen] = useState<string[] | null>(() => (skill && skill.crew.every((c) => usable.includes(c)) ? skill.crew : null))
  const crew = chosen ?? defaultCrew(usable, settings.defaultCrew)
  const [pack, setPack] = useState<string | undefined>(skill?.pack ?? startPack)
  const [draft, setDraft] = useState<{ text: string; n: number } | undefined>(() => (skill ? { text: skillText(skill), n: 1 } : text ? { text, n: 1 } : undefined))
  const useSkill = (s: Skill) => {
    if (s.crew.every((c) => usable.includes(c))) setChosen(s.crew)
    if (s.pack) setPack(s.pack)
    setDraft({ text: skillText(s), n: Date.now() })
  }
  const [arena, setArena] = useState(false)
  const [starting, setStarting] = useState(false)
  const current = packs.find((p) => p.id === pack)
  const ideas = current?.ideas ?? ['Review this folder and tell me what to fix first', 'Research a topic with sources', 'Build a small tool and test it']

  const start = async (text: string, files?: string[]) => {
    if (!crew.length || starting) return
    setStarting(true)
    const meta = await desk.call('room:create', { crew, workspace, pack })
    if (!meta) return setStarting(false)
    await desk.call('room:send', meta.id, text, access, arena, files)
    onCreated(meta.id)
  }
  const shownPacks = packs.filter((p, i) => i < 4 || p.id === pack)
  const morePacks = packs.filter((p) => !shownPacks.includes(p))
  const pick = async () => { const p = await desk.call('pick'); if (p) setWorkspace(p) }
  const label = crew.length ? crew.map((id) => agentOf(id, agents).bin ?? agentOf(id, agents).short.toLowerCase()).join(' + ') : 'no agents yet'

  return (
    <div className={`newroom${starting ? ' starting' : ''}`}>
      <div className="newbody">
        <Band rows={9} label={label} busy={starting} />
        <h1 className="rise" style={{ '--i': 1 } as CSSProperties}>What are we working on?</h1>
        <div className="rise" style={{ '--i': 2 } as CSSProperties}>
          {crew.length ? (
            <Composer crew={crew} setCrew={setChosen} onSend={start} access={access} setAccess={setAccess} draft={draft} arena={arena} setArena={setArena} pack={pack} folder={workspace}
              placeholder="Describe the goal in your own words. The crew plans it, splits it up and checks each other’s work." />
          ) : (
            <div className="noagents">
              <b>No agent is ready yet.</b>
              <span>Install Claude Code, Codex, Grok or Gemini CLI, or add an API key in Agents. Lunchbox picks them up on its own.</span>
            </div>
          )}
        </div>
        <div className="newmeta rise" style={{ '--i': 3 } as CSSProperties}>
          <button className="chip mono" onClick={pick} title={workspace}><IconFolder />{short(workspace) || 'Choose a folder'}</button>
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
