import React, { useEffect, useRef, useState } from 'react'
import type { BranchWorktree } from '../../../../shared/types/branch-orchestration-types'
import type { BranchManagerData, BranchManagerOperation } from '../../../../shared/types/branch-manager-types'
import type { PreviewPreflight, PreviewProfileSummary } from '../../../../shared/types/runtime-preview-types'

export function RuntimePreviewPreflight({ repositoryId, worktrees, query, disabled }: { repositoryId: string; worktrees: BranchWorktree[];
  query: (operation: BranchManagerOperation) => Promise<BranchManagerData>; disabled: boolean }) {
  const [profiles, setProfiles] = useState<PreviewProfileSummary[]>([]), [profileId, setProfileId] = useState('')
  const [worktreeId, setWorktreeId] = useState(worktrees[0]?.worktreeId ?? '')
  const [targetRepositoryId, setTargetRepositoryId] = useState(repositoryId), [targetWorktrees, setTargetWorktrees] = useState<BranchWorktree[] | null>(null)
  const [repositories, setRepositories] = useState<Array<{ id: string; name: string }>>([])
  const [result, setResult] = useState<PreviewPreflight | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const epoch = useRef(0)
  const sourceKey = worktrees.map(w => `${w.worktreeId}:${w.generation}:${w.head}`).join('|')
  useEffect(() => { epoch.current++; setTargetRepositoryId(repositoryId); setTargetWorktrees(null); setWorktreeId(worktrees[0]?.worktreeId ?? ''); setProfiles([]); setProfileId(''); setResult(null); setBusy(false) }, [repositoryId, sourceKey])
  useEffect(() => { epoch.current++; setResult(null); setBusy(false); return () => { epoch.current++ } }, [disabled, query])
  const availableWorktrees = targetWorktrees ?? worktrees
  async function chooseRepository(id?: string) {
    const turn = ++epoch.current
    setBusy(true); setResult(null); setError('')
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
    setBusy(true); setError(''); setResult(null)
    try {
      const profile = profiles.find(p => p.profileId === profileId), tree = availableWorktrees.find(w => w.worktreeId === worktreeId)
      if (!profile || !tree) {
        const data = await query({ action: 'PREVIEW_PROFILES', repositoryId: targetRepositoryId })
        if (turn !== epoch.current || data.kind !== 'PREVIEW_PROFILES') return
        setProfiles(data.profiles); setProfileId(data.profiles[0]?.profileId ?? '')
        if (!data.profiles.length) setError('Nenhum perfil canônico configurado para este repositório. Configure profiles.json na área de perfis do host; a Worktree não concede permissões.')
      } else {
        const data = await query({ action: approve ? 'PREVIEW_APPROVE' : 'PREVIEW_PREFLIGHT', selection: { repositoryId: targetRepositoryId, worktreeId, generation: tree.generation, profileId, fingerprint: profile.fingerprint } })
        if (turn === epoch.current && data.kind === 'PREVIEW_PREFLIGHT') {
          setResult(data.preflight)
          if (approve) setProfiles(values => values.map(value => value.profileId === profileId ? { ...value, approved: !data.preflight.diagnostics.some(d => d.reasonCode === 'PROFILE_APPROVAL_REQUIRED') } : value))
        }
      }
    } catch (failure) {
      if (turn === epoch.current) {
        setError(failure instanceof Error ? failure.message : 'Pré-checagem indisponível')
        if (failure instanceof Error && failure.message === 'PROFILE_CHANGED') { setProfiles([]); setProfileId('') }
      }
    }
    finally { if (turn === epoch.current) setBusy(false) }
  }
  return <section aria-label="Pré-checagem de runtime"><h3>Runtime Preview · pré-checagem</h3>
    <p>Somente compatibilidade. Execução de processos aguarda revisão arquitetural da U1.</p>
    <button disabled={disabled || busy} onClick={() => void chooseRepository()}>Escolher repositório gerenciado</button>
    {!!repositories.length && <label>Repositório do runtime <select value={targetRepositoryId} disabled={disabled || busy} onChange={e => void chooseRepository(e.target.value)}>{repositories.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}
    <p>Alvo: {targetRepositoryId}. A seleção do projeto ativo permanece inalterada.</p>
    <label>Worktree <select value={worktreeId} disabled={disabled || busy} onChange={e => { setWorktreeId(e.target.value); setResult(null) }}>{availableWorktrees.map(w => <option key={w.worktreeId} value={w.worktreeId}>{w.branch ?? 'Detached'} · {w.path}</option>)}</select></label>
    {!!profiles.length && <label>Perfil <select value={profileId} disabled={disabled || busy} onChange={e => { setProfileId(e.target.value); setResult(null) }}>{profiles.map(p => <option key={p.profileId} value={p.profileId}>{p.profileId} · r{p.revision} · {p.approved ? 'aprovado' : 'aprovação necessária'}</option>)}</select></label>}
    <button disabled={disabled || busy || !availableWorktrees.length} onClick={() => void request()}>{busy ? 'Verificando…' : profiles.length ? 'Verificar compatibilidade' : 'Consultar perfis'}</button>
    {result?.diagnostics.some(d => d.reasonCode === 'PROFILE_APPROVAL_REQUIRED') && <button disabled={disabled || busy} onClick={() => void request(true)}>Revisar aprovação do perfil</button>}
    {error && <p role="alert">{error}</p>}
    {result && <div role="status"><p>{result.status} · prontidão não observada · processo não implementado</p><ul>{result.diagnostics.map((d, i) => <li key={i}><strong>{d.reasonCode}</strong>: {d.message}
      {d.missingRequirements?.map((r, j) => <div key={j}><p>{r.capability}: {r.guarantee}</p><p>{r.availableMechanism.name}. {r.availableMechanism.basis}</p>{r.resolutions.map((option, k) => <p key={k}>{option.description}</p>)}</div>)}</li>)}</ul></div>}
  </section>
}
