import React from 'react'
import { gitPresentation, releasePresentation } from './academy-presentation'
import {
  BookOpen,
  Box,
  Check,
  ChevronRight,
  CircleAlert,
  Cloud,
  Code2,
  FileCode2,
  FolderGit2,
  GitBranch,
  History,
  Package,
  PanelRightOpen,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react'
import type {
  AcademyConflictSummary,
  AcademyDestination,
  AcademyDistributionHealth,
  AcademyDistributionState,
  AcademyGitStatusProjection,
  AcademyOpenAiPublicationState,
  AcademyPackageDistributionState,
  AcademySkillDetail,
  AcademySkillScope,
  AcademySkillSummary,
  AcademySkillVersion
} from '../../../../shared/types/academy-types'
import type { RepositoryRecord } from '../../../../shared/types/repository-catalog-types'
import { AcademyConflicts } from './AcademyConflicts'

export type AcademyTab = 'skill' | 'files' | 'overview' | 'history'

const formatDate = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : 'Ainda não executado'
const friendlyState = (value: string) => value.replaceAll('_', ' ').toLocaleLowerCase().replace(/^./, (character) => character.toUpperCase())

const StatusBadge: React.FC<{ tone?: 'success' | 'warning' | 'danger' | 'info' | 'neutral'; children: React.ReactNode }> = ({ tone = 'neutral', children }) => (
  <span className={`academy-badge academy-badge-${tone}`}>{children}</span>
)

const RailCard: React.FC<{ icon: React.ReactNode; title: string; count?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }> = ({ icon, title, count, action, children, className = '' }) => (
  <section className={`academy-rail-card ${className}`}>
    <header className="academy-rail-card-header">
      <span className="academy-rail-card-icon" aria-hidden="true">{icon}</span>
      <h2>{title}</h2>
      {count && <span className="academy-count">{count}</span>}
      {action}
    </header>
    {children}
  </section>
)

interface AcademyHeaderProps {
  conflictCount: number
  onOpenCatalog: () => void
  onOpenOperations: () => void
}

export const AcademyHeader: React.FC<AcademyHeaderProps> = ({ conflictCount, onOpenCatalog, onOpenOperations }) => (
  <header className="academy-header">
    <div className="academy-title-block">
      <span className="academy-title-icon" aria-hidden="true"><BookOpen size={28} /></span>
      <div>
        <h1>Academy</h1>
        <p>Gerencie, desenvolva e distribua Skills para o ecossistema Code Awareness.</p>
      </div>
    </div>
    <div className="academy-header-controls">
      <button className="academy-mobile-control academy-secondary-button" onClick={onOpenCatalog}>Skills</button>
      <button className="academy-mobile-control academy-icon-button" aria-label="Abrir operações" onClick={onOpenOperations}>
        <PanelRightOpen size={18} />
        {conflictCount > 0 && <span className="academy-notification-dot" />}
      </button>
    </div>
  </header>
)

interface SkillCatalogProps {
  query: string
  status: 'ALL' | 'ACTIVE' | 'DISABLED'
  onQueryChange: (value: string) => void
  onStatusChange: (value: 'ALL' | 'ACTIVE' | 'DISABLED') => void
  onCreate: () => void
  skills: AcademySkillSummary[]
  selectedId: string | null
  open: boolean
  onClose: () => void
  onSelect: (id: string) => void
}

export const SkillCatalog: React.FC<SkillCatalogProps> = ({ query, status, onQueryChange, onStatusChange, onCreate, skills, selectedId, open, onClose, onSelect }) => (
  <aside className={`academy-catalog ${open ? 'is-open' : ''}`} aria-label="Catálogo de Skills">
    <div className="academy-pane-header">
      <div><h2>Skills</h2><span className="academy-count" aria-label={`${skills.length} Skills`}>{skills.length}</span></div>
      <button className="academy-primary-button" onClick={onCreate}><Plus size={17} />Nova Skill</button>
      <button className="academy-mobile-control academy-icon-button" aria-label="Fechar catálogo" onClick={onClose}><X size={18} /></button>
    </div>
    <div className="academy-catalog-search">
      <label className="academy-search"><Search size={17} aria-hidden="true" /><input aria-label="Buscar Skills" placeholder="Buscar skills..." value={query} onChange={event => onQueryChange(event.target.value)} /></label>
      <select aria-label="Filtrar por status" value={status} onChange={event => onStatusChange(event.target.value as SkillCatalogProps['status'])}><option value="ALL">Todas</option><option value="ACTIVE">Ativas</option><option value="DISABLED">Desativadas</option></select>
    </div>
    <ul className="academy-skill-list">
      {skills.map((skill) => (
        <li key={skill.id} className="academy-skill-row">
          <button className={`academy-skill-item ${selectedId === skill.id ? 'selected' : ''}`} aria-current={selectedId === skill.id ? 'true' : undefined} onClick={() => onSelect(skill.id)}>
            <span className="academy-skill-file" aria-hidden="true"><FileCode2 size={20} /></span>
            <span className="academy-skill-copy">
              <span className="academy-skill-name-row">
                <strong title={skill.name}>{skill.name}</strong>
                <span className={`academy-catalog-state ${skill.status === 'ACTIVE' ? '' : 'is-disabled'}`} title={skill.status === 'ACTIVE' ? 'Ativa' : 'Desativada'}><span aria-hidden="true">●</span><span className="sr-only">{skill.status === 'ACTIVE' ? 'Ativa' : 'Desativada'}</span></span>
              </span>
              <small>{skill.description}</small>
            </span>
          </button>
        </li>
      ))}
    </ul>
    {skills.length === 0 && <div className="academy-empty-compact">Nenhuma Skill corresponde ao filtro.</div>}
  </aside>
)

interface SkillWorkspaceProps {
  artifacts: Record<string, string>
  onOpenArtifact: (path: string) => void
  onAddArtifact: () => void
  dirty: boolean
  saving: boolean
  selected: AcademySkillDetail | null
  isEditing: boolean
  activeTab: AcademyTab
  skillMd: string
  scope: AcademySkillScope
  projectIds: string[]
  destinations: AcademyDestination[]
  history: AcademySkillVersion[]
  distribution: AcademyDistributionState[]
  onTabChange: (tab: AcademyTab) => void
  onSkillMdChange: (value: string) => void
  onScopeChange: (scope: AcademySkillScope) => void
  onProjectIdsChange: (ids: string[]) => void
  onEdit: () => void
  onSave: () => void
  onCancel: () => void
  activationPending: boolean
  onSetEnabled: () => void
  onRemoveFromGit?: () => void
  onApprovePublic?: () => void
}

export const SkillWorkspace: React.FC<SkillWorkspaceProps> = ({ selected, isEditing, activeTab, skillMd, scope, projectIds, destinations, history, distribution, onTabChange, onSkillMdChange, onScopeChange, onProjectIdsChange, onEdit, onSave, onCancel, activationPending, onSetEnabled, onRemoveFromGit, onApprovePublic, artifacts, onOpenArtifact, onAddArtifact, dirty, saving }) => {
  if (!selected && !isEditing) {
    return <main className="academy-skill-workspace academy-workspace-empty">
      <span className="academy-empty-icon"><FileCode2 size={30} /></span>
      <h2>Selecione uma Skill</h2>
      <p>Escolha um item do catálogo ou crie uma nova Skill para começar.</p>
    </main>
  }

  const title = selected?.name ?? 'Nova Skill'
  const description = selected?.description ?? 'Defina o contrato procedural desta nova Skill.'

  return <main className="academy-skill-workspace">
    <header className="academy-skill-header">
      <span className="academy-skill-hero-icon" aria-hidden="true"><FileCode2 size={27} /></span>
      <div className="academy-skill-heading">
        <div className="academy-skill-title-line">
          <h2>{title}</h2>
          <StatusBadge tone={!selected || selected.status === 'DISABLED' ? 'neutral' : 'success'}>{selected ? selected.status === 'ACTIVE' ? 'Ativa' : 'Desativada' : 'Rascunho'}</StatusBadge>
        </div>
        <p>{selected ? `v${selected.currentVersion} · ${scope === 'GLOBAL' ? 'Global' : 'Projetos'}` : 'Nova Skill · ainda não persistida'}</p>
      </div>
      <div className="academy-skill-actions">
        {!isEditing && <button className="academy-secondary-button" onClick={onEdit}><Pencil size={16} />Editar</button>}
      </div>
    </header>

    <nav className="academy-tabs" aria-label="Conteúdo da Skill">
      <button aria-current={activeTab === 'skill' ? 'page' : undefined} className={activeTab === 'skill' ? 'active' : ''} onClick={() => onTabChange('skill')}><FileCode2 size={16} />Definição</button>
      <button aria-current={activeTab === 'files' ? 'page' : undefined} className={activeTab === 'files' ? 'active' : ''} onClick={() => onTabChange('files')}><Code2 size={16} />Arquivos</button>
      <button aria-current={['overview', 'history'].includes(activeTab) ? 'page' : undefined} className={['overview', 'history'].includes(activeTab) ? 'active' : ''} onClick={() => onTabChange('overview')}><ShieldCheck size={16} />Contexto</button>
    </nav>

    <fieldset disabled={saving} className="academy-skill-content">
      {activeTab === 'skill' && <>
      {!isEditing && <div className="academy-definition-summary"><span>Descrição</span><p>{description}</p></div>}
      <section className="academy-code-surface" aria-label="Conteúdo de SKILL.md">
        <header><FileCode2 size={15} /><span>SKILL.md</span>{selected && <small>v{selected.currentVersion}</small>}</header>
        {isEditing
          ? <textarea aria-label="Editar SKILL.md" autoFocus value={skillMd} onChange={(event) => onSkillMdChange(event.target.value)} />
          : <pre tabIndex={0} aria-label="Ler SKILL.md" onDoubleClick={onEdit} onKeyDown={event => { if (event.key === 'Enter') onEdit() }}>{skillMd}</pre>}
        <footer><span>Markdown</span><span>{skillMd.split(/\r?\n/).length} linhas</span></footer>
      </section></>}

      {activeTab === 'files' && <section className="academy-files" aria-label="Arquivos da Skill">
        <div className="academy-section-heading"><h3>Artefatos textuais</h3><button className="academy-secondary-button" onClick={onAddArtifact}><Plus size={16} />Adicionar artefato</button></div>
        <div className="academy-artifact-list"><button onClick={() => onTabChange('skill')}><span><FileCode2 size={17} /><strong>SKILL.md</strong></span><small>Definição</small></button>{Object.keys(artifacts).map(path => <button key={path} onClick={() => onOpenArtifact(path)}><span><Code2 size={17} /><strong title={path}>{path}</strong></span><small>Editar texto</small></button>)}</div>
      </section>}

      {activeTab === 'overview' && <section className="academy-overview" aria-label="Visão geral da Skill">
        <div className="academy-section-heading"><h3>Contexto da Skill</h3><button className="academy-secondary-button" onClick={() => onTabChange('history')}><History size={16} />Histórico</button></div>
        {selected && <button className="academy-secondary-button" role="switch" aria-label="Ativação da Skill selecionada" aria-checked={selected.status === 'ACTIVE'} disabled={activationPending || isEditing} onClick={onSetEnabled}>{activationPending ? 'Salvando…' : selected.status === 'ACTIVE' ? 'Desativar Skill' : 'Ativar Skill'}</button>}
        {selected?.publicationEligibility && <p>Publicação: {selected.publicationEligibility === 'PRIVATE' ? 'Privada — requer aprovação explícita para Git e plugin.' : 'Elegível para Git e plugin; sincronização e upload são independentes.'}</p>}
        {selected?.publicationEligibility === 'PRIVATE' && !isEditing && <button className="academy-secondary-button" onClick={onApprovePublic}>Aprovar publicação pública</button>}
        {selected?.current.contentState === 'DELETED' && <p>Skill excluída. Identidade e histórico preservados; a ativação não restaura o conteúdo.</p>}
        {selected?.source && <p>Fonte: {selected.source.state} · {selected.source.sourceCommitSha?.slice(0, 8) ?? 'legado privado'}</p>}
        {selected && (selected.catalogRevision !== undefined || selected.source?.state === 'CONFIRMED') && !isEditing && selected.current.contentState !== 'DELETED' && <button className="academy-danger-button" onClick={onRemoveFromGit}>{selected.catalogRevision !== undefined ? 'Excluir Skill' : 'Preparar remoção do Git'}</button>}
        <div className="academy-metadata-grid">
          <div><span>Versão</span><strong>{selected ? `v${selected.currentVersion}` : 'Novo draft'}</strong></div>
          <div><span>Status</span><strong>{selected?.status ?? 'Não persistida'}</strong></div>
          <div><span>Origem</span><strong>{selected?.current.origin ?? 'UI'}</strong></div>
          <div><span>Criada em</span><strong>{selected ? formatDate(selected.createdAt) : 'Ao salvar'}</strong></div>
          <div><span>Atualizada em</span><strong>{selected ? formatDate(selected.updatedAt) : 'Ao salvar'}</strong></div>
          <div><span>Distribuição</span><strong>{distribution.length > 0 ? `${distribution.filter((item) => item.status === 'CURRENT').length}/${distribution.length} current` : 'Sem destino aplicável'}</strong></div>
        </div>
        <div className="academy-scope-panel">
          <div><h3>Escopo</h3><p>Controle onde esta Skill fica disponível.</p></div>
          {isEditing ? <select aria-label="Escopo" value={scope} onChange={(event) => onScopeChange(event.target.value as AcademySkillScope)}><option value="GLOBAL">Global</option><option value="PROJECT">Projetos</option></select> : <StatusBadge tone="info">{scope}</StatusBadge>}
        </div>
        {scope === 'PROJECT' && <fieldset className="academy-project-scope" disabled={!isEditing}>
          <legend>Projetos associados</legend>
          {destinations.map((destination) => <label key={destination.id}><input type="checkbox" checked={projectIds.includes(destination.id)} onChange={(event) => onProjectIdsChange(event.target.checked ? [...projectIds, destination.id] : projectIds.filter((id) => id !== destination.id))} />{destination.name}</label>)}
        </fieldset>}
        {selected && distribution.length > 0 && <div className="academy-distribution-list">
          {distribution.map((state) => <div key={`${state.destinationId}:${state.target}`}><span><strong>{state.destinationName}</strong><small>{state.target}</small></span><StatusBadge tone={state.status === 'CURRENT' ? 'success' : state.status === 'ERROR' ? 'danger' : 'warning'}>{state.status}</StatusBadge></div>)}
        </div>}
      </section>}

      {activeTab === 'history' && <section className="academy-history" aria-label="Histórico imutável">
        <button className="academy-secondary-button" onClick={() => onTabChange('overview')}>Voltar ao contexto</button>
        <h3>Histórico imutável</h3>
        {history.length === 0 ? <p>Nenhuma versão persistida.</p> : <ol>{history.map((item) => <li key={item.version}><span className="academy-version-node">v{item.version}</span><div><strong>{friendlyState(item.origin)}</strong><small>{formatDate(item.createdAt)}</small></div></li>)}</ol>}
      </section>}
    </fieldset>
    {isEditing && <footer className="academy-edit-footer"><span role="status">{saving ? 'Salvando…' : dirty ? 'Alterações não salvas' : 'Sem alterações'}</span><button className="academy-secondary-button" disabled={saving} onClick={onCancel}>Cancelar</button><button className="academy-primary-button" disabled={saving || !dirty} onClick={onSave}><Check size={16} />Salvar</button></footer>}
  </main>
}

interface OperationsRailProps {
  hydration?: 'LOADING' | 'READY' | 'ERROR'
  knownPublication?: import('../../../../shared/types/academy-bootstrap-types').AcademyPersistedPublication | null
  open: boolean
  destinations: AcademyDestination[]
  conflicts: AcademyConflictSummary[]
  distribution: AcademyDistributionHealth
  packageDistribution: AcademyPackageDistributionState | null
  openAiPublication: AcademyOpenAiPublicationState | null
  gitStatus: AcademyGitStatusProjection | null
  eligibleRepos: RepositoryRecord[]
  selectedRepoId: string
  onSelectedRepoChange: (id: string) => void
  onClose: () => void
  onOpenDestinations: () => void
  onReconcile: () => void
  onPrepareRelease: () => void
  packagePending?: boolean
  onRevalidateRelease?: () => void
  onRebuildRelease?: () => void
  onPrepareManifestVersion?: () => void
  onBootstrapPlugin: () => void
  onRevealRelease: () => void
  onConfirmUpload: () => void
  onBindRepository: () => void
  onSyncGit: () => void
  onPublishCandidate?: () => void
  onLocalCutover?: () => void
  onGitAutomation?: (autoPublish: boolean, autoUpdate: boolean) => void
  onResolveGitConflict: () => void
  onOpenGit: () => void
  onReviewConflict: (id: string) => void
  onPreviewConflictBatch: () => void
}

export const OperationsRail: React.FC<OperationsRailProps> = ({ hydration = 'READY', knownPublication, open, destinations, conflicts, distribution, packageDistribution, openAiPublication, gitStatus, eligibleRepos, selectedRepoId, onSelectedRepoChange, onClose, onOpenDestinations, onReconcile, onPrepareRelease, packagePending, onRevalidateRelease, onRebuildRelease, onPrepareManifestVersion, onBootstrapPlugin, onRevealRelease, onConfirmUpload, onBindRepository, onSyncGit, onPublishCandidate, onGitAutomation, onResolveGitConflict, onOpenGit, onReviewConflict, onPreviewConflictBatch, onLocalCutover }) => {
  const release = openAiPublication?.selectedRelease
  const loading = hydration !== 'READY'
  const configured = Boolean(gitStatus?.profile || gitStatus?.repository)
  const check = gitStatus?.remoteCheck
  const gitName = gitStatus?.repository?.fullName ?? gitStatus?.lastKnown?.repositoryId ?? (loading ? 'Carregando configuração…' : 'Não configurado')
  const git = gitPresentation(gitStatus, hydration)
  const plugin = releasePresentation(release ?? knownPublication?.release, openAiPublication?.drifted ?? false)
  const gitLabel = git.label
  return <aside className={`academy-operations ${open ? 'is-open' : ''}`} aria-label="Operações da Academy">
    <div className="academy-operations-mobile-header"><strong>Operações</strong><button className="academy-icon-button" aria-label="Fechar operações" onClick={onClose}><X size={18} /></button></div>
    <section className="academy-health" aria-label="Estado operacional da Academy">
      <div><Pencil size={17} /><span>Edição local</span><StatusBadge tone={gitStatus?.convergence?.cutover === 'LOCAL' ? 'success' : 'neutral'}>{loading ? 'Carregando…' : gitStatus?.convergence?.cutover === 'LOCAL' ? 'Ativa' : gitStatus?.convergence?.cutover === 'PENDING' ? 'Migração pendente' : configured ? 'Git-first · legado' : 'Não configurada'}</StatusBadge></div>
      <div><GitBranch size={17} /><span>Git</span><StatusBadge tone={git.tone}>{git.label}</StatusBadge></div>
      <div><Package size={17} /><span>Release do plugin</span><StatusBadge tone={plugin.tone}>{plugin.label}</StatusBadge></div>
      <div><ShieldCheck size={17} /><span>Conflitos</span><StatusBadge tone={loading ? 'neutral' : conflicts.length || gitStatus?.syncState === 'CONFLICT' ? 'danger' : 'neutral'}>{loading ? 'Carregando…' : conflicts.length ? conflicts.length + ' na distribuição' : gitStatus?.syncState === 'CONFLICT' ? 'Revisão Git necessária' : 'Nenhum registrado localmente'}</StatusBadge></div>
    </section>
    <section className="academy-exceptions" aria-label="Ações necessárias">
      {gitStatus?.convergence?.cutover === 'PENDING' && <button className="academy-secondary-button" onClick={onLocalCutover}>Migrar para edição local</button>}
      {gitStatus?.syncState === 'CONFLICT' && <button className="academy-danger-button" data-academy-action="resolve-git" onClick={onResolveGitConflict}>Resolver conflito Git</button>}
      {gitStatus?.syncState === 'PR_PENDING' && <p>Branch candidata aguardando revisão de PR. Abertura e merge são ações separadas.</p>}
      {gitStatus?.lastError && <p className="academy-inline-error">{gitStatus.lastError}</p>}
      {check?.state === 'FAILED' && <p className="academy-inline-error">Falha ao verificar GitHub. {check.error}</p>}
      {(check?.state === 'FAILED' || ['OFFLINE', 'ERROR', 'REMOTE_CHANGES', 'REMOTE_DIVERGED'].includes(gitStatus?.syncState ?? '')) && <button className="academy-secondary-button" onClick={onSyncGit}>Verificar Git novamente</button>}
      {openAiPublication?.versionPreflight && <p className="academy-release-preflight">{openAiPublication.versionPreflight.message}{openAiPublication.versionPreflight.suggestedVersion && <button className="academy-secondary-button" onClick={onPrepareManifestVersion}>Preparar nova versão do manifesto</button>}</p>}
      {openAiPublication?.sourceError && <p className="academy-inline-error">{openAiPublication.sourceError}</p>}
      {openAiPublication?.operation?.phase === 'ERROR' && <p className="academy-inline-error">{openAiPublication.operation.error}</p>}
      {packagePending && <p role="status">Preparando e verificando pacote…</p>}
      {release?.status === 'READY_TO_UPLOAD' && <div className="academy-upload-ready"><p>ZIP preparado · v{release.pluginVersion}. Entrega manual pendente.</p><div className="academy-inline-actions"><button disabled={!release.artifactPath} onClick={onRevealRelease}>Revelar pacote</button><button onClick={onConfirmUpload}>Confirmar upload manual</button></div></div>}
      {packageDistribution?.hosted.status === 'HOSTED_UPDATE_AVAILABLE' && <p>Hosted fallback: atualização disponível. Preparação e upload em Avançado.</p>}
    </section>
    {conflicts.length > 0 && <RailCard icon={<CircleAlert size={18} />} title="Conflitos" count={`${conflicts.length}`} className="academy-conflict-card">
      <AcademyConflicts conflicts={conflicts} destinations={destinations} onReview={onReviewConflict} onPreviewBatch={onPreviewConflictBatch} />
    </RailCard>}

    <RailCard icon={<Package size={18} />} title="Distribuição global">
      <div className="academy-distribution-summary">
        <div><span className="academy-summary-icon"><Box size={17} /></span><span><strong>Academy Skills</strong><small>{packageDistribution?.packageRevision ? `v${packageDistribution.packageRevision.version} · ${packageDistribution.skillCount} Skills` : 'Pacote não disponível'}</small></span><StatusBadge tone="neutral">{packageDistribution?.packageRevision ? 'Local' : 'Não disponível'}</StatusBadge></div>
        {distribution.targets.map((target) => <div key={target.target}><span className="academy-summary-icon"><Cloud size={17} /></span><span><strong>{friendlyState(target.target)}</strong><small>{target.current} current · {target.error} error</small></span><StatusBadge tone={target.current + target.pending + target.drifted + target.missing + target.error === 0 ? 'neutral' : target.error ? 'danger' : target.convergence === 'CONVERGED' ? 'success' : 'warning'}>{target.current + target.pending + target.drifted + target.missing + target.error === 0 ? 'Sem destinos aplicáveis' : target.convergence}</StatusBadge></div>)}
        <div><span className="academy-summary-icon"><Package size={17} /></span><span><strong>Marketplace</strong><small>{packageDistribution?.marketplace.mode === 'GIT_MANAGED' ? 'Git Managed' : packageDistribution?.marketplace.mode === 'SOURCE_AVAILABLE' ? 'Source Available' : 'Pending Evidence'}</small></span><StatusBadge tone={packageDistribution?.marketplace.mode === 'GIT_MANAGED' ? 'info' : 'neutral'}>{packageDistribution?.marketplace.mode ?? 'Não verificado'}</StatusBadge></div>
      </div>
    </RailCard>

    {gitStatus?.profile && gitStatus.publication && <RailCard icon={<RefreshCw size={18} />} title="Automação">        <label className="academy-git-option"><input type="checkbox" checked={gitStatus.publication?.autoPublish ?? false} onChange={event => onGitAutomation?.(event.target.checked, gitStatus.publication?.autoUpdate ?? false)} />Publicação automática de edições locais</label>
        <label className="academy-git-option"><input type="checkbox" checked={gitStatus.publication?.autoUpdate ?? false} onChange={event => onGitAutomation?.(gitStatus.publication?.autoPublish ?? false, event.target.checked)} />Atualização automática do remoto</label>
</RailCard>}
    <details className="academy-advanced"><summary><Settings2 size={17} />Avançado</summary><div className="academy-advanced-content">    <RailCard icon={<FolderGit2 size={18} />} title="Destinos de Distribuição" count={`${destinations.length}`} action={<button className="academy-card-action" onClick={onOpenDestinations}><Settings2 size={15} />Gerenciar</button>}>
      <div className="academy-compact-list">
        {destinations.slice(0, 4).map((destination) => <div key={destination.id}><span><FolderGit2 size={15} />{destination.name}</span><StatusBadge tone={destination.reconciliationStatus === 'SYNCED' ? 'success' : destination.reconciliationStatus === 'ERROR' ? 'danger' : 'warning'}>{destination.reconciliationStatus}</StatusBadge></div>)}
      </div>
      {destinations.length > 4 && <button className="academy-text-action" onClick={onOpenDestinations}>Ver todos os destinos <ChevronRight size={14} /></button>}
    </RailCard>


    <RailCard icon={<GitBranch size={18} />} title="GitHub Sync">
      <button className="academy-secondary-button" aria-label="Reconciliar distribuição" onClick={onReconcile}>Reconciliar distribuição</button>
      {gitStatus?.convergence && <p className="academy-muted">Revisão local {gitStatus.convergence.localRevision} · convergida {gitStatus.convergence.lastConvergedRevision ?? 'ainda não confirmada'} · {gitStatus.convergence.freshness}</p>}

      <div className="academy-git-summary"><div><strong>{gitName}</strong><small>{configured ? `${gitStatus?.profile?.branch ?? gitStatus?.repository?.branch} · ${gitStatus?.lastCommitSha?.slice(0, 8) ?? 'sem commit confirmado'}` : loading ? 'Lendo o estado persistido' : 'Vincule um repository elegível'}</small></div><StatusBadge tone={git.tone}>{gitLabel}</StatusBadge></div>
      {!configured && !loading && eligibleRepos.length > 0 && <div className="academy-git-bind"><select aria-label="Repository da Academy" value={selectedRepoId} onChange={(event) => onSelectedRepoChange(event.target.value)}>{eligibleRepos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select><button onClick={onBindRepository}>Vincular</button></div>}
      {gitStatus?.repository && <>
        <small className="academy-muted">Última confirmação remota: {formatDate(gitStatus.lastSyncAt)} · {gitStatus.publication?.remoteHead?.slice(0, 8) ?? 'sem observação'}</small>
        {gitStatus.publication?.pendingCommit && <small className="academy-muted">Commit local pendente: {gitStatus.publication.pendingCommit.slice(0, 8)}</small>}
        {Boolean(gitStatus.publication?.conflictPaths.length) && <small>Revisão necessária: {gitStatus.publication?.conflictPaths.join(', ')}</small>}
        <div className="academy-inline-actions">
          {gitStatus.syncState === 'CONFLICT' ? <button data-academy-action="resolve-git" onClick={onResolveGitConflict}>Resolver</button>
            : gitStatus.syncState === 'PR_PENDING' ? <span>Aguardando revisão de PR</span>
            : <button data-academy-action="sync-git" onClick={onSyncGit}>{gitStatus.syncState === 'LOCAL_CHANGES' ? 'Publicar' : 'Atualizar'}</button>}
          <button onClick={onOpenGit}>Abrir workspace</button>
          {['LOCAL_CHANGES', 'PR_PENDING'].includes(gitStatus.syncState) && !gitStatus.publication?.candidateBranch && <button onClick={onPublishCandidate}>Publicar branch para revisão</button>}
        </div>
        {gitStatus.publication?.candidateBranch && <p>Branch publicada: {gitStatus.publication.candidateBranch}. Abertura e merge de PR são ações separadas.</p>}
      </>}
    </RailCard>

    <RailCard icon={<Cloud size={18} />} title="Hosted ZIP fallback" className="academy-fallback-card">
      <div className="academy-hosted-summary"><span><strong>Hosted Personal</strong><small>Hospedagem manual de fallback</small></span><StatusBadge tone={packageDistribution?.hosted.status === 'CURRENT' ? 'success' : 'warning'}>{packageDistribution?.hosted.status === 'HOSTED_UPDATE_AVAILABLE' ? 'UPDATE' : packageDistribution?.hosted.status ?? knownPublication?.release?.status ?? (loading ? 'Carregando…' : knownPublication?.publishedVersion ? 'Registrado' : 'UNCONFIGURED')}</StatusBadge></div>
      <div className="academy-hosted-versions"><span>Hosted <strong>{packageDistribution?.hosted.version || knownPublication?.publishedVersion ? `v${packageDistribution?.hosted.version ?? knownPublication?.publishedVersion}` : '—'}</strong></span><span>Package <strong>{packageDistribution?.packageRevision ? `v${packageDistribution.packageRevision.version}` : knownPublication?.release ? `v${knownPublication.release.version}` : '—'}</strong></span></div>
      {!openAiPublication && knownPublication?.release && <p className="academy-muted">Release registrada: v{knownPublication.release.version} · {knownPublication.release.status} · {knownPublication.release.sourceCommitSha?.slice(0, 12) ?? 'Legado sem SHA Git'}. Detalhes do pacote em carregamento.</p>}
      {packagePending && <p role="status">{openAiPublication?.operation?.phase === 'PREPARING_PACKAGE' ? 'Preparando e verificando o ZIP…' : 'Verificando a fonte e a versão…'}</p>}
      {!packagePending && openAiPublication?.operation?.phase === 'READY' && <p role="status">Pacote pronto.</p>}
      {release && <p className="academy-muted">v{release.pluginVersion} · {release.status}{release.source ? ` · ${release.source.branch}@${release.source.sourceCommitSha.slice(0, 12)}` : ' · Legado sem SHA Git'}</p>}
      {release?.source && <p className="academy-muted">{release.source.remoteConfirmation === 'CACHED' ? 'Rebuild em cache; atualidade remota não verificada' : 'Fonte observada no remoto'} · {formatDate(release.source.confirmedAt)} · {Math.max(0, Math.floor((Date.now() - Date.parse(release.source.confirmedAt)) / 1000))} s atrás nesta leitura{gitStatus?.syncState === 'OFFLINE' || gitStatus?.syncState === 'UNKNOWN' ? ' · Remoto não revalidado' : ''}</p>}
      <div className="academy-inline-actions">
        {openAiPublication?.profile ? <button disabled={packagePending} onClick={onPrepareRelease}>Prepare ZIP fallback</button> : <button disabled={loading || Boolean(knownPublication?.publishedVersion)} onClick={onBootstrapPlugin}>{loading || knownPublication?.publishedVersion ? 'Carregando detalhes do plugin…' : 'Registrar plugin existente'}</button>}
        {gitStatus?.repository && <button disabled={packagePending} onClick={onRevalidateRelease}>Revalidar fonte e preparar ZIP</button>}
        {release?.source && <button disabled={packagePending} onClick={onRebuildRelease}>Rebuild do commit em cache</button>}
        <button disabled={!release?.artifactPath} onClick={onRevealRelease}>Reveal Package</button>
        <button disabled={release?.status !== 'READY_TO_UPLOAD'} onClick={onConfirmUpload}>Confirm Upload</button>
      </div>
      {release && <details className="academy-technical-details"><summary>Detalhes técnicos</summary><dl><dt>Status</dt><dd>{release.status}</dd><dt>ZIP SHA-256</dt><dd>{release.artifactHash ?? 'não produzido'}</dd>{release.source && <><dt>Commit de origem</dt><dd>{release.source.sourceCommitSha}</dd><dt>Repository / branch</dt><dd>{release.source.sourceRepositoryId} / {release.source.branch}</dd></>}<dt>Path</dt><dd>{release.artifactPath ?? '—'}</dd></dl></details>}
    </RailCard>
    </div></details>
  </aside>
}

interface ArtifactEditorProps {
  mode: 'create' | 'edit'
  path: string
  content: string
  onPathChange: (value: string) => void
  onContentChange: (value: string) => void
  onSave: () => void
  onRequestRemove: () => void
  onClose: () => void
}

export const ArtifactEditor: React.FC<ArtifactEditorProps> = ({ mode, path, content, onPathChange, onContentChange, onSave, onRequestRemove, onClose }) => (
  <div className="academy-overlay" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
    <section className="academy-drawer" role="dialog" aria-modal="true" aria-labelledby="academy-artifact-title">
      <header><div><span>Artefato textual</span><h2 id="academy-artifact-title">{mode === 'create' ? 'Novo artefato' : path}</h2></div><button className="academy-icon-button" aria-label="Fechar editor de artefato" onClick={onClose}><X size={18} /></button></header>
      <label>Caminho relativo<input aria-label="Caminho do artefato" disabled={mode === 'edit'} placeholder="references/guide.md" value={path} onChange={(event) => onPathChange(event.target.value)} /></label>
      <label className="academy-artifact-content">Conteúdo<textarea aria-label="Conteúdo do artefato" value={content} onChange={(event) => onContentChange(event.target.value)} /></label>
      <footer>{mode === 'edit' && <button className="academy-danger-button" onClick={onRequestRemove}><Trash2 size={16} />Remover</button>}<span /><button className="academy-secondary-button" onClick={onClose}>Cancelar</button><button className="academy-primary-button" disabled={!path.trim()} onClick={onSave}>Salvar no draft</button></footer>
    </section>
  </div>
)

interface DestinationManagerProps {
  destinations: AcademyDestination[]
  onToggle: (id: string, enabled: boolean) => void
  onImport: (id: string) => void
  onClose: () => void
}

export const DestinationManager: React.FC<DestinationManagerProps> = ({ destinations, onToggle, onImport, onClose }) => (
  <div className="academy-overlay" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
    <section className="academy-drawer academy-destination-drawer" role="dialog" aria-modal="true" aria-labelledby="academy-destinations-title">
      <header><div><span>Academy</span><h2 id="academy-destinations-title">Destinos de Distribuição</h2></div><button className="academy-icon-button" aria-label="Fechar destinos" onClick={onClose}><X size={18} /></button></header>
      <div className="academy-destination-manager">{destinations.map((destination) => <article key={destination.id}>
        <label><input type="checkbox" checked={destination.enabled} onChange={(event) => onToggle(destination.id, event.target.checked)} /><span><strong>{destination.name}</strong><small>{destination.path}</small></span></label>
        <StatusBadge tone={destination.reconciliationStatus === 'SYNCED' ? 'success' : destination.reconciliationStatus === 'ERROR' ? 'danger' : 'warning'}>{destination.reconciliationStatus}</StatusBadge>
        <button onClick={() => onImport(destination.id)}>Importar .skills</button>
        {destination.lastError && <p>{destination.lastError}</p>}
      </article>)}</div>
    </section>
  </div>
)

interface ConfirmationDialogProps {
  title: string
  description: string
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export const ConfirmationDialog: React.FC<ConfirmationDialogProps> = ({ title, description, confirmLabel, destructive, onConfirm, onCancel }) => (
  <div className="academy-overlay academy-confirm-overlay" role="presentation">
    <section className="academy-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="academy-confirm-title" aria-describedby="academy-confirm-description">
      <span className={`academy-confirm-icon ${destructive ? 'danger' : ''}`}>{destructive ? <Trash2 size={22} /> : <Check size={22} />}</span>
      <h2 id="academy-confirm-title">{title}</h2>
      <p id="academy-confirm-description">{description}</p>
      <div><button className="academy-secondary-button" onClick={onCancel}>Cancelar</button><button className={destructive ? 'academy-danger-button' : 'academy-primary-button'} onClick={onConfirm}>{confirmLabel}</button></div>
    </section>
  </div>
)
