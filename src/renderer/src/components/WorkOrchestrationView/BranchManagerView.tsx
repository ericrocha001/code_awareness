import React, { useCallback, useEffect, useRef, useState } from 'react'
import { GitBranch, RefreshCw, X } from 'lucide-react'
import type { ActiveProjectState } from '../../../../shared/types/active-project-types'
import type { BranchHistoryPage, BranchInventory, BranchRecord, BranchWorktree } from '../../../../shared/types/branch-orchestration-types'
import type { BranchManagerData, BranchManagerOperation } from '../../../../shared/types/branch-manager-types'
import type { BranchPullRequests, PullRequestCommitsPage, PullRequestRecord } from '../../../../shared/types/branch-pull-request-types'
import type { BranchDiscardPreview } from '../../../../shared/types/branch-discard-types'
import type { WorktreeRemovalPreview } from '../../../../shared/types/worktree-removal-types'
import type { CommitNavigationIntent } from '../../../../shared/types/worktree-integration-evidence-types'
import type { ObservableWorktree, OrchestrationRequest } from '../../../../shared/types/work-orchestration-types'
import { LocalChangesInspector } from './LocalChangesInspector'
import { WorktreeDocumentContext } from './WorktreeDocumentContext'
import { WorktreeCommitsDisclosure } from './WorktreeCommitsDisclosure'
import './WorkOrchestrationView.css'
import './BranchManagerView.css'
import { BranchExecutions, type ArtifactNavigation } from './BranchExecutions'

const date = (at: string | null) => at ? new Date(at).toLocaleString('pt-BR') : 'Desconhecida'
const relationLabel = { CONFIRMED_CURRENT: 'Entrega corrente confirmada', CONFIRMED_HISTORICAL: 'Vínculo histórico comprovado', CANDIDATE: 'Candidato — HEAD divergente', AMBIGUOUS: 'Associação ambígua', UNKNOWN: 'Origem não confirmada' }
const blockers: Record<string, string> = { BRANCH_PROTECTED: 'Branch protegida', REMOTE_EVIDENCE_INCONCLUSIVE: 'Consulta remota inconclusiva', BRANCH_HAS_OPEN_PR: 'Existe PR aberto', WORKTREE_BRANCH_OCCUPIED: 'Branch em checkout numa Worktree', CURRENT_BRANCH: 'Branch atual', GIT_OPERATION_IN_PROGRESS: 'Operação Git em andamento', DIRTY_WORKTREE: 'Alterações locais precisam ser resolvidas', WORKTREE_IGNORED_CONTENT: 'Há arquivos ignorados que seriam perdidos', WORKTREE_PRIMARY_OR_ACTIVE: 'Checkout principal ou ativo', WORKTREE_PRESERVATION_REQUIRED: 'Preservação do HEAD não comprovada', WORKTREE_LOCKED: 'Worktree bloqueada', WORKTREE_STALE: 'Worktree ausente ou alterada', WORKTREE_OWNERSHIP_REQUIRED: 'Há uma concessão de escrita não liberada', WORKTREE_LINK_NOT_ALLOWED: 'Links no checkout impedem a remoção segura', WORKTREE_SUBMODULE_NOT_ALLOWED: 'O checkout contém submódulos; resolva a preservação antes de remover', WORKTREE_HIDDEN_INDEX_FLAGS: 'O índice pode ocultar alterações locais; resolva as flags antes de remover' }
export function orderBranches(branches: BranchRecord[]) {
  return [...branches].sort((a, b) => (b.creation.at ? Date.parse(b.creation.at) : 0) - (a.creation.at ? Date.parse(a.creation.at) : 0) || a.ref.localeCompare(b.ref) || a.key.localeCompare(b.key))
}
type Preview = { kind: 'DISCARD'; value: BranchDiscardPreview } | { kind: 'REMOVAL'; value: WorktreeRemovalPreview }

export function BranchManagerView({ state, active = true, onCommit, onArtifact }: { state: ActiveProjectState; active?: boolean; onCommit?: (intent: CommitNavigationIntent) => void; onArtifact?: (intent: ArtifactNavigation) => void }) {
  const [inventory, setInventory] = useState<BranchInventory | null>(null), [prs, setPrs] = useState<BranchPullRequests | null>(null)
  const [selected, setSelected] = useState<string | null>(null), [filter, setFilter] = useState(''), [limit, setLimit] = useState(50)
  const [baseRef, setBaseRef] = useState('refs/heads/main'), [history, setHistory] = useState<BranchHistoryPage | null>(null)
  const [prCommits, setPrCommits] = useState<PullRequestCommitsPage | null>(null), [tree, setTree] = useState<ObservableWorktree | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false), [remoteLoading, setRemoteLoading] = useState(false), [stale, setStale] = useState(false), [error, setError] = useState(''), [receipt, setReceipt] = useState('')
  const epoch = useRef(0), detailEpoch = useRef(0), alive = useRef(true), activeRef = useRef(active), refreshing = useRef(false)
  const dialog = useRef<HTMLDivElement>(null), previousFocus = useRef<HTMLElement | null>(null)
  const pendingMutation = useRef<{ previewId: string; operation: BranchManagerOperation } | null>(null)
  const detail = useRef<HTMLElement>(null), detailReturnFocus = useRef<HTMLElement | null>(null)
  const projectId = state.project?.id, revision = state.revision
  activeRef.current = active
  const query = useCallback(async (operation: BranchManagerOperation): Promise<BranchManagerData> => {
    const result = await window.codeAwareness.getBranchOrchestration({ context: { projectId: projectId!, revision }, operation })
    if (!result.success) throw new Error(result.code)
    if (result.context.projectId !== projectId || result.context.revision !== revision) throw new Error('PROJECT_CONTEXT_CHANGED')
    return result.data
  }, [projectId, revision])
  const refresh = useCallback(async () => {
    if (!projectId || refreshing.current) return
    refreshing.current = true
    const request = ++epoch.current
    detailEpoch.current++; setBusy(false); setLoading(true); setError(''); setPrs(null); setHistory(null); setPrCommits(null); setTree(null); setPreview(null)
    try {
      const data = await query({ action: 'INVENTORY' })
      if (!alive.current || request !== epoch.current) return
      if (data.kind !== 'INVENTORY') throw new Error('UNEXPECTED_RESPONSE')
      setInventory(data.inventory); setStale(false)
      setSelected(key => data.inventory.branches.some(b => b.key === key) ? key : null)
      setBaseRef(ref => data.inventory.branches.some(b => b.ref === ref) ? ref : data.inventory.branches.find(b => b.namespace === 'LOCAL')?.ref ?? '')
      setLoading(false); setRemoteLoading(true)
      void query({ action: 'PULL_REQUESTS', inventoryRevision: data.inventory.revision }).then(remote => {
        if (alive.current && request === epoch.current && remote.kind === 'PULL_REQUESTS' && remote.inventoryRevision === data.inventory.revision && remote.pullRequests.repositoryId === data.inventory.repositoryId) setPrs(remote.pullRequests)
      }).catch(failure => { if (alive.current && request === epoch.current) setError(`PRs indisponíveis: ${failure.message}`) }).finally(() => { if (alive.current && request === epoch.current) setRemoteLoading(false) })
    } catch (failure) { if (alive.current && request === epoch.current) { setError(failure instanceof Error ? failure.message : 'Inventário indisponível'); setStale(true) } }
    finally { if (alive.current && request === epoch.current) { setLoading(false); refreshing.current = false } }
  }, [projectId, query])
  useEffect(() => {
    alive.current = true; refreshing.current = false
    setInventory(null); setSelected(null); setFilter(''); setLimit(50); setReceipt('')
    if (activeRef.current) void refresh()
    return () => { alive.current = false; epoch.current++; detailEpoch.current++ }
  }, [refresh])
  useEffect(() => {
    if (!active) { detailEpoch.current++; setPreview(null); setTree(null); setStale(true); setBusy(false) }
  }, [active])
  useEffect(() => {
    if (preview) { previousFocus.current = document.activeElement as HTMLElement; dialog.current?.focus() }
    else previousFocus.current?.focus()
  }, [preview])
  useEffect(() => { if (selected) detail.current?.focus({ preventScroll: true }); else detailReturnFocus.current?.focus({ preventScroll: true }) }, [selected])
  const branch = inventory?.branches.find(b => b.key === selected) ?? null
  const worktreeQuery = (extra: Pick<OrchestrationRequest, 'changes' | 'documents'>) => window.codeAwareness.getWorkOrchestration({ context: { projectId: projectId!, revision }, ...extra })
  const choose = (record: BranchRecord) => { detailReturnFocus.current = document.activeElement as HTMLElement; detailEpoch.current++; setSelected(record.key); setHistory(null); setPrCommits(null); setTree(null); setError('') }
  const run = async (operation: BranchManagerOperation, apply: (data: BranchManagerData) => void) => {
    const request = detailEpoch.current, version = epoch.current
    setBusy(true); setError('')
    try {
      const data = await query(operation)
      if (alive.current && activeRef.current && request === detailEpoch.current && version === epoch.current) apply(data)
    } catch (failure) { if (alive.current && version === epoch.current) setError(failure instanceof Error ? failure.message : 'Operação indisponível') }
    finally { if (alive.current && version === epoch.current) setBusy(false) }
  }
  const readHistory = (mode: 'REACHABLE' | 'EXCLUSIVE', cursor?: string) => branch && void run({ action: 'COMMITS', query: { ref: branch.ref, revision: branch.revision, mode, ...(mode === 'EXCLUSIVE' ? { baseRef } : {}), cursor } }, data => {
    if (data.kind === 'COMMITS') setHistory(previous => cursor && previous ? { ...data.page, commits: [...previous.commits, ...data.page.commits] } : data.page)
  })
  const readPr = (pr: PullRequestRecord, page = 1) => void run({ action: 'PR_COMMITS', number: pr.number, head: pr.head.sha, page }, data => { if (data.kind === 'PR_COMMITS') setPrCommits(previous => page > 1 && previous?.prNumber === pr.number ? { ...data.page, commits: [...previous.commits, ...data.page.commits] } : data.page) })
  const prepareRemoval = (record: BranchWorktree) => void run({ action: 'PREPARE_REMOVAL', worktreeId: record.worktreeId, generation: record.generation }, data => { if (data.kind === 'REMOVAL_PREVIEW') { setConsent(false); setPreview({ kind: 'REMOVAL', value: data.preview }) } })
  const observe = async (record: BranchWorktree) => {
    const request = ++detailEpoch.current, version = epoch.current
    setBusy(true); setError('')
    try {
      const result = await window.codeAwareness.getWorkOrchestration({ context: { projectId: projectId!, revision }, worktree: { worktreeId: record.worktreeId } })
      if (alive.current && activeRef.current && request === detailEpoch.current && version === epoch.current) {
        if (!result.success) throw new Error(result.code)
        if ('worktree' in result.data && result.data.worktree.generation === record.generation) setTree(result.data.worktree)
      }
    } catch (failure) { if (alive.current && version === epoch.current) setError(failure instanceof Error ? failure.message : 'Observação indisponível') }
    finally { if (alive.current && version === epoch.current) setBusy(false) }
  }
  const execute = () => {
    if (!preview || !consent || preview.value.blockers.length) return
    const operationId = crypto.randomUUID()
    const operation: BranchManagerOperation = pendingMutation.current?.previewId === preview.value.previewId ? pendingMutation.current.operation : preview.kind === 'DISCARD' ? { action: 'EXECUTE_DISCARD', request: { previewId: preview.value.previewId, operationId, confirmed: true, preserveExclusive: consent } } : { action: 'EXECUTE_REMOVAL', request: { previewId: preview.value.previewId, operationId, releasedByUser: true } }
    pendingMutation.current = { previewId: preview.value.previewId, operation }
    void run(operation, data => {
      if (data.kind !== 'MUTATION') return
      if (data.result.isError) { setError(String(data.result.value.code)); return }
      const value = data.result.value
      setReceipt(value.recoveryRef ? `Branch descartada. Recuperação: ${value.recoveryRef} · ${value.recoveryHead}` : `Worktree removida. Branch preservada: ${value.preservationRef} · ${value.preservationHead}`)
      setPreview(null); void refresh()
      pendingMutation.current = null
    })
  }
  const openCommit = (sha: string) => onCommit?.({ projectId: projectId!, revision, commitSha: sha, requestId: crypto.randomUUID() })
  const renderTree = (record: BranchWorktree) => <li key={record.worktreeId} className="bm-worktree"><div><strong>{record.branch ?? 'Detached HEAD'}</strong><code>{record.path}</code><small>{record.missing ? 'Diretório ausente' : record.locked ? 'Bloqueada' : record.detached ? 'Sem branch associada' : 'Checkout registrado'} · diretório: {date(record.creation?.at ?? null)} ({record.creation?.quality === 'ESTIMATED' ? 'estimativa' : 'desconhecido'})</small></div><button disabled={busy || stale} onClick={() => void observe(record)}>Contexto</button><button disabled={busy || stale} onClick={() => prepareRemoval(record)}>Remover Worktree…</button></li>
  const visible = orderBranches(inventory?.branches ?? []).filter(b => `${b.name} ${b.ref}`.toLowerCase().includes(filter.toLowerCase()))
  const branchRelations = prs?.relations.filter(r => r.branchKey === branch?.key && r.branchRevision === branch?.revision) ?? []
  const branchTrees = branch ? inventory?.worktrees.filter(w => branch.worktrees.some(link => link.worktreeId === w.worktreeId && link.generation === w.generation)) ?? [] : []
  return <main className="wo-view bm-view" aria-label="Gestor por branch">
    <header className="wo-header"><div className="wo-feature-identity"><span className="wo-feature-icon"><GitBranch size={34}/></span><div><h1>Work Orchestration</h1><p>Branches, entregas e ambientes de trabalho</p></div></div><button onClick={() => void refresh()} disabled={loading || busy || !active}><RefreshCw size={16}/> Atualizar</button></header>
    <div className="bm-toolbar"><label>Filtrar branches <input value={filter} onChange={e => { setFilter(e.target.value); setLimit(50) }} placeholder="Nome ou referência"/></label><span>{inventory ? `Inventário completo · ${inventory.branches.length} branches · ${inventory.worktrees.length} Worktrees` : loading ? 'Lendo inventário Git…' : 'Inventário indisponível'}</span></div>
    {error && <p role="alert" className="wo-warning">{error}</p>}{receipt && <p role="status" className="bm-receipt">{receipt}</p>}
    {stale && <p role="status" className="wo-warning">Estado precisa de atualização antes de agir.</p>}
    <div className="bm-remote" role="status">{remoteLoading ? 'Consultando PRs… O inventário local já está disponível.' : prs ? prs.catalog.coverage === 'COMPLETE' ? `GitHub · ${prs.catalog.items.length} PRs observados em ${date(prs.catalog.observedAt)}` : `PRs: cobertura ${prs.catalog.coverage === 'PARTIAL' ? 'parcial' : 'indisponível'} · ${prs.catalog.reason ?? 'não conclusiva'}` : 'PRs ainda não observados'}</div>
    <div className={`bm-layout${branch ? ' bm-has-selection' : ''}`}>
      <section className="bm-list" aria-label="Timeline de branches"><h2>Branches <small>{visible.length}</small></h2>
        {visible.slice(0, limit).map((record, index, rows) => <React.Fragment key={record.key}>{(index === 0 || !!record.creation.at !== !!rows[index - 1].creation.at) && <h3>{record.creation.at ? 'Criação com evidência' : 'Data de criação desconhecida'}</h3>}<button disabled={busy} className={`bm-card${selected === record.key ? ' selected' : ''}`} aria-pressed={selected === record.key} onClick={() => choose(record)}>
          <span className="bm-card-title"><GitBranch size={17}/><strong title={record.ref}>{record.name}</strong><small>{record.namespace === 'TRACKING' ? 'Tracking local' : 'Local'}</small></span>
          <span className="bm-card-meta">{record.worktrees.length ? `${record.worktrees.length} Worktree(s)` : 'Sem checkout associado'} · HEAD {record.head.slice(0, 8)}</span>
          <span className="bm-card-meta">{record.creation.at ? `Criada em ${date(record.creation.at)} · ${record.creation.source === 'APP_RECEIPT' ? 'recibo do app' : 'histórico local'}` : `Último commit: ${date(record.lastCommitAt)}`}</span>
          <span className="bm-pr-summary">{prs ? prs.relations.filter(r => r.branchKey === record.key && r.branchRevision === record.revision && r.classification === 'CONFIRMED_CURRENT').map(r => `#${r.pullRequest.number} ${r.pullRequest.merged ? 'integrado' : r.pullRequest.state === 'open' ? r.pullRequest.draft ? 'draft' : 'aberto' : 'fechado'}`).join(' · ') || (prs.catalog.coverage === 'COMPLETE' ? 'Sem entrega corrente confirmada' : 'PR não conclusivo') : 'PR não observado'}</span>
        </button></React.Fragment>)}
        {!visible.length && inventory && <p>Nenhuma branch neste filtro.</p>}{visible.length > limit && <button onClick={() => setLimit(n => n + 50)}>Mostrar mais branches</button>}
        {!!inventory?.unassignedWorktrees.length && <section aria-label="Worktrees sem branch confirmada"><h2>Worktrees sem branch confirmada</h2><ul className="bm-trees">{inventory.unassignedWorktrees.map(renderTree)}</ul></section>}
        {!!prs?.orphaned.length && <details><summary>PRs sem vínculo corrente confirmado ({prs.orphaned.length})</summary><ul className="bm-pr-list">{prs.orphaned.map(pr => <li key={pr.id}>#{pr.number} · {pr.title}<small>{pr.head.repository ?? 'Origem removida'}:{pr.head.ref} · {pr.head.sha.slice(0, 8)}</small><span>{pr.merged ? 'Integrado no GitHub' : pr.state === 'open' ? 'Aberto' : 'Fechado sem merge'}</span></li>)}</ul></details>}
      </section>
      {branch && <aside className="bm-detail" ref={detail} tabIndex={-1} aria-label="Detalhes da branch" onKeyDown={event => { if (event.key === 'Escape' && !busy) { detailEpoch.current++; setSelected(null); setTree(null) } }}><header><h2 title={branch.ref}>{branch.name}</h2><button disabled={busy} aria-label="Fechar detalhes" onClick={() => { detailEpoch.current++; setSelected(null); setTree(null) }}><X size={16}/></button></header>
        <dl><dt>Referência</dt><dd>{branch.ref}</dd><dt>HEAD observado</dt><dd>{branch.head}</dd><dt>Criação</dt><dd>{date(branch.creation.at)}{branch.creation.at && ` · ${branch.creation.source === 'APP_RECEIPT' ? 'Recibo do app' : 'Evidência histórica local'}`}</dd><dt>Último commit</dt><dd>{date(branch.lastCommitAt)}</dd>{branch.upstream && <><dt>Upstream local</dt><dd>{branch.upstream}</dd></>}</dl>
        <BranchExecutions branch={branch} active={active} query={query} onArtifact={onArtifact}/><section><h3>PRs e entregas</h3>{!branchRelations.length && <p>{remoteLoading ? 'Consultando…' : 'Sem vínculo confirmado. Consulte a cobertura GitHub acima.'}</p>}<ul className="bm-pr-list">{branchRelations.map(relation => { const pr = relation.pullRequest; return <li key={pr.id}><strong>#{pr.number} · {pr.title}</strong><span>{pr.merged ? 'Integrado no GitHub' : pr.state === 'closed' ? 'Fechado sem merge' : pr.draft ? 'Draft' : 'Aberto'}</span><small>{relationLabel[relation.classification]}</small><small>PR criado em {date(pr.createdAt)} · base {pr.base.ref} · HEAD {pr.head.sha.slice(0, 8)}</small><button disabled={busy || stale} onClick={() => readPr(pr)}>Commits desta entrega PR</button></li> })}</ul>
          {prCommits && <div><h4>Commits do PR #{prCommits.prNumber} · GitHub</h4><ul className="bm-commits">{prCommits.commits.map(c => <li key={c.sha}><code>{c.sha.slice(0, 8)}</code> {c.title}<small>Data do commit: {date(c.committedAt)}</small></li>)}</ul>{prCommits.nextPage && <button disabled={busy || stale} onClick={() => { const pr = branchRelations.find(r => r.pullRequest.number === prCommits.prNumber)?.pullRequest; if (pr) readPr(pr, prCommits.nextPage!) }}>Mais commits do PR</button>}</div>}
        </section>
        <section><h3>História Git</h3><label>Destino da comparação <select value={baseRef} disabled={busy || stale} onChange={e => { detailEpoch.current++; setBaseRef(e.target.value); setHistory(null) }}>{inventory?.branches.filter(b => b.namespace === 'LOCAL').map(b => <option key={b.ref} value={b.ref}>{b.name}</option>)}</select></label><div className="bm-actions"><button disabled={busy || stale} onClick={() => readHistory('REACHABLE')}>História alcançável</button><button disabled={busy || stale || !baseRef || baseRef === branch.ref} onClick={() => readHistory('EXCLUSIVE')}>Commits exclusivos</button></div>
          {history && <><p>{history.mode === 'REACHABLE' ? 'História alcançável do HEAD — inclui ancestrais herdados.' : `Exclusivos em relação a ${history.base?.ref} · ${history.base?.head.slice(0, 8)}`}</p><ul className="bm-commits">{history.commits.map(c => <li key={c.sha}><button disabled={!onCommit} onClick={() => openCommit(c.sha)}>{c.title} · {c.sha.slice(0, 8)}</button><small>Data do commit: {date(c.committedAt)}</small></li>)}</ul>{!history.commits.length && <p>Nenhum commit nesta comparação.</p>}{history.nextCursor && <button disabled={busy || stale} onClick={() => readHistory(history.mode, history.nextCursor!)}>Mais commits</button>}</>}
        </section>
        <section><h3>Worktrees associadas</h3>{branchTrees.length ? <ul className="bm-trees">{branchTrees.map(renderTree)}</ul> : <p>Sem checkout associado a esta referência.</p>}</section>
        {branch.namespace === 'LOCAL' && <button className="bm-danger" disabled={busy || stale || !baseRef || baseRef === branch.ref} onClick={() => void run({ action: 'PREPARE_DISCARD', ref: branch.ref, revision: branch.revision, baseRef }, data => { if (data.kind === 'DISCARD_PREVIEW') { setConsent(false); setPreview({ kind: 'DISCARD', value: data.preview }) } })}>Preparar descarte da branch…</button>}
      </aside>}
      {tree && <aside className="bm-detail bm-tree-detail" aria-label="Contexto da Worktree"><header><h2>{tree.branch ?? 'Detached HEAD'}</h2><button aria-label="Fechar contexto" onClick={() => setTree(null)}><X size={16}/></button></header><p>{tree.path}</p><p>{tree.observation === 'VERIFIED' ? 'Observação verificada' : 'Observação indisponível'}{tree.reason && ` · ${tree.reason}`}</p><WorktreeCommitsDisclosure tree={tree} context={{ projectId: projectId!, revision }} active={active && !stale} onCommit={onCommit}/><LocalChangesInspector tree={tree} query={worktreeQuery} revalidate={() => void observe(tree)} stale={() => setTree(value => value && { ...value, observation: 'STALE' })}/><WorktreeDocumentContext tree={tree} query={worktreeQuery}/></aside>}
    </div>
    {preview && <div className="bm-modal-backdrop"><div role="dialog" aria-modal="true" aria-label={preview.kind === 'DISCARD' ? 'Confirmar descarte da branch' : 'Preparar remoção da Worktree'} tabIndex={-1} ref={dialog} className="bm-modal" onKeyDown={event => {
      if (event.key === 'Escape' && !busy) setPreview(null)
      if (event.key === 'Tab') { const nodes = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)'); if (nodes?.length) { const first = nodes[0], last = nodes[nodes.length - 1]; if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() } } }
    }}><h2>{preview.kind === 'DISCARD' ? 'Descartar branch local' : 'Remover Worktree'}</h2><p>Repositório: {preview.value.repositoryId}</p>
      {preview.kind === 'DISCARD' ? <><code>{preview.value.branch.ref}</code><p>HEAD: {preview.value.branch.head}</p><p>Destino: {preview.value.base.ref} · {preview.value.base.head}</p><p>{preview.value.exclusiveCount} commits exclusivos. {preview.value.integrated ? 'Ancestralidade integrada ao destino.' : 'Origem ainda não integrada por ancestralidade; inclusive squash/rebase.'}</p><p>Worktrees ocupantes: {preview.value.worktrees.length}. PRs conhecidos: {preview.value.remote.knownPullRequests.map(p => `#${p.number} ${p.merged ? 'integrado' : p.state}`).join(', ') || 'nenhum observado'}.</p><p>Será criada e verificada uma referência durável de recuperação antes do descarte. Branch remota, PRs e Worktrees são preservados.</p><ul>{preview.value.exclusiveSample.map(sha => <li key={sha}><code>{sha}</code></li>)}</ul></> : <><code>{preview.value.worktree.path}</code><p>Branch preservada: {preview.value.preservationRef} · {preview.value.preservationHead}</p><p>Staged: {preview.value.stagedCount ?? '?'} · Unstaged: {preview.value.unstagedCount ?? '?'} · Untracked: {preview.value.untrackedCount ?? '?'} · Ignored: {preview.value.ignoredCount ?? '?'}</p><p>A confirmação local seguinte verifica a liberação da IDE e dos agentes.</p></>}
      {preview.kind === 'DISCARD' && <><p>Cobertura remota: {preview.value.remote.coverage} · observada em {date(preview.value.remote.observedAt)}. Proteção: {preview.value.remote.protected === null ? 'desconhecida' : preview.value.remote.protected ? 'protegida' : 'observada sem proteção'}.</p><ul>{preview.value.checkouts?.map(checkout => <li key={checkout.worktreeId}><code>{checkout.path}</code><p>{checkout.coverage === 'OBSERVED' ? `Staged: ${checkout.stagedCount} · Unstaged: ${checkout.unstagedCount} · Untracked: ${checkout.untrackedCount} · Ignored: ${checkout.ignoredCount}` : 'Conteúdo local não observado'}</p></li>)}</ul></>}
      {preview.value.blockers.length ? <ul role="alert">{preview.value.blockers.map(code => <li key={code}>{blockers[code] ?? code}</li>)}</ul> : <label className="bm-consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/>{preview.kind === 'DISCARD' ? 'Autorizo descartar esta branch e preservar seus commits na referência de recuperação.' : 'Quero remover este diretório; vou confirmar a liberação da IDE e dos agentes.'}</label>}
      {error && <p role="alert">{error}</p>}<div className="bm-actions"><button disabled={busy} onClick={() => setPreview(null)}>Cancelar</button><button className="bm-danger" disabled={busy || !consent || !!preview.value.blockers.length} onClick={execute}>{busy ? 'Revalidando…' : preview.kind === 'DISCARD' ? 'Confirmar descarte' : 'Confirmar liberação e remoção…'}</button></div>
    </div></div>}
  </main>
}
