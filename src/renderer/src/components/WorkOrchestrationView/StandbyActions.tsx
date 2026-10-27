import React, { useState } from 'react'
import type { BranchRecord, BranchWorktree } from '../../../../shared/types/branch-orchestration-types'
import type { BranchManagerData, BranchManagerOperation } from '../../../../shared/types/branch-manager-types'
import type { RuntimePreviewRequest, RuntimePreviewStandbyPolicy } from '../../../../shared/types/runtime-preview-operations'

export function StandbyActions({ branch, worktrees, query, disabled }: { branch: BranchRecord; worktrees: BranchWorktree[]; query(operation: BranchManagerOperation): Promise<BranchManagerData>; disabled: boolean }) {
  const [treeId, setTreeId] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const tree = worktrees.find(value => value.worktreeId === treeId) ?? (worktrees.length === 1 ? worktrees[0] : undefined)
  const call = async (request: RuntimePreviewRequest) => {
    const result = await query({ action: 'PREVIEW_RUNTIME', request })
    if (result.kind !== 'PREVIEW_RUNTIME' || !result.result.success) throw Error(result.kind === 'PREVIEW_RUNTIME' && !result.result.success ? result.result.code : 'PREVIEW_UNAVAILABLE')
    return result.result.data
  }
  const act = async (action: 'PREPARE' | 'TRUST' | 'REVOKE') => {
    setBusy(true); setMessage('')
    try {
      if (action === 'REVOKE') { await call({ action: 'REVOKE_TRUST', repositoryId: branch.repositoryId }); setMessage('Confiança revogada; encerramento solicitado.'); return }
      if (!tree) throw Error('Escolha uma Worktree exata.')
      if (action === 'PREPARE') {
        await call({ action: 'PREPARE_BRANCH_APP', intent: { branch: branch.ref, repositoryId: branch.repositoryId, expectedHead: branch.head!, worktreeId: tree.worktreeId, operationId: crypto.randomUUID() } })
        setMessage('Preparo solicitado. Acompanhe o estado do preview; sem confiança válida, nenhum processo será iniciado.')
      } else {
        const profiles = await call({ action: 'PROFILES', repositoryId: branch.repositoryId })
        const profile = profiles.kind === 'PROFILES' ? profiles.profiles.find(value => value.profileId === 'code-awareness-' + tree.worktreeId) : undefined
        if (!profile) throw Error('Solicite o preparo uma vez para identificar o perfil deste alvo; sem confiança, isso não inicia processos.')
        if (Object.values(values).length !== 6 || Object.values(values).some(value => value.trim() === '' || !Number.isFinite(Number(value)))) throw Error('Defina todos os limites antes de confiar.')
        const policy: RuntimePreviewStandbyPolicy = { idleMs: Number(values.idle) * 1000, maxPrivateBytes: Number(values.private) * 1048576,
          maxWorkingSetBytes: Number(values.working) * 1048576, maxCpuPercent: Number(values.cpu), minAvailableBytes: Number(values.available) * 1048576, sampleMs: Number(values.sample) * 1000 }
        await call({ action: 'TRUST_REPOSITORY', selection: { repositoryId: branch.repositoryId, worktreeId: tree.worktreeId, generation: tree.generation, profileId: profile.profileId, fingerprint: profile.fingerprint }, policy })
        setMessage('Revise o diálogo nativo. Após confirmar, solicite o preparo do alvo escolhido.')
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Preview indisponível') }
    finally { setBusy(false) }
  }
  return <details><summary>Preparação antecipada e limites</summary>
    <p>Um slot oculto consome RAM. Expiração ou pressão encerram o slot; a próxima abertura pode exigir preparo frio.</p>
    {worktrees.length > 1 && <label>Worktree <select value={treeId} onChange={event => setTreeId(event.target.value)}><option value="">Escolha…</option>{worktrees.map(value => <option key={value.worktreeId} value={value.worktreeId}>{value.path}</option>)}</select></label>}
    {([['idle', 'Ociosidade máxima (s)'], ['private', 'Memória privada máxima (MiB)'], ['working', 'Working set máximo (MiB)'], ['cpu', 'CPU máxima da máquina (%)'], ['available', 'Memória livre mínima (MiB)'], ['sample', 'Intervalo de medição (s)']] as const).map(([key, label]) => <label key={key}>{label}<input type="number" value={values[key] ?? ''} onChange={event => setValues(previous => ({ ...previous, [key]: event.target.value }))}/></label>)}
    <button disabled={disabled || busy || !tree} onClick={() => void act('TRUST')}>Confiar neste repositório…</button>
    <button disabled={disabled || busy || !tree} onClick={() => void act('PREPARE')}>Preparar esta Worktree</button>
    <button disabled={disabled || busy} onClick={() => void act('REVOKE')}>Revogar e encerrar</button>
    {message && <p role="status">{message}</p>}
  </details>
}
