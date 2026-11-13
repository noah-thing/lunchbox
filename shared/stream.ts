// A reply still being written, as it can be shown without changing shape a moment later. The
// last line is the only part that can still turn into something else: a fence, a heading or a
// list marker half typed is held back until it is one, and bold, code or a link left open is
// closed, so the words never show their markup and then lose it.
export function steady(text: string): string {
  const at = text.lastIndexOf('\n') + 1
  const head = text.slice(0, at)
  let tail = text.slice(at)
  const fenced = (head.match(/^\s*```/gm)?.length ?? 0) % 2 === 1
  // Inside an open fence the next line starts when its first character does, so the block is not
  // one line taller for the moment before it closes.
  if (fenced) return /^\s*`{0,2}$/.test(tail) ? head.replace(/\n$/, '') : text
  if (/^\s*(`{1,2}|#{1,4}|\d{1,3}[.)]?|[-*•](?:[ \t]+\[?[ xX]?\]?)?)[ \t]*$/.test(tail)) return head
  if (/^\s*```/.test(tail)) return text
  tail = tail.replace(/\[([^\]\n]+)\]\([^)\n]*$/, '$1')
  // Code first: stars inside a code span are not bold.
  const plain = tail.replace(/`[^`\n]*`/g, '')
  if (plain.includes('`')) tail = tail.endsWith('`') ? tail.slice(0, -1) : tail + '`'
  else if ((plain.match(/\*\*/g)?.length ?? 0) % 2 === 1) tail = /\*\*$/.test(tail) ? tail.slice(0, -2) : /[^*\s]\*$/.test(tail) ? tail + '*' : tail + '**'
  else if (/(^|\s)\*$/.test(tail)) tail = tail.slice(0, -1)
  return head + tail
}
