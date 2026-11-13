import { useEffect } from 'react'

// Dialogs keep the keyboard: Tab goes round inside the one on top, and closing it puts focus
// back where it was, so the next key lands where the person left off.

const REACH = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

// Where Tab goes from item `at` of `count`, or null to leave it to the browser. at is -1 when
// focus is outside the dialog.
export function round(count: number, at: number, back: boolean): number | null {
  if (!count) return -1
  if (at < 0) return back ? count - 1 : 0
  if (back && at === 0) return count - 1
  if (!back && at === count - 1) return 0
  return null
}

const top = () => {
  const all = document.querySelectorAll<HTMLElement>('.scrim:not(.leaving) [role=dialog]')
  return all[all.length - 1]
}

function tab(e: KeyboardEvent) {
  if (e.key !== 'Tab' || e.defaultPrevented) return
  const box = top()
  if (!box) return
  const items = [...box.querySelectorAll<HTMLElement>(REACH)].filter((el) => el.getClientRects().length > 0)
  const to = round(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey)
  if (to === null) return
  e.preventDefault()
  ;(items[to] ?? box).focus()
}

let listening = false

export function useModal(open = true) {
  useEffect(() => {
    if (!open) return
    if (!listening) { listening = true; addEventListener('keydown', tab) }
    const from = document.activeElement as HTMLElement | null
    // A field that asks for focus keeps it; otherwise the dialog itself takes it, so no button
    // is pressed by a stray Enter.
    const box = top()
    if (box && !box.contains(document.activeElement)) { box.tabIndex = -1; box.focus({ preventScroll: true }) }
    return () => {
      // After the dialog has gone: only if nothing else took focus in the meantime.
      requestAnimationFrame(() => {
        const at = document.activeElement
        if (from?.isConnected && (!at || at === document.body)) from.focus({ preventScroll: true })
      })
    }
  }, [open])
}
