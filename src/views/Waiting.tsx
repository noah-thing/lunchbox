import { useEffect, useState, type CSSProperties } from 'react'
import type { Waiting } from '../../shared/types'
import { desk, useApp, type Access } from '../lib/desk'
import type { View } from '../App'

// One place for everything that waits on you: decisions and commands from every room, answered
// here or in their room.
export function WaitingPage({ go, access }: { go: (v: View) => void; access: Access }) {
  const rooms = useApp((s) => s.rooms)
  const [list, setList] = useState<Waiting[]>([])
  useEffect(() => { desk.call('inbox').then(setList).catch(() => {}) }, [rooms])
  return (
    <div className="page">
      <div className="pagebody">
        <header className="pagehead rise">
          <h1>Needs you</h1>
          <p>Decisions and commands waiting across your rooms. Answer here, or open the room to see the work around it.</p>
        </header>
        {!list.length && <p className="hint rise">Nothing is waiting. Rooms that need you show up here and in the sidebar.</p>}
        {list.map((w, i) => (
          <section key={w.room} className="group rise" style={{ '--i': i + 1 } as CSSProperties}>
            <h2>{w.name}<button className="btn small quiet" onClick={() => go({ name: 'room', id: w.room })}>Open room</button></h2>
            <div className="settings">
              {w.items.map((it) => it.kind === 'decide' ? (
                <div key={it.ref} className="setting inboxrow">
                  <div className="grow"><b>{it.text}</b></div>
                  <div className="row">{it.options.map((o, n) => (
                    <button key={o} className={`btn small${n ? ' quiet' : ''}`} onClick={() => desk.call('room:decide', w.room, it.ref, n, access)}>{o}</button>
                  ))}</div>
                </div>
              ) : (
                <div key={it.id} className="setting inboxrow">
                  <div className="grow"><b className="mono">{it.command}</b>{it.reason && <span>Asks because it {it.reason}</span>}</div>
                  <div className="row">
                    <button className="btn small" onClick={() => desk.call('run:answer', it.id, 'once')}>Run</button>
                    <button className="btn small quiet" onClick={() => desk.call('run:answer', it.id, 'deny')}>Refuse</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
