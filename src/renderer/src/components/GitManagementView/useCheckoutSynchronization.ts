import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitCheckoutSynchronization, GitManagementContext, GitManagementResult } from '../../../../shared/types/git-management-types'
import type { GitAtlasPage } from '../../../../shared/types/git-atlas-types'

export function checkoutSynchronizationRevision(page: GitAtlasPage | null) {
  if (!page) return null
  const upstream = page.refs.find(ref => ref.ref === `refs/heads/${page.branch}`)?.upstream ?? null
  const trackingHead = page.refs.find(ref => ref.name === upstream || ref.ref === upstream)?.sha ?? null
  return JSON.stringify([page.head, page.branch, upstream, trackingHead])
}

export function useCheckoutSynchronization(context: GitManagementContext, snapshot: string | undefined) {
  const key = JSON.stringify([context, snapshot])
  const currentKey = useRef(key)
  currentKey.current = key
  const generation = useRef(0)
  const inFlight = useRef<{ key: string; promise: Promise<void> } | null>(null)
  const [observation, setObservation] = useState<{ key: string; value: GitCheckoutSynchronization | null; loading: boolean; error: string }>({ key, value: null, loading: false, error: '' })
  const invalidate = useCallback(() => {
    generation.current++
    inFlight.current = null
    setObservation({ key, value: null, loading: false, error: '' })
  }, [key])
  const verify = useCallback((): Promise<void> => {
    if (!snapshot || !context.projectId) return Promise.resolve()
    if (inFlight.current?.key === key) return inFlight.current.promise
    const request = ++generation.current
    setObservation({ key, value: null, loading: true, error: '' })
    const accept = (result: GitManagementResult<GitCheckoutSynchronization>) => {
      if (generation.current !== request || currentKey.current !== key) return
      setObservation({ key, value: result.success ? result.data : null, loading: false, error: result.success ? '' : result.code })
    }
    const promise = Promise.resolve().then(() => window.codeAwareness.getGitCheckoutSynchronization(context))
      .then(accept, () => accept({ success: false, code: 'Verificação remota indisponível' }))
      .finally(() => { if (inFlight.current?.promise === promise) inFlight.current = null })
    inFlight.current = { key, promise }
    return promise
  }, [context, key, snapshot])
  useEffect(() => {
    void verify()
    const focus = () => { if (!document.hidden) void verify() }
    window.addEventListener('focus', focus)
    return () => { generation.current++; inFlight.current = null; window.removeEventListener('focus', focus) }
  }, [verify])
  const visible = observation.key === key ? observation : { value: null, loading: !!snapshot, error: '' }
  return { ...visible, verify, invalidate }
}
