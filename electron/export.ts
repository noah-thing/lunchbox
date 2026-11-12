import type { Act, Event, RoomMeta } from '../shared/types'
import { wallWhy } from '../shared/wall'
import { weave } from '../shared/weave'

type Names = (id: string) => string

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const time = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function actsLine(acts: Act[]) {
  const cmds = acts.filter((a) => a.t === 'cmd').length
  const files = new Set(acts.flatMap((a) => (a.t === 'edit' ? [a.path] : []))).size
  const tools = acts.filter((a) => a.t === 'tool').length
  return [cmds && `${cmds} command${cmds > 1 ? 's' : ''}`, files && `${files} file${files > 1 ? 's' : ''} changed`, tools && `${tools} tool call${tools > 1 ? 's' : ''}`].filter(Boolean).join(', ')
}

export function markdown(meta: RoomMeta, events: Event[], name: Names) {
  const out = [`# ${meta.name}`, '', `${time(meta.created)} · ${meta.crew.map(name).join(', ')}`, '']
  for (const e of weave(events)) {
    switch (e.kind) {
      case 'you': out.push(`**You:** ${e.text}${e.files?.length ? `\n\n_Attached: ${e.files.join(', ')}_` : ''}`, ''); break
      case 'say': {
        const a = actsLine(e.acts)
        out.push(`**${name(e.who)}:** ${e.text}`, ...(a ? ['', `_${a}_`] : []), ...(e.proof ?? []).map((p) => `\n> ${p.ok ? 'Proved' : 'Not proved'}: ${p.claim}. ${p.text.replace(/`/g, '')}`), '')
        break
      }
      case 'hands': out.push(`> **${name(e.from)} asked ${name(e.to)}:** ${e.ask}`, '>', ...e.answer.split('\n').map((l) => `> ${l}`), ''); break
      case 'image': out.push(`![${e.prompt.replace(/[[\]]/g, '')}](${e.path})`, ''); break
      case 'wall': out.push(`_${name(e.from)} ${e.reason}; ${e.to ? `${name(e.to)} took over` : 'nobody could take over'}._`, ''); break
      case 'run': out.push('```', `$ ${e.command}`, e.out.slice(-2000).trimEnd(), '```', `_exit ${e.code ?? e.how}_`, ''); break
      case 'decide': out.push(`_Needs you: ${e.text}_`, ''); break
      case 'chose': out.push(`_You chose: ${e.label}_`, ''); break
      case 'pick': out.push(`_You kept ${name(e.who)}'s answer._`, ''); break
      case 'note': out.push(`_${e.text}_`, ''); break
    }
  }
  return out.join('\n')
}

// Paragraphs, fenced code, inline code, bold and links: enough for agent prose to read well.
function prose(text: string) {
  const parts = text.split(/```[\w-]*\n?/)
  return parts.map((p, i) => {
    if (i % 2) return `<pre>${esc(p.replace(/\n$/, ''))}</pre>`
    return p.split(/\n{2,}/).filter((x) => x.trim()).map((para) => {
      let h = esc(para.trim())
      h = h.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      h = h.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
      h = h.replace(/^- \[x\] /gm, '<i class="box on"></i>').replace(/^- \[ \] /gm, '<i class="box"></i>').replace(/^[-*] /gm, '• ')
      return `<p>${h.replace(/\n/g, '<br>')}</p>`
    }).join('')
  }).join('')
}

function card(e: Event, name: Names): string | null {
  const meta = (who: string, extra = '') => `<div class="who"><b>${esc(who)}</b>${extra}<span>${new Date(e.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span></div>`
  switch (e.kind) {
    case 'you': return `<div class="ev you">${prose(e.text)}</div>`
    case 'say': {
      const a = actsLine(e.acts)
      const proof = (e.proof ?? []).map((p) => `<div class="proof${p.ok ? '' : ' bad'}">${p.ok ? 'Proved' : 'Not proved'}: ${esc(p.claim)}</div>`).join('')
      return `<div class="ev">${meta(name(e.who))}${prose(e.text)}${a ? `<div class="acts">${esc(a)}</div>` : ''}${proof}</div>`
    }
    case 'hands': return `<div class="ev hand">${meta(name(e.to), ` <em>${e.via === 'tool' ? 'lent a hand to' : 'answered'} ${esc(name(e.from))}</em>`)}<div class="ask">${esc(e.ask)}</div>${prose(e.answer)}</div>`
    case 'wall': return `<div class="ev note">${esc(wallWhy(name(e.from), e.reason))}. ${e.to ? `${esc(name(e.to))} took over with the same memory.` : 'Nobody could take over.'}</div>`
    case 'run': return `<div class="ev"><pre class="term">$ ${esc(e.command)}\n${esc(e.out.slice(-1500))}</pre></div>`
    case 'image': return `<div class="ev note">${esc(name(e.by))} made an image: ${esc(e.prompt.slice(0, 160))}</div>`
    case 'decide': return `<div class="ev note warn">${esc(e.text)}</div>`
    case 'chose': return `<div class="ev note">You chose: ${esc(e.label)}</div>`
    case 'pick': return `<div class="ev note">You kept ${esc(name(e.who))}'s answer.</div>`
    case 'note': return `<div class="ev note">${esc(e.text)}</div>`
    default: return null
  }
}

// One HTML file that plays the room back the way it happened, with real gaps squeezed so a long
// session watches in about a minute. No scripts or fonts are fetched.
export function replay(meta: RoomMeta, events: Event[], name: Names) {
  const cards = weave(events).map((e) => ({ at: e.at, html: card(e, name) })).filter((c) => c.html)
  const body = cards.map((c, i) => `<section data-at="${c.at - (cards[0]?.at ?? 0)}" style="--i:${i}">${c.html}</section>`).join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(meta.name)} · Lunchbox</title>
<style>
:root{--g:#080807;--s:#0e0e0d;--w:#161614;--i:#f2f0ea;--d:rgba(242,240,234,.62);--f:rgba(242,240,234,.38);--l:rgba(242,240,234,.1)}
*{box-sizing:border-box}body{margin:0;background:var(--g);color:var(--i);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto;padding:72px 24px 120px}header{margin-bottom:40px}h1{font-size:26px;font-weight:600;letter-spacing:-.02em;margin:0 0 6px}
header p{color:var(--f);margin:0;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
section{margin:0 0 22px;transition:opacity .5s ease,transform .5s cubic-bezier(.2,.8,.2,1)}body.playing section.hidden{opacity:0;transform:translateY(8px);height:0;margin:0;overflow:hidden}
.ev{background:var(--s);border:1px solid var(--l);border-radius:14px;padding:16px 18px}.ev.you{background:var(--w);margin-left:15%}
.who{display:flex;gap:8px;align-items:baseline;margin-bottom:6px}.who span{margin-left:auto;color:var(--f);font:11px ui-monospace,Menlo,monospace}.who em{color:var(--d);font-style:normal}
p{margin:0 0 10px}p:last-child{margin:0}code,pre{font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}code{background:var(--w);padding:1px 5px;border-radius:5px}
pre{background:var(--g);border:1px solid var(--l);border-radius:10px;padding:12px 14px;overflow:auto;white-space:pre-wrap}a{color:var(--i)}
.ask{color:var(--d);border-left:2px solid var(--l);padding-left:10px;margin-bottom:8px}.acts{color:var(--f);font:11.5px ui-monospace,Menlo,monospace;margin-top:8px}
.proof{font-size:13px;margin-top:8px;color:var(--d)}.proof.bad{color:#e8794a}.note{background:none;border-style:dashed;color:var(--d);font-size:13.5px}.note.warn{color:#e2b54a}
.box{display:inline-block;width:11px;height:11px;border:1px solid var(--f);border-radius:3px;margin-right:6px;vertical-align:-1px}.box.on{background:var(--i);border-color:var(--i)}
nav{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);display:flex;gap:6px;background:var(--w);border:1px solid var(--l);border-radius:999px;padding:5px}
nav button{background:none;border:0;color:var(--i);font:inherit;font-size:13px;padding:7px 14px;border-radius:999px;cursor:pointer}nav button:hover{background:var(--l)}
footer{margin-top:56px;color:var(--f);font:11px ui-monospace,Menlo,monospace;text-align:center}footer a{color:inherit;text-underline-offset:3px}
@media (prefers-color-scheme:light){:root{--g:#f4f3ef;--s:#fff;--w:#ebe9e3;--i:#0d0d0c;--d:rgba(13,13,12,.62);--f:rgba(13,13,12,.4);--l:rgba(13,13,12,.1)}}
</style></head><body>
<main><header><h1>${esc(meta.name)}</h1><p>${esc(time(meta.created))} · ${esc(meta.crew.map(name).join(' + '))} · ${cards.length} moments</p></header>
${body}
<footer>Made in <a href="https://mylunchbox.dev">Lunchbox</a>, where AI agents work together</footer></main>
<nav><button id="play">Play</button><button id="all">Show all</button></nav>
<script>
const s=[...document.querySelectorAll('section')];let t=null
function show(){clearTimeout(t);document.body.classList.remove('playing');s.forEach(x=>x.classList.remove('hidden'))}
function play(){show();document.body.classList.add('playing');s.forEach(x=>x.classList.add('hidden'));let i=0
const step=()=>{if(i>=s.length)return;s[i].classList.remove('hidden');s[i].scrollIntoView({behavior:'smooth',block:'end'});const gap=i+1<s.length?(+s[i+1].dataset.at)-(+s[i].dataset.at):0;i++;t=setTimeout(step,Math.min(2200,Math.max(450,gap/8)))}
window.scrollTo({top:0});step()}
document.getElementById('play').onclick=play;document.getElementById('all').onclick=show
</script></body></html>
`
}
