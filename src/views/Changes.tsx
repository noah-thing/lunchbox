import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader } from '../ui/bits'
import { IconClose, IconRewind } from '../ui/icons'
import { desk, reason } from '../lib/desk'

export type FileChange = {
  path: string; from?: string; status: 'added' | 'modified' | 'deleted' | 'renamed'
  added: number; removed: number; binary: boolean; patch: string; cut: boolean
}

type Line = { kind: 'add' | 'del' | 'ctx' | 'hunk'; text: string; a?: number; b?: number }

// Unified diff to numbered rows. Old and new line numbers run side by side like a review tool.
function rows(patch: string): Line[] {
  const out: Line[] = []
  let a = 0
  let b = 0
  let body = false
  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw)
    if (hunk) {
      a = Number(hunk[1]); b = Number(hunk[2]); body = true
      if (out.length || hunk[3].trim() || Math.max(a, b) > 1) out.push({ kind: 'hunk', text: hunk[3].trim() || `line ${b}` })
      continue
    }
    if (!body || raw.startsWith('\\')) continue
    if (raw.startsWith('+')) out.push({ kind: 'add', text: raw.slice(1), b: b++ })
    else if (raw.startsWith('-')) out.push({ kind: 'del', text: raw.slice(1), a: a++ })
    else if (raw.length || out.length) out.push({ kind: 'ctx', text: raw.slice(1), a: a++, b: b++ })
  }
  while (out.length && out[out.length - 1].kind === 'ctx' && !out[out.length - 1].text) out.pop()
  return out
}

const LETTER = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' } as const

// Files the crew changed in answer to one message, with their diffs. Opened from under the message.
export function Changes({ room, event, title, close, rewind }: {
  room: string; event: string; title: string; close: () => void; rewind: () => void
}) {
  const [files, setFiles] = useState<FileChange[] | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(0)

  useEffect(() => {
    desk.call('room:changes', room, event).then((f: FileChange[]) => setFiles(f ?? []), (e: unknown) => setError(reason(e)))
  }, [room, event])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
      if (!files?.length) return
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); setOpen((i) => Math.min(files.length - 1, i + 1)) }
      if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); setOpen((i) => Math.max(0, i - 1)) }
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [files, close])

  const total = useMemo(() => (files ?? []).reduce((t, f) => ({ add: t.add + f.added, del: t.del + f.removed }), { add: 0, del: 0 }), [files])
  const file = files?.[open]
  const lines = useMemo(() => (file ? rows(file.patch) : []), [file])

  return createPortal(
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="changes" role="dialog" aria-label="Changes">
        <header className="changeshead">
          <div className="grow">
            <b>Changes</b>
            <span>after “{title}”</span>
          </div>
          {files && files.length > 0 && <span className="mono counts"><i className="plus">+{total.add}</i><i className="minus">−{total.del}</i>{files.length} file{files.length > 1 ? 's' : ''}</span>}
          {files && files.length > 0 && <button className="btn small quiet" onClick={() => { close(); rewind() }} title="Put the folder back the way it was before this message"><IconRewind />Rewind</button>}
          <button className="iconbtn" onClick={close} aria-label="Close"><IconClose /></button>
        </header>
        {!files && !error && <div className="changesempty"><Loader size={14} /></div>}
        {error && <div className="changesempty"><b>Could not read the changes</b><span>{error}</span></div>}
        {files && !files.length && <div className="changesempty"><b>Nothing changed</b><span>The folder looks the same as before this message.</span></div>}
        {files && files.length > 0 && (
          <div className="changesbody">
            <nav className="changelist">
              {files.map((f, i) => {
                const slash = f.path.lastIndexOf('/')
                return (
                  <button key={f.path} className={`changefile ${f.status}${i === open ? ' on' : ''}`} onClick={() => setOpen(i)} title={f.from ? `${f.from} → ${f.path}` : f.path}>
                    <i className="letter">{LETTER[f.status]}</i>
                    <span className="grow"><b>{f.path.slice(slash + 1)}</b>{slash > 0 && <small>{f.path.slice(0, slash)}</small>}</span>
                    <span className="mono fstat">{f.binary ? 'bin' : <><i className="plus">+{f.added}</i> <i className="minus">−{f.removed}</i></>}</span>
                  </button>
                )
              })}
            </nav>
            <div className="patch" key={file?.path}>
              {file && (
                <>
                  <div className="patchhead mono">
                    {file.from && <span className="quiet">{file.from} → </span>}{file.path}
                    <span className="spacer" />
                    {file.status !== 'deleted' && <button className="ghostbtn mono" onClick={() => desk.call('room:show', room, file.path)}>Show in folder</button>}
                  </div>
                  {file.binary ? <p className="hint pad">A binary file. Open it to see the new version.</p>
                    : !lines.length ? <p className="hint pad">{file.status === 'renamed' ? 'Renamed without changes.' : 'An empty file.'}</p>
                    : (
                      <table className="lines">
                        <tbody>
                          {lines.map((l, i) => l.kind === 'hunk'
                            ? <tr key={i} className="hunk"><td colSpan={3}>{l.text || '···'}</td></tr>
                            : (
                              <tr key={i} className={l.kind}>
                                <td className="n">{l.a ?? ''}</td>
                                <td className="n">{l.b ?? ''}</td>
                                <td className="t"><span className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>{l.text}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    )}
                  {file.cut && <p className="hint pad">The rest of this diff is too long to show here.</p>}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
