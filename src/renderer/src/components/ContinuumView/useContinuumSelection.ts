import { useEffect, useRef, useState } from 'react'
import type { ContinuumItem, ContinuumListRequest } from '../../../../shared/types/continuum-ui-types'

export function useContinuumSelection(request: ContinuumListRequest | null, revision: string) {
  const identity = JSON.stringify([request, revision])
  const context = useRef(identity), busy = useRef(false)
  context.current = identity
  const [state, setState] = useState<{ identity: string; items: ContinuumItem[] }>({ identity, items: [] })
  const [pending, setPending] = useState(false), [error, setError] = useState('')
  const selected = state.identity === identity ? state.items : []
  useEffect(() => { setState({ identity, items: [] }); setError(''); setPending(false); return () => { context.current = '' } }, [identity])
  const replace = (items: ContinuumItem[]) => {
    if (busy.current) return
    if (items.length > 100) { setError('Até 100 Artifacts; refine a seleção.'); return }
    if (items.some(item => item.revision === undefined)) { setError('Revisão indisponível; atualize a Timeline.'); return }
    setState({ identity, items }); setError('')
  }
  const toggle = (item: ContinuumItem) => replace(selected.some(source => source.artifactId === item.artifactId) ? selected.filter(source => source.artifactId !== item.artifactId) : [...selected, item])
  const all = async () => {
    if (!request || busy.current) return
    const started = identity
    busy.current = true; setPending(true); setError('')
    try {
      const result = await window.codeAwareness.resolveContinuumSelection(request)
      if (context.current !== started || result.repositoryId !== request.repositoryId) return
      const items = result.artifacts
      if (items.length > 100 || items.some(item => item.revision === undefined)) throw new Error('INVALID_SELECTION')
      if (!items.length) { setState({ identity, items: [] }); return }
      const totals = await window.codeAwareness.getContinuumSelectionTokens(request.repositoryId, items.map(item => ({ artifactId: item.artifactId, expectedRevision: item.revision! })))
      if (context.current !== started || totals.repositoryId !== request.repositoryId) return
      setState({ identity, items: items.map(item => ({ ...item, rawMarkdownTokenCount: totals.artifacts.find(total => total.artifactId === item.artifactId)?.rawMarkdownTokenCount })) })
    } catch (reason) { if (context.current === started) setError(String(reason)) }
    finally { busy.current = false; if (context.current === started) setPending(false) }
  }
  return { selected, pending, error, toggle, replace, all, clear: () => replace([]) }
}
