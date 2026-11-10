import { Fragment, memo, type ReactNode } from 'react'
import { foldChecklists, sincePlan, type Step } from '../../shared/plan'

// Code, bold, web links, links to files on disk (shown as the file name) and bare URLs.
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|\[[^\]\n]+\]\((?!https?:)[^)\n]+\)|https?:\/\/[^\s)<>]+[^\s).,;:!?<>'"])/g

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (i % 2 === 0) return part
    if (part.startsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>
    if (part.startsWith('**')) return <b key={i}>{part.slice(2, -2)}</b>
    const link = part.match(/^\[([^\]]+)\]\((.+)\)$/)
    if (link && !/^https?:/.test(link[2])) return <code key={i} title={link[2]}>{link[1]}</code>
    const href = link ? link[2] : part
    return <a key={i} href={href} target="_blank" rel="noreferrer">{link ? link[1] : part.replace(/^https?:\/\//, '')}</a>
  })
}

type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; text: string }
  | { t: 'code'; lang: string; text: string }
  | { t: 'list'; ordered: boolean; items: { text: string; check?: boolean }[] }

function blocks(src: string, prior: Pick<Step, 'text' | 'done'>[] = []): Block[] {
  const out: Block[] = []
  const lines = src.replace(/\r/g, '').split('\n')
  let para: string[] = []
  const flush = () => { if (para.length) out.push({ t: 'p', text: para.join('\n') }); para = [] }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(/^\s*```(\S*)/)
    if (fence) {
      flush()
      const body: string[] = []
      while (++i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i])
      out.push({ t: 'code', lang: fence[1], text: body.join('\n') })
      continue
    }
    if (!line.trim()) { flush(); continue }
    const head = line.match(/^#{1,4}\s+(.+)/)
    if (head) { flush(); out.push({ t: 'h', text: head[1] }); continue }
    const item = line.match(/^\s*(?:([-*•])|(\d+)[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/)
    if (item) {
      flush()
      const ordered = !!item[2]
      const last = out[out.length - 1]
      const entry = { text: item[4], check: item[3] === undefined ? undefined : item[3] !== ' ' }
      if (last?.t === 'list' && last.ordered === ordered) last.items.push(entry)
      else out.push({ t: 'list', ordered, items: [entry] })
      continue
    }
    para.push(line)
  }
  flush()
  const items = (b: Block) => (b.t === 'list' ? b.items : undefined)
  return sincePlan(foldChecklists(out, items), items, prior)
}

// One line of text with code, bold and links, for places that show a single line (the plan).
export function Inline({ text }: { text: string }) {
  return <>{inline(text)}</>
}

// prior: the room's plan before this message, so a repeated checklist shows only what changed.
export const Rich = memo(function Rich({ text, caret = false, prior }: { text: string; caret?: boolean; prior?: Pick<Step, 'text' | 'done'>[] }) {
  const list = blocks(text, prior)
  return (
    <div className="rich">
      {list.map((b, i) => {
        const end = caret && i === list.length - 1 ? <span className="caret" /> : null
        switch (b.t) {
          case 'p': return <p key={i}>{b.text.split('\n').map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l)}</Fragment>)}{end}</p>
          case 'h': return <h4 key={i}>{inline(b.text)}{end}</h4>
          case 'code': return <pre key={i} className="codeblock" data-lang={b.lang || undefined}>{b.text}{end}</pre>
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul'
            return (
              <Tag key={i}>
                {b.items.map((it, j) => (
                  <li key={j} className={it.check === undefined ? '' : it.check ? 'todo done' : 'todo'}>
                    {it.check !== undefined && <i />}<span>{inline(it.text)}</span>
                  </li>
                ))}
                {end}
              </Tag>
            )
          }
        }
      })}
      {caret && !list.length && <span className="caret" />}
    </div>
  )
})
