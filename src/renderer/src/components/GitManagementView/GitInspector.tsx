import React, { useEffect, useRef, useState } from 'react'
import type {
  GitCommitDetail,
  GitDecoration,
  GitManagementContext,
  GitOverview,
  GitPatch,
  GitPatchRequest
} from '../../../../shared/types/git-management-types'

export type GitSelection =
  | { kind: 'COMMIT'; sha: string }
  | { kind: 'BRANCH'; ref: GitDecoration }
  | null
export function GitInspector({
  context,
  overview,
  selection
}: {
  context: GitManagementContext
  overview: GitOverview | null
  selection: GitSelection
}) {
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [patchRequest, setPatchRequest] = useState<Omit<
    GitPatchRequest,
    'context' | 'cursor'
  > | null>(null)
  const [patch, setPatch] = useState<GitPatch | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  const patchGeneration = useRef(0)
  const sha = selection?.kind === 'COMMIT' ? selection.sha : null
  useEffect(() => {
    const request = ++generation.current
    patchGeneration.current++
    setDetail(null)
    setPatch(null)
    setPatchRequest(null)
    setError('')
    setLoading(!!sha)
    if (sha)
      window.codeAwareness
        .getGitManagementCommit({ context, sha })
        .then((result) => {
          if (generation.current !== request) return
          if (result.success) setDetail(result.data)
          else setError(result.code)
          setLoading(false)
        })
        .catch(() => {
          if (generation.current === request) {
            setError('Falha ao ler commit')
            setLoading(false)
          }
        })
    return () => {
      generation.current++
      patchGeneration.current++
    }
  }, [context, sha, selection?.kind, overview])
  const loadPatch = async (
    request: Omit<GitPatchRequest, 'context' | 'cursor'>,
    cursor?: string
  ) => {
    const current = ++patchGeneration.current
    setPatchRequest(request)
    setError('')
    setLoading(true)
    if (!cursor) setPatch(null)
    try {
      const result = await window.codeAwareness.getGitManagementPatch({
        ...request,
        context,
        cursor
      })
      if (patchGeneration.current !== current) return
      if (result.success)
        setPatch((previous) =>
          cursor && previous?.revision === result.data.revision
            ? { ...result.data, patch: previous.patch + result.data.patch }
            : result.data
        )
      else setError(result.code)
    } catch {
      if (patchGeneration.current === current) setError('Falha ao ler patch')
    } finally {
      if (patchGeneration.current === current) setLoading(false)
    }
  }
  const loadFiles = async () => {
    if (!detail?.nextCursor || !sha) return
    const current = generation.current
    setLoading(true)
    try {
      const result = await window.codeAwareness.getGitManagementCommit({
        context,
        sha,
        cursor: detail.nextCursor
      })
      if (generation.current !== current) return
      if (result.success)
        setDetail((previous) =>
          previous
            ? {
                ...result.data,
                files: [...previous.files, ...result.data.files]
              }
            : result.data
        )
      else setError(result.code)
    } catch {
      if (generation.current === current) setError('Falha ao ler arquivos')
    } finally {
      if (generation.current === current) setLoading(false)
    }
  }
  const groups = overview
    ? [
        {
          label: 'Conflitos',
          items: overview.changes.filter((change) => change.conflicted),
          mode: 'WORKTREE' as const
        },
        {
          label: 'Preparadas · staged',
          items: overview.changes.filter(
            (change) => change.stagedState && !change.conflicted
          ),
          mode: 'STAGED' as const
        },
        {
          label: 'Não preparadas · unstaged',
          items: overview.changes.filter(
            (change) =>
              change.unstagedState && !change.conflicted && !change.untracked
          ),
          mode: 'WORKTREE' as const
        },
        {
          label: 'Novos arquivos · untracked',
          items: overview.changes.filter((change) => change.untracked),
          mode: 'WORKTREE' as const
        }
      ]
    : []
  return (
    <div aria-busy={loading}>
      {error && (
        <p role="alert" className="gm-inspector-error">
          {error === 'DIFF_TOO_LARGE'
            ? 'Diff excede o limite de leitura de 512 KB. Inspecione este arquivo em uma ferramenta local.'
            : error}
        </p>
      )}
      {selection?.kind === 'BRANCH' && (
        <>
          <h2>{selection.ref.name}</h2>
          <p>
            {selection.ref.kind === 'REMOTE'
              ? 'Referência de rastreamento remoto'
              : 'Branch local'}
            {selection.ref.name === overview?.state.branch
              ? ' · ativa (HEAD)'
              : ''}
          </p>
          <p>Uma branch é uma referência móvel para um commit.</p>
          <p>Upstream: {selection.ref.upstream ?? 'não configurado'}</p>
          <details>
            <summary>Commit na ponta</summary>
            <code>{selection.ref.sha}</code>
          </details>
        </>
      )}
      {selection?.kind === 'COMMIT' && (
        <>
          {detail ? (
            <>
              <h2>{detail.commit.subject}</h2>
              <p>
                {detail.commit.author} ·{' '}
                {new Date(detail.commit.timestamp).toLocaleString()}
              </p>
              <button onClick={() => navigator.clipboard.writeText(detail.commit.sha)} aria-label="Copiar SHA">{detail.commit.sha.slice(0, 12)} · Copiar SHA</button>
              <p>Origem: Não registrada</p>
              <details>
                <summary>Identidade e pais</summary>
                <code>{detail.commit.sha}</code>
                {detail.commit.parents.map((parent) => (
                  <code key={parent}>{parent}</code>
                ))}
              </details>
              <p>
                {detail.comparison === 'ROOT'
                  ? 'Commit raiz: alterações desde a árvore vazia.'
                  : detail.comparison === 'FIRST_PARENT'
                    ? 'Merge: diff comparado ao primeiro pai.'
                    : 'Diff comparado ao pai deste commit.'}
              </p>
              <h3>Arquivos alterados</h3>
              <div className="gm-files">
                {detail.files.map((file) => (
                  <button
                    key={file.path}
                    disabled={loading}
                    onClick={() =>
                      void loadPatch({
                        path: file.path,
                        mode: 'COMMIT',
                        sha: detail.commit.sha
                      })
                    }
                  >
                    <span>
                      {file.previousPath ? `${file.previousPath} → ` : ''}
                      {file.path}
                    </span>
                    <small>{file.status}</small>
                  </button>
                ))}
              </div>
              {!detail.files.length && (
                <p>Nenhum arquivo alterado nesta comparação.</p>
              )}
              {detail.nextCursor && (
                <button disabled={loading} onClick={() => void loadFiles()}>
                  Mais arquivos
                </button>
              )}
            </>
          ) : loading ? (
            <p>Carregando commit…</p>
          ) : null}
        </>
      )}
      {!selection && overview && (
        <>
          <h2>Alterações locais</h2>
          <p>
            {overview.state.branch ?? 'detached HEAD'} ·{' '}
            {overview.changes.length} arquivos alterados
          </p>
          <p>
            Upstream: {overview.state.upstream ?? 'não configurado'}
            {overview.state.upstream
              ? ` · ${overview.state.ahead} à frente / ${overview.state.behind} atrás`
              : ''}
          </p>
          {overview.state.operation && (
            <p role="alert">
              Operação Git em andamento: {overview.state.operation}
            </p>
          )}
          <p>
            Stage prepara uma versão do arquivo no índice. Commit registra
            somente o índice; alterações posteriores continuam não preparadas.
          </p>
          {groups.map((group) => (
            <section key={group.label} className="gm-change-group">
              <h3>
                {group.label} <span>{group.items.length}</span>
              </h3>
              <div className="gm-files">
                {group.items.map((change) => (
                  <button
                    key={change.path}
                    disabled={loading || change.conflicted}
                    onClick={() =>
                      void loadPatch({ path: change.path, mode: group.mode })
                    }
                  >
                    <span>
                      {change.previousPath ? `${change.previousPath} → ` : ''}
                      {change.path}
                    </span>
                    <small>
                      {group.mode === 'STAGED'
                        ? change.stagedState
                        : change.untracked
                          ? '?'
                          : change.unstagedState}
                    </small>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </>
      )}
      {!selection && !overview && <p>Carregando estado Git…</p>}
      {patchRequest && (
        <section className="gm-patch">
          <h3>{patchRequest.path}</h3>
          <p>
            {patchRequest.mode === 'STAGED'
              ? 'Índice preparado'
              : patchRequest.mode === 'WORKTREE'
                ? 'Alterações não preparadas'
                : 'Alterações do commit'}
          </p>
          {loading && !patch && <p>Carregando patch…</p>}
          {patch &&
            (patch.binary ? (
              <p>Arquivo binário: não há patch textual.</p>
            ) : !patch.patch ? (
              <p>Sem patch textual nesta comparação.</p>
            ) : (
              <pre tabIndex={0}>{patch.patch}</pre>
            ))}
          {patch?.nextCursor && (
            <button
              disabled={loading}
              onClick={() => void loadPatch(patchRequest, patch.nextCursor!)}
            >
              Continuar patch
            </button>
          )}
        </section>
      )}
    </div>
  )
}
