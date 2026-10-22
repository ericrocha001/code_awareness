import React, { useEffect, useRef, useState } from 'react'
import type { BranchWorktree } from '../../../../shared/types/branch-orchestration-types'
import type { BranchManagerData, BranchManagerOperation } from '../../../../shared/types/branch-manager-types'
import type { PreviewPreflight, PreviewProfileSummary } from '../../../../shared/types/runtime-preview-types'
import { RuntimePreviewSession } from './RuntimePreviewSession'

export function RuntimePreviewPreflight({ repositoryId, worktrees, query, disabled }: { repositoryId: string; worktrees: BranchWorktree[];
  query: (operation: BranchManagerOperation) => Promise<BranchManagerData>; disabled: boolean }) {
  const [profiles, setProfiles] = useState<PreviewProfileSummary[]>([]), [profileId, setProfileId] = useState('')
  const [worktreeId, setWorktreeId] = useState(worktrees[0]?.worktreeId ?? '')
  const [targetRepositoryId, setTargetRepositoryId] = useState(repositoryId), [targetWorktrees, setTargetWorktrees] = useState<BranchWorktree[] | null>(null)
  const [repositories, setRepositories] = useState<Array<{ id: string; name: string }>>([])
  const [result, setResult] = useState<PreviewPreflight | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [startAllowed, setStartAllowed] = useState(false)
  const [preflightPending, setPreflightPending] = useState(false)
  const epoch = useRef(0)
  const sourceKey = worktrees.map(w => `${w.worktreeId}:${w.generation}:${w.head}`).join('|')
  useEffect(() => { epoch.current++; setTargetRepositoryId(repositoryId); setTargetWorktrees(null); setWorktreeId(worktrees[0]?.worktreeId ?? ''); setProfiles([]); setProfileId(''); setResult(null); setPreflightPending(false); setBusy(false) }, [repositoryId, sourceKey])
  useEffect(() => { epoch.current++; setResult(null); setPreflightPending(false); setBusy(false); return () => { epoch.current++ } }, [disabled, query])
  const availableWorktrees = targetWorktrees ?? worktrees
  async function chooseRepository(id?: string) {
    const turn = ++epoch.current
    setBusy(true); setResult(null); setPreflightPending(false); setError('')
    if (id) { setTargetRepositoryId(id); setTargetWorktrees([]); setWorktreeId(''); setProfiles([]); setProfileId('') }
    try {
      if (!id) {
        const records = await window.codeAwareness.listRepositories()
        if (turn === epoch.current) setRepositories(records.filter(r => r.status === 'ACTIVE' && r.localCheckout?.availability === 'AVAILABLE' && r.localCheckout.gitState === 'GIT'))
      } else {
        const data = await query({ action: 'PREVIEW_WORKTREES', repositoryId: id })
        if (turn === epoch.current && data.kind === 'PREVIEW_WORKTREES' && data.repositoryId === id) { setTargetWorktrees(data.worktrees); setWorktreeId(data.worktrees[0]?.worktreeId ?? '') }
      }
    } catch (failure) { if (turn === epoch.current) setError(failure instanceof Error ? failure.message : 'Repositório indisponível') }
    finally { if (turn === epoch.current) setBusy(false) }
  }
  async function request(approve = false) {
    const turn = ++epoch.current
    setBusy(true); setError(''); setResult(null); setStartAllowed(false)
    try {
      const profile = profiles.find(p => p.profileId === profileId), tree = availableWorktrees.find(w => w.worktreeId === worktreeId)
      if (!profile || !tree) {
        const data = await query({ action: 'PREVIEW_PROFILES', repositoryId: targetRepositoryId })
        if (turn !== epoch.current || data.kind !== 'PREVIEW_PROFILES') return
        setProfiles(data.profiles); setProfileId(data.profiles[0]?.profileId ?? '')
        if (!data.profiles.length) setError('Nenhum perfil canônico configurado para este repositório. Configure profiles.json na área de perfis do host; a Worktree não concede permissões.')
      } else {
        const selection = { repositoryId: targetRepositoryId, worktreeId, generation: tree.generation, profileId, fingerprint: profile.fingerprint }
        const data = await query({ action: 'PREVIEW_RUNTIME', request: preflightPending ? { action: 'LIST', repositoryId: targetRepositoryId, worktreeId, limit: 1 } : { action: approve ? 'AUTHORIZE' : 'PREFLIGHT', selection } })
        if (turn === epoch.current && data.kind === 'PREVIEW_RUNTIME') {
          if (!data.result.success) throw new Error(data.result.code)
          let check = data.result.data
          if (check.kind === 'SESSION' && check.pending || check.kind === 'SESSIONS' && check.pendingOperationId) { setPreflightPending(true); return }
          if (check.kind === 'SESSIONS') {
            const completed = check.lastOperation?.result
            if (!completed?.success) throw new Error(check.lastOperation?.code ?? 'PREVIEW_RESULT_UNAVAILABLE')
            check = completed.data
          }
          if (check.kind !== 'PREFLIGHT' || !(Object.keys(selection) as Array<keyof typeof selection>).every(key => check.kind === 'PREFLIGHT' && check.preflight.selection?.[key] === selection[key])) throw new Error('PREVIEW_RESULT_UNAVAILABLE')
          setPreflightPending(false)
          setResult(check.preflight); setStartAllowed(check.startAllowed)
          setProfiles(values => values.map(value => value.profileId === profileId ? { ...value, approved: !check.preflight.diagnostics.some(d => d.reasonCode === 'PROFILE_APPROVAL_REQUIRED') } : value))
        }
      }
    } catch (failure) {
      if (turn === epoch.current) {
        setError(failure instanceof Error ? failure.message : 'Pré-checagem indisponível')
        setPreflightPending(false)
        if (failure instanceof Error && failure.message === 'PROFILE_CHANGED') { setProfiles([]); setProfileId('') }
      }
    }
    finally { if (turn === epoch.current) setBusy(false) }
  }
  const selectedProfile = profiles.find(profile => profile.profileId === profileId), selectedTree = availableWorktrees.find(tree => tree.worktreeId === worktreeId)
  return <section className="runtime-preview" aria-label="Runtime Preview"><h3>Runtime Preview</h3>
    <p>Execute e qualifique esta Worktree em uma sessão isolada.</p>
    <button disabled={disabled || busy} onClick={() => void chooseRepository()}>Escolher repositório gerenciado</button>
    {!!repositories.length && <label>Repositório do runtime <select value={targetRepositoryId} disabled={disabled || busy} onChange={e => void chooseRepository(e.target.value)}>{repositories.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}
    <p>Alvo: {targetRepositoryId}. A seleção do projeto ativo permanece inalterada.</p>
    <label>Worktree <select value={worktreeId} disabled={disabled || busy} onChange={e => { setWorktreeId(e.target.value); setResult(null); setPreflightPending(false) }}>{availableWorktrees.map(w => <option key={w.worktreeId} value={w.worktreeId}>{w.branch ?? 'Detached'} · {w.path}</option>)}</select></label>
    {!!profiles.length && <label>Perfil <select value={profileId} disabled={disabled || busy} onChange={e => { setProfileId(e.target.value); setResult(null); setPreflightPending(false) }}>{profiles.map(p => <option key={p.profileId} value={p.profileId}>{p.profileId} · r{p.revision} · {p.approved ? 'aprovado' : 'aprovação necessária'}</option>)}</select></label>}
    <button disabled={disabled || busy || !availableWorktrees.length} onClick={() => void request()}>{busy ? 'Verificando…' : preflightPending ? 'Consultar pré-checagem' : profiles.length ? 'Verificar compatibilidade' : 'Consultar perfis'}</button>
    {preflightPending && <p role="status">Pré-checagem em andamento. Consulte o resultado sob demanda.</p>}
    {result?.diagnostics.some(d => d.reasonCode === 'PROFILE_APPROVAL_REQUIRED') && <button disabled={disabled || busy} onClick={() => void request(true)}>Revisar aprovação do perfil</button>}
    {error && <p role="alert">{error}</p>}
    {result && <div role="status"><p>{result.status} · {startAllowed ? 'perfil habilitado para lançamento verificado' : 'lançamento bloqueado'} · prontidão ainda não observada</p><ul>{result.diagnostics.map((d, i) => <li key={i}><strong>{d.reasonCode}</strong>: {d.message}
      {d.missingRequirements?.map((r, j) => <div key={j}><p>{r.capability}: {r.guarantee}</p><p>{r.availableMechanism.name}. {r.availableMechanism.basis}</p>{r.resolutions.map((option, k) => <p key={k}>{option.description}</p>)}</div>)}</li>)}</ul></div>}
    {selectedTree && <RuntimePreviewSession key={`${targetRepositoryId}:${worktreeId}:${selectedProfile?.fingerprint ?? ''}`} repositoryId={targetRepositoryId} worktreeId={worktreeId}
      selection={selectedProfile ? { repositoryId: targetRepositoryId, worktreeId, generation: selectedTree.generation, profileId, fingerprint: selectedProfile.fingerprint } : null}
      startAllowed={!!result && startAllowed} disabled={disabled || busy} query={query}/>}
  </section>
}
