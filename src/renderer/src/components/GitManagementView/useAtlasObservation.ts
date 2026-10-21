import { useEffect, useRef } from 'react'
import type { GitManagementContext } from '../../../../shared/types/git-management-types'
import type { GitAtlasPage } from '../../../../shared/types/git-atlas-types'

export function useAtlasObservation(options: {
  context: GitManagementContext
  page: GitAtlasPage | null
  loading: boolean
  reconcile(): Promise<void | boolean>
  operation(value: string | null): void
  pause?(): void
  resume?(): void
}) {
  const latest = useRef(options)
  latest.current = options
  const pending = useRef(false)
  useEffect(() => {
    if (!options.context.projectId) return
    let current = true, timer: ReturnType<typeof setTimeout> | undefined
    let quietAfter = 0, dragging = false, backoff = 2500, fullAt = 0, wakeFull = true
    let visibilityGeneration = 0, reconciliationBackoff = 0
    let interactionTimer: ReturnType<typeof setTimeout> | undefined, paused = false, operationBusy = false
    const pause = () => { if (!paused) { paused = true; latest.current.pause?.() } }
    const resume = () => { if (paused) { paused = false; latest.current.resume?.() } }
    const schedule = (delay: number) => {
      if (timer) clearTimeout(timer)
      timer = undefined
      if (current && !document.hidden) timer = setTimeout(() => { timer = undefined; void probe() }, delay)
    }
    const probe = async () => {
      if (!current || document.hidden) return
      if (pending.current || latest.current.loading || dragging || Date.now() < quietAfter) { schedule(1000); return }
      pending.current = true
      const visibleGeneration = visibilityGeneration
      const page = latest.current.page
      const full = wakeFull || Date.now() - fullAt >= 30000
      wakeFull = false
      const start = Date.now()
      try {
        const result = await window.codeAwareness.getGitAtlasCheckoutState(options.context, !full)
        if (!current || document.hidden || visibleGeneration !== visibilityGeneration || page !== latest.current.page || latest.current.loading) return
        if (!result.success) {
          if (result.code === 'GIT_OPERATION_IN_PROGRESS') { operationBusy = true; pause() }
          backoff = Math.min(30000, backoff * 2); return
        }
        latest.current.operation(result.data.operation)
        operationBusy = !!result.data.operation
        if (operationBusy) { pause(); backoff = Math.min(30000, backoff * 2); return }
        if (!result.data.referenceFingerprint) { backoff = Math.min(30000, backoff * 2); return }
        if (full) fullAt = Date.now()
        backoff = Date.now() - start > 1000 ? Math.min(30000, backoff * 2) : 2500
        if (dragging || Date.now() < quietAfter) return
        resume()
        const baseline = page?.observation
        const changed = result.data.head !== page?.head || result.data.branch !== page?.branch ||
          baseline && (result.data.referenceFingerprint !== baseline.referenceFingerprint ||
            full && baseline.sourceFingerprint && result.data.sourceFingerprint && result.data.sourceFingerprint !== baseline.sourceFingerprint)
        if (changed && await latest.current.reconcile() === false) {
          reconciliationBackoff = Math.min(30000, Math.max(5000, reconciliationBackoff * 2))
          backoff = Math.max(backoff, reconciliationBackoff)
        } else reconciliationBackoff = 0
      } catch { backoff = Math.min(30000, backoff * 2) }
      finally { pending.current = false; schedule(wakeFull ? 0 : backoff) }
    }
    const wake = () => { wakeFull = true; schedule(0) }
    const visibility = () => { visibilityGeneration++; if (document.hidden) { if (timer) clearTimeout(timer); timer = undefined } else wake() }
    const interact = () => {
      quietAfter = Date.now() + 600
      pause()
      if (interactionTimer) clearTimeout(interactionTimer)
      interactionTimer = setTimeout(() => { if (!dragging && !document.hidden && !operationBusy) resume() }, 600)
    }
    const down = () => { dragging = true; interact() }
    const up = () => { dragging = false; interact() }
    const move = () => { if (dragging) interact() }
    const blur = () => { dragging = false; interact() }
    window.addEventListener('focus', wake)
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('wheel', interact, { passive: true })
    window.addEventListener('scroll', interact, { passive: true, capture: true })
    window.addEventListener('keydown', interact)
    window.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('pointermove', move, { passive: true })
    schedule(0)
    return () => {
      current = false
      if (timer) clearTimeout(timer)
      if (interactionTimer) clearTimeout(interactionTimer)
      window.removeEventListener('focus', wake); window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('wheel', interact); window.removeEventListener('scroll', interact, true)
      window.removeEventListener('keydown', interact); window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); window.removeEventListener('pointermove', move)
    }
  }, [options.context])
}
