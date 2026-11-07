import { useEffect, useRef } from 'react'

export function useAcademyFocus(key: string, selector: string, onEscape: () => void) {
  const close = useRef(onEscape)
  close.current = onEscape
  useEffect(() => {
    if (!key) return
    const surfaces = document.querySelectorAll<HTMLElement>(selector)
    const surface = surfaces[surfaces.length - 1]
    if (!surface) return
    const previous = document.activeElement as HTMLElement | null
    const controls = () => [...surface.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')].filter(element => {
      if (getComputedStyle(element).display === 'none' || getComputedStyle(element).visibility === 'hidden') return false
      for (let parent = element.parentElement; parent && parent !== surface; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS' && !parent.hasAttribute('open') && element !== parent.querySelector(':scope > summary')) return false
      }
      return true
    })
    controls()[0]?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return }
      if (event.key !== 'Tab') return
      const items = controls()
      const first = items[0], last = items[items.length - 1]
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || !surface.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !surface.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown, true)
    return () => { document.removeEventListener('keydown', keydown, true); if (previous?.isConnected) previous.focus() }
  }, [key, selector])
}
