// Sheets, menus, the room panel and a toast that reports a failure leave the way they came. React takes the node out at once, so a copy that
// cannot be clicked or focused stands in its place for the length of the exit. A close from the
// keyboard is instant, as every keyboard action is.
const OUT = 180

export function watchLeaving() {
  let keyed = 0
  // A node that has left the page reports no scroll position, so they are noted as they happen.
  const scrolled = new WeakMap<Element, number>()
  addEventListener('keydown', () => { keyed = performance.now() }, true)
  addEventListener('scroll', (e) => { if (e.target instanceof Element) scrolled.set(e.target, e.target.scrollTop) }, true)

  const stand = (node: HTMLElement, parent: Node, before: Node | null) => {
    const sheet = node.matches('.scrim.center')
    const ghost = node.cloneNode(true) as HTMLElement
    ghost.classList.add('gone')
    if (sheet) ghost.classList.add('leaving')
    ghost.inert = true
    ghost.setAttribute('aria-hidden', 'true')
    parent.insertBefore(ghost, before?.parentNode === parent ? before : null)
    const from = [node, ...node.querySelectorAll('*')], to = [ghost, ...ghost.querySelectorAll('*')]
    from.forEach((el, i) => { const top = scrolled.get(el); if (top) to[i].scrollTop = top })
    setTimeout(() => ghost.remove(), OUT)
  }

  new MutationObserver((changes) => {
    if (performance.now() - keyed < 80 || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    for (const c of changes) {
      if (!c.removedNodes.length || !c.target.isConnected) continue
      for (const node of c.removedNodes) {
        if (node instanceof HTMLElement && !node.classList.contains('gone') && node.matches('.scrim.center, .menu, .suggest, .toast.long, .panel')) stand(node, c.target, c.nextSibling)
      }
    }
  }).observe(document.body, { childList: true, subtree: true })
}
