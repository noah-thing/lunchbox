import { useState, type CSSProperties } from 'react'
import type { Skill } from '../../shared/types'
import { Band } from '../ui/Band'
import { IconFolder } from '../ui/icons'
import { agentOf, desk, short, unavailable, useApp, type Access } from '../lib/desk'
import { Composer } from './Composer'

function defaultCrew(ids: string[], preferred: string[]) {
  const fromSettings = preferred.filter((id) => ids.includes(id))
  if (fromSettings.length) return fromSettings
  return ids.slice(0, 3)
}

const skillText = (s: Skill) => `${s.brief}\n\nSteps that worked last time:\n${s.steps.map((x) => `- ${x}`).join('\n')}`

export function NewRoom({ onCreated, access, setAccess, workspace, setWorkspace, skill }: {
  onCreated: (id: string) => void; access: Access; setAccess: (a: Access) => void; workspace: string; setWorkspace: (w: string) => void; skill?: Skill
}) {
  const agents = useApp((s) => s.agents)
  const packs = useApp((s) => s.packs)
  const skills = useApp((s) => s.skills)
  const settings = useApp((s) => s.settings)
  const usable = agents.filter((a) => !unavailable(a)).sort((a, b) => Number(b.tools) - Number(a.tools)).map((a) => a.id)
  const [chosen, setChosen] = useState<string[] | null>(() => (skill && skill.crew.every((c) => usable.includes(c)) ? skill.crew : null))
  const crew = chosen ?? defaultCrew(usable, settings.defaultCrew)
  const [pack, setPack] = useState<string | undefined>(skill?.pack)
  const [draft, setDraft] = useState<{ text: string; n: number } | undefined>(() => (skill ? { text: skillText(skill), n: 1 } : undefined))
  const useSkill = (s: Skill) => {
    if (s.crew.every((c) => usable.includes(c))) setChosen(s.crew)
    if (s.pack) setPack(s.pack)
    setDraft({ text: skillText(s), n: Date.now() })
  }
  const [arena, setArena] = useState(false)
  const [starting, setStarting] = useState(false)
  const current = packs.find((p) => p.id === pack)
  const ideas = current?.ideas ?? ['Review this folder and tell me what to fix first', 'Research a topic with sources', 'Build a small tool and test it']

  const start = async (text: string) => {
    if (!crew.length || starting) return
    setStarting(true)
    const meta = await desk.call('room:create', { crew, workspace, pack })
    if (!meta) return setStarting(false)
    await desk.call('room:send', meta.id, text, access, arena)
    onCreated(meta.id)
  }
  const pick = async () => { const p = await desk.call('pick'); if (p) setWorkspace(p) }
  const label = crew.length ? crew.map((id) => agentOf(id, agents).bin ?? agentOf(id, agents).short.toLowerCase()).join(' + ') : 'no agents yet'

  return (
    <div className={`newroom${starting ? ' starting' : ''}`}>
      <div className="newbody">
        <Band rows={9} label={label} busy={starting} />
        <h1 className="rise" style={{ '--i': 1 } as CSSProperties}>What are we working on?</h1>
        <div className="rise" style={{ '--i': 2 } as CSSProperties}>
          {crew.length ? (
            <Composer crew={crew} setCrew={setChosen} onSend={start} access={access} setAccess={setAccess} draft={draft} arena={arena} setArena={setArena} pack={pack}
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
          {packs.map((p) => <button key={p.id} className={`chip${pack === p.id ? ' on' : ''}`} onClick={() => setPack(p.id)} title={p.line}>{p.name}</button>)}
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
      </div>
    </div>
  )
}
