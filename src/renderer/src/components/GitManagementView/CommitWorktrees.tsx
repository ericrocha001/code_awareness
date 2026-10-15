import React, { useEffect, useRef, useState } from 'react'
import type { GitManagementContext } from '../../../../shared/types/git-management-types'
import type { GitCommitWorktreesPage } from '../../../../shared/types/git-commit-correlation-types'
export function CommitWorktrees({ sha, context }: { sha: string; context: GitManagementContext }) {
  const [page, setPage] = useState<GitCommitWorktreesPage | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const epoch = useRef(0)
  const load = async (cursor?: string) => {
    const request = ++epoch.current
    setBusy(true); setError('')
    try {
      const result = await window.codeAwareness.getGitCommitCorrelation({ context, direction: 'COMMIT_WORKTREES', sha, limit: 20, cursor })
      if (request !== epoch.current) return
      if (!result.success) throw new Error(result.code)
      if (result.data.direction !== 'COMMIT_WORKTREES') throw new Error('CORRELATION_UNAVAILABLE')
      const next = result.data
      setPage(previous => cursor && previous?.revision === next.revision ? { ...next, items: [...previous.items, ...next.items], unavailable: [...previous.unavailable, ...next.unavailable] } : next)
    } catch (failure) { if (request === epoch.current) { setPage(null); setError(`Correlação indisponível ou obsoleta: ${failure instanceof Error ? failure.message : 'erro'}`) } }
    finally { if (request === epoch.current) setBusy(false) }
  }
  useEffect(() => { setPage(null); void load(); return () => { epoch.current++ } }, [sha, context.projectId, context.revision])
  return <section aria-label="Worktrees atuais contendo este commit"><h3>Worktrees atuais contendo este commit</h3><p>Associação atual por HEAD ou ancestralidade; não indica onde o commit foi criado.</p>
    {error && <p role="alert">{error}</p>}{busy && <p role="status">Consultando worktrees…</p>}
    <ul>{page?.items.map(tree => <li key={tree.worktreeId}>{tree.branch ?? 'HEAD detached'} · {tree.worktreeId.slice(0, 8)} · {tree.relation === 'HEAD_EXACT' ? 'HEAD exato' : 'Alcançável pelo HEAD'}</li>)}</ul>
    {page && <p>{page.coverage === 'PARTIAL' ? `Cobertura parcial (${page.scope.end}/${page.scope.total}); indisponíveis: ${page.scope.unavailable}.` : page.outcome === 'NONE_VERIFIED' ? 'Nenhuma associação atual na consulta completa.' : 'Cobertura completa da consulta.'}</p>}
    {page?.nextCursor && <button disabled={busy} onClick={() => void load(page.nextCursor!)}>Carregar mais worktrees</button>}
    {error && <button disabled={busy} onClick={() => void load()}>Atualizar associações</button>}
  </section>
}
