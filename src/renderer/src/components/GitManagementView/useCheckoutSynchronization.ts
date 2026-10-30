import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitCheckoutSynchronization, GitManagementContext, GitManagementResult } from '../../../../shared/types/git-management-types'
import type { GitAtlasPage } from '../../../../shared/types/git-atlas-types'

export function checkoutSynchronizationRevision(page: GitAtlasPage | null) {
  if (!page) return null
  const upstream = page.refs.find(ref => ref.ref === `refs/heads/${page.branch}`)?.upstream ?? null
  const trackingHead = page.refs.find(ref => ref.name === upstream || ref.ref === upstream)?.sha ?? null
  return JSON.stringify([page.head, page.branch, upstream, trackingHead])
}

export function useCheckoutSynchronization(context: GitManagementContext, snapshot: string | undefined, blocked = false) {
  const key = JSON.stringify([context, snapshot])
  const currentKey = useRef(key)
  currentKey.current = key
  const generation = useRef(0)
  const failures = useRef(0)
  const inFlight = useRef<{ key: string; promise: Promise<void> } | null>(null)
  const [observation, setObservation] = useState<{ key: string; value: GitCheckoutSynchronization | null; loading: boolean; error: string }>({ key, value: null, loading: false, error: '' })
  const invalidate = useCallback(() => {
    generation.current++
    inFlight.current = null
    setObservation({ key, value: null, loading: false, error: '' })
  }, [key])
  const verify = useCallback((): Promise<void> => {
    if (!snapshot || !context.projectId || blocked) return Promise.resolve()
    if (inFlight.current?.key === key) return inFlight.current.promise
    const request = ++generation.current
    setObservation(previous => ({ key, value: previous.key === key ? previous.value : null, loading: true, error: '' }))
    const accept = (result: GitManagementResult<GitCheckoutSynchronization>) => {
      if (generation.current !== request || currentKey.current !== key) return
      failures.current = result.success && result.data.evidence.status === 'VERIFIED' && !['FAILED', 'PENDING'].includes(result.data.automaticFetch ?? '') ? 0 : Math.min(3, failures.current + 1)
      setObservation({ key, value: result.success ? result.data : null, loading: false, error: result.success ? '' : result.code })
    }
    const promise = Promise.resolve().then(() => window.codeAwareness.getGitCheckoutSynchronization(context, true))
      .then(accept, () => accept({ success: false, code: 'Verificação remota indisponível' }))
      .finally(() => { if (inFlight.current?.promise === promise) inFlight.current = null })
    inFlight.current = { key, promise }
    return promise
  }, [context, key, snapshot, blocked])
  useEffect(() => {
    let current = true, timer: ReturnType<typeof setTimeout> | undefined
    let quietUntil = 0, dragging = false
    const schedule = (delay: number) => {
      clearTimeout(timer)
      if (current && !document.hidden) timer = setTimeout(() => void probe(), delay)
    }
    const probe = async () => {
      if (!current || document.hidden) return
      if (dragging || Date.now() < quietUntil) { schedule(1000); return }
      const started = Date.now()
      await verify()
      schedule(Math.max(1000, 30000 * 2 ** failures.current - (Date.now() - started)))
    }
    const focus = () => { if (!document.hidden) void probe() }
    const visibility = () => {
      clearTimeout(timer)
      if (document.hidden) { generation.current++; inFlight.current = null }
      else focus()
    }
    const interact = () => { quietUntil = Date.now() + 600 }
    const down = () => { dragging = true; interact() }
    const up = () => { dragging = false; interact() }
    const blur = () => { dragging = false; interact() }
    focus()
    window.addEventListener('focus', focus)
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('wheel', interact, { passive: true })
    window.addEventListener('keydown', interact)
    window.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      current = false; clearTimeout(timer); generation.current++; inFlight.current = null
      window.removeEventListener('focus', focus); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('wheel', interact); window.removeEventListener('keydown', interact)
      window.removeEventListener('pointerdown', down); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up)
    }
  }, [verify])
  const visible = observation.key === key ? observation : { value: null, loading: !!snapshot, error: '' }
  return { ...visible, verify, invalidate }
}
