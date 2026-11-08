import type { AcademyGitStatusProjection, AcademyOpenAiReleaseStatus } from '../../../../shared/types/academy-types'

type Signal = { label: string; tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral' }

export function gitPresentation(git: AcademyGitStatusProjection | null, hydration: string): Signal {
  if (hydration !== 'READY') return { label: hydration === 'ERROR' ? 'Estado indisponível' : 'Carregando…', tone: 'neutral' }
  if (!git || git.syncState === 'UNCONFIGURED') return { label: 'Não configurado', tone: 'neutral' }
  if (git.syncState === 'CONFLICT') return { label: 'Conflito · revisão necessária', tone: 'danger' }
  if (git.syncState === 'PR_PENDING') return { label: 'Aguardando revisão de PR', tone: 'warning' }
  if (git.syncState === 'OFFLINE') return { label: 'Offline · verificação pendente', tone: 'warning' }
  if (git.syncState === 'ERROR') return { label: 'Falha na sincronização', tone: 'danger' }
  if (git.syncState === 'SYNCING' || git.publication?.phase === 'RECONCILING') return { label: 'Reconciliando', tone: 'info' }
  if (git.syncState === 'SYNCED') {
    if (git.remoteCheck?.state !== 'OK' || git.convergence && (git.convergence.freshness !== 'OBSERVED' || git.convergence.pending)) return { label: 'Última sincronização conhecida; verificação pendente', tone: 'neutral' }
    return { label: 'Sincronizado · remoto observado', tone: 'success' }
  }
  const states: Partial<Record<AcademyGitStatusProjection['syncState'], string>> = {
    LOCAL_CHANGES: 'Edições locais pendentes', REMOTE_CHANGES: 'Atualização remota disponível', MERGEABLE_BOTH: 'Alterações locais e remotas',
    DIRTY: 'Workspace com alterações', PUSH_PENDING: 'Publicação pendente', LOCAL_DRIFT: 'Divergência local', REMOTE_DIVERGED: 'Histórico remoto divergente', UNKNOWN: 'Verificação pendente'
  }
  return { label: states[git.syncState] ?? 'Verificação pendente', tone: 'warning' }
}

export function releasePresentation(release: { status: AcademyOpenAiReleaseStatus } | null | undefined, drifted: boolean): Signal {
  if (!release) return { label: 'Não disponível', tone: 'neutral' }
  if (drifted) return { label: 'Conteúdo alterado · preparar revisão', tone: 'warning' }
  const states: Record<AcademyOpenAiReleaseStatus, Signal> = {
    READY_TO_UPLOAD: { label: 'Preparado · entrega manual', tone: 'info' },
    UPLOADED_UNVERIFIED: { label: 'Upload não verificado', tone: 'neutral' },
    VERIFIED: { label: 'Verificado por evidência', tone: 'success' },
    STALE: { label: 'Desatualizado', tone: 'warning' },
    SUPERSEDED: { label: 'Substituído', tone: 'neutral' },
    BLOCKED: { label: 'Bloqueado · revisar', tone: 'danger' }
  }
  return states[release.status]
}
