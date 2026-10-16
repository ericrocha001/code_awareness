import React, { useEffect, useRef, useState } from 'react'
import { Copy, FileText, GitBranch, GitCommitHorizontal } from 'lucide-react'
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
  selection,
  onCompare
}: {
  context: GitManagementContext
  overview: GitOverview | null
  selection: GitSelection
  onCompare?: () => void
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
  const sha = selection?.kind === 'COMMIT' ? selection.sha : selection?.kind === 'BRANCH' ? selection.ref.sha : null
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
          <div className="gm-commit-badges"><span><GitBranch size={14} />{selection.ref.kind === 'REMOTE' ? 'Branch remota' : 'Branch local'}</span>{selection.ref.name === overview?.state.branch && <span>HEAD · ativa</span>}</div>
          <section className="gm-inspector-section"><h3>Rastreamento</h3><div className="gm-detail-row gm-branch-detail"><GitBranch size={17} /><span>Upstream</span><span>{selection.ref.upstream ?? 'Não configurado'}</span></div></section>
          <section className="gm-inspector-section"><h3>Commit na ponta</h3><div className="gm-detail-row"><GitCommitHorizontal size={17} /><span>SHA</span><button title={selection.ref.sha} aria-label="Copiar SHA da branch" onClick={() => navigator.clipboard.writeText(selection.ref.sha)}>{selection.ref.sha.slice(0, 12)}<Copy size={14} /></button></div><details className="gm-branch-identity"><summary>Identidade completa</summary><code>{selection.ref.sha}</code></details></section>
          {detail && detail.commit.sha === selection.ref.sha && <section className="gm-inspector-section gm-branch-tip" data-sha={detail.commit.sha}><h3>Último commit</h3><p>{detail.commit.subject}</p><div className="gm-commit-author"><span className="gm-author-avatar">{detail.commit.author.split(/\s+/).slice(0, 2).map(part => part[0]).join('')}</span><div><strong>{detail.commit.author}</strong><time>{new Date(detail.commit.timestamp).toLocaleString()}</time></div></div></section>}
          {loading && !detail && <p>Carregando commit na ponta…</p>}
          {onCompare && <button aria-label="Comparar branch" onClick={onCompare}>Comparar…</button>}
        </>
      )}
      {selection?.kind === 'COMMIT' && (
        <>
          {detail ? (
            <>
              <h2>{detail.commit.subject}</h2>
              <div className="gm-commit-badges"><span><GitCommitHorizontal size={14} />{detail.commit.parents.length > 1 ? 'Merge' : 'Commit'}</span>{detail.commit.decorations.map(ref => <span key={ref.ref}>{ref.name}</span>)}</div>
              <div className="gm-commit-author"><span className="gm-author-avatar">{detail.commit.author.split(/\s+/).slice(0, 2).map(part => part[0]).join('')}</span><div><strong>{detail.commit.author}</strong><time>{new Date(detail.commit.timestamp).toLocaleString()}</time></div><button title={detail.commit.sha} onClick={() => navigator.clipboard.writeText(detail.commit.sha)} aria-label="Copiar SHA">{detail.commit.sha.slice(0, 7)}<Copy size={14} /></button></div>
              <details className="gm-inspector-section gm-technical"><summary>Detalhes técnicos</summary><p>Origem: Não registrada</p><code>{detail.commit.sha}</code>
              <section className="gm-inspector-section"><h3>Parentesco</h3>{detail.commit.parents.map((parent, index) => <div className="gm-detail-row" key={parent}><GitCommitHorizontal size={17} /><span>{index === 0 ? 'Pai' : `Pai ${index + 1}`}</span><button title={parent} aria-label={`Copiar pai ${index + 1}`} onClick={() => navigator.clipboard.writeText(parent)}>{parent.slice(0, 7)}<Copy size={14} /></button></div>)}
              <p className="gm-comparison-note">
                {detail.comparison === 'ROOT'
                  ? 'Commit raiz: alterações desde a árvore vazia.'
                  : detail.comparison === 'FIRST_PARENT'
                    ? 'Merge: diff comparado ao primeiro pai.'
                    : 'Diff comparado ao pai deste commit.'}
              </p>
              </section></details>
              <section className="gm-inspector-section"><h3>Arquivos alterados <span className="gm-file-count">{detail.files.length}{detail.nextCursor ? '+' : ''}</span></h3>
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
                    <FileText size={17} /><span>
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
              </section>
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
          {!overview.changes.length && <p>Checkout limpo.</p>}
          {groups.filter(group => group.items.length > 0).map((group) => (
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
