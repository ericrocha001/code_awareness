import React from 'react'
import {
  Archive,
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
  MoreHorizontal,
  Package,
  PanelRightOpen,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
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

export type AcademyTab = 'skill' | 'overview' | 'history'

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
  query: string
  status: 'ALL' | 'ACTIVE' | 'ARCHIVED'
  conflictCount: number
  onQueryChange: (value: string) => void
  onStatusChange: (value: 'ALL' | 'ACTIVE' | 'ARCHIVED') => void
  onCreate: () => void
  onOpenCatalog: () => void
  onOpenOperations: () => void
}

export const AcademyHeader: React.FC<AcademyHeaderProps> = ({ query, status, conflictCount, onQueryChange, onStatusChange, onCreate, onOpenCatalog, onOpenOperations }) => (
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
      <label className="academy-search">
        <Search size={17} aria-hidden="true" />
        <span className="sr-only">Buscar Skills</span>
        <input aria-label="Buscar Skills" placeholder="Buscar skills..." value={query} onChange={(event) => onQueryChange(event.target.value)} />
      </label>
      <select aria-label="Filtrar por status" value={status} onChange={(event) => onStatusChange(event.target.value as AcademyHeaderProps['status'])}>
        <option value="ALL">Todos os status</option>
        <option value="ACTIVE">Ativas</option>
        <option value="ARCHIVED">Arquivadas</option>
      </select>
      <button className="academy-primary-button" onClick={onCreate}><Plus size={17} />Nova Skill</button>
      <button className="academy-mobile-control academy-icon-button" aria-label="Abrir operações" onClick={onOpenOperations}>
        <PanelRightOpen size={18} />
        {conflictCount > 0 && <span className="academy-notification-dot" />}
      </button>
    </div>
  </header>
)

interface SkillCatalogProps {
  skills: AcademySkillSummary[]
  selectedId: string | null
  open: boolean
  onClose: () => void
  onSelect: (id: string) => void
}

export const SkillCatalog: React.FC<SkillCatalogProps> = ({ skills, selectedId, open, onClose, onSelect }) => (
  <aside className={`academy-catalog ${open ? 'is-open' : ''}`} aria-label="Catálogo de Skills">
    <div className="academy-pane-header">
      <div><h2>Skills</h2><span className="academy-count">{skills.length} {skills.length === 1 ? 'skill' : 'skills'}</span></div>
      <button className="academy-mobile-control academy-icon-button" aria-label="Fechar catálogo" onClick={onClose}><X size={18} /></button>
    </div>
    <ul className="academy-skill-list">
      {skills.map((skill) => (
        <li key={skill.id}>
          <button className={`academy-skill-item ${selectedId === skill.id ? 'selected' : ''}`} onClick={() => onSelect(skill.id)}>
            <span className="academy-skill-file" aria-hidden="true"><FileCode2 size={20} /></span>
            <span className="academy-skill-copy">
              <span className="academy-skill-name-row">
                <strong>{skill.name}</strong>
                <StatusBadge tone={skill.status === 'ACTIVE' ? 'success' : 'neutral'}>{skill.status}</StatusBadge>
                <StatusBadge tone="info">{skill.scope}</StatusBadge>
              </span>
              <small>{skill.description}</small>
              <span className="academy-skill-version">v{skill.currentVersion}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
    {skills.length === 0 && <div className="academy-empty-compact">Nenhuma Skill corresponde ao filtro.</div>}
  </aside>
)

interface SkillWorkspaceProps {
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
  onToggleArchive: () => void
}

export const SkillWorkspace: React.FC<SkillWorkspaceProps> = ({ selected, isEditing, activeTab, skillMd, scope, projectIds, destinations, history, distribution, onTabChange, onSkillMdChange, onScopeChange, onProjectIdsChange, onEdit, onSave, onCancel, onToggleArchive }) => {
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
          <StatusBadge tone={selected?.status === 'ARCHIVED' ? 'neutral' : 'success'}>{selected?.status ?? 'DRAFT'}</StatusBadge>
          <StatusBadge tone="info">{scope}</StatusBadge>
        </div>
        <p>{description}</p>
      </div>
      <div className="academy-skill-actions">
        {isEditing ? <>
          <button className="academy-secondary-button" onClick={onCancel}>Cancelar</button>
          <button className="academy-primary-button" onClick={onSave}><Check size={16} />Salvar</button>
        </> : <button className="academy-secondary-button" onClick={onEdit}><Pencil size={16} />Editar</button>}
        {selected && <details className="academy-action-menu">
          <summary aria-label="Mais ações"><MoreHorizontal size={19} /></summary>
          <button onClick={onToggleArchive}>{selected.status === 'ACTIVE' ? <Archive size={15} /> : <RotateCcw size={15} />}{selected.status === 'ACTIVE' ? 'Arquivar' : 'Restaurar'}</button>
        </details>}
      </div>
    </header>

    <nav className="academy-tabs" aria-label="Conteúdo da Skill">
      <button className={activeTab === 'skill' ? 'active' : ''} onClick={() => onTabChange('skill')}><FileCode2 size={16} />SKILL.md</button>
      <button className={activeTab === 'overview' ? 'active' : ''} onClick={() => onTabChange('overview')}><ShieldCheck size={16} />Visão Geral</button>
      <button className={activeTab === 'history' ? 'active' : ''} onClick={() => onTabChange('history')}><History size={16} />Histórico</button>
    </nav>

    <div className="academy-skill-content">
      {activeTab === 'skill' && <section className="academy-code-surface" aria-label="Conteúdo de SKILL.md">
        <header><FileCode2 size={15} /><span>SKILL.md</span>{selected && <small>v{selected.currentVersion}</small>}</header>
        {isEditing
          ? <textarea aria-label="Editar SKILL.md" autoFocus value={skillMd} onChange={(event) => onSkillMdChange(event.target.value)} />
          : <pre>{skillMd}</pre>}
        <footer><span>Markdown</span><span>{skillMd.split(/\r?\n/).length} linhas</span></footer>
      </section>}

      {activeTab === 'overview' && <section className="academy-overview" aria-label="Visão geral da Skill">
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
        <h3>Histórico imutável</h3>
        {history.length === 0 ? <p>Nenhuma versão persistida.</p> : <ol>{history.map((item) => <li key={item.version}><span className="academy-version-node">v{item.version}</span><div><strong>{friendlyState(item.origin)}</strong><small>{formatDate(item.createdAt)}</small></div></li>)}</ol>}
      </section>}
    </div>
  </main>
}

interface OperationsRailProps {
  open: boolean
  destinations: AcademyDestination[]
  artifacts: Record<string, string>
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
  onOpenArtifact: (path: string) => void
  onAddArtifact: () => void
  onReconcile: () => void
  onPrepareRelease: () => void
  onBootstrapPlugin: () => void
  onRevealRelease: () => void
  onConfirmUpload: () => void
  onBindRepository: () => void
  onSyncGit: () => void
  onOpenGit: () => void
  onReviewConflict: (id: string) => void
  onPreviewConflictBatch: () => void
}

export const OperationsRail: React.FC<OperationsRailProps> = ({ open, destinations, artifacts, conflicts, distribution, packageDistribution, openAiPublication, gitStatus, eligibleRepos, selectedRepoId, onSelectedRepoChange, onClose, onOpenDestinations, onOpenArtifact, onAddArtifact, onReconcile, onPrepareRelease, onBootstrapPlugin, onRevealRelease, onConfirmUpload, onBindRepository, onSyncGit, onOpenGit, onReviewConflict, onPreviewConflictBatch }) => {
  const release = openAiPublication?.selectedRelease
  return <aside className={`academy-operations ${open ? 'is-open' : ''}`} aria-label="Operações da Academy">
    <div className="academy-operations-mobile-header"><strong>Operações</strong><button className="academy-icon-button" aria-label="Fechar operações" onClick={onClose}><X size={18} /></button></div>
    {conflicts.length > 0 && <RailCard icon={<CircleAlert size={18} />} title="Conflitos" count={`${conflicts.length}`} className="academy-conflict-card">
      <AcademyConflicts conflicts={conflicts} destinations={destinations} onReview={onReviewConflict} onPreviewBatch={onPreviewConflictBatch} />
    </RailCard>}

    <RailCard icon={<FolderGit2 size={18} />} title="Destinos de Distribuição" count={`${destinations.length}`} action={<button className="academy-card-action" onClick={onOpenDestinations}><Settings2 size={15} />Gerenciar</button>}>
      <div className="academy-compact-list">
        {destinations.slice(0, 4).map((destination) => <div key={destination.id}><span><FolderGit2 size={15} />{destination.name}</span><StatusBadge tone={destination.reconciliationStatus === 'SYNCED' ? 'success' : destination.reconciliationStatus === 'ERROR' ? 'danger' : 'warning'}>{destination.reconciliationStatus}</StatusBadge></div>)}
      </div>
      {destinations.length > 4 && <button className="academy-text-action" onClick={onOpenDestinations}>Ver todos os destinos <ChevronRight size={14} /></button>}
    </RailCard>

    <RailCard icon={<FileCode2 size={18} />} title="Artefatos textuais" count={`${Object.keys(artifacts).length + 1}`} action={<button className="academy-icon-button" aria-label="Adicionar artefato" onClick={onAddArtifact}><Plus size={16} /></button>}>
      <div className="academy-artifact-list">
        <button onClick={() => onOpenArtifact('SKILL.md')}><span><FileCode2 size={15} /><strong>SKILL.md</strong></span><small>Arquivo principal</small></button>
        {Object.keys(artifacts).map((path) => <button key={path} onClick={() => onOpenArtifact(path)}><span><Code2 size={15} /><strong>{path}</strong></span><small>Texto</small></button>)}
      </div>
    </RailCard>

    <RailCard icon={<Package size={18} />} title="Distribuição" action={<button className="academy-icon-button" aria-label="Reconciliar distribuição" onClick={onReconcile}><RefreshCw size={16} /></button>}>
      <div className="academy-distribution-summary">
        <div><span className="academy-summary-icon"><Box size={17} /></span><span><strong>Academy Skills</strong><small>{packageDistribution?.packageRevision ? `v${packageDistribution.packageRevision.version} · ${packageDistribution.skillCount} Skills` : 'Pacote não disponível'}</small></span><StatusBadge tone="success">PACKAGE</StatusBadge></div>
        {distribution.targets.map((target) => <div key={target.target}><span className="academy-summary-icon"><Cloud size={17} /></span><span><strong>{friendlyState(target.target)}</strong><small>{target.current} current · {target.error} error</small></span><StatusBadge tone={target.convergence === 'CONVERGED' ? 'success' : 'warning'}>{target.convergence}</StatusBadge></div>)}
        <div><span className="academy-summary-icon"><GitBranch size={17} /></span><span><strong>Repositório Git</strong><small>{packageDistribution?.git.repository?.fullName ?? 'Não configurado'}</small></span><StatusBadge tone={packageDistribution?.git.syncState === 'SYNCED' ? 'success' : 'warning'}>{packageDistribution?.git.syncState ?? 'UNCONFIGURED'}</StatusBadge></div>
        <div><span className="academy-summary-icon"><Package size={17} /></span><span><strong>Marketplace</strong><small>{packageDistribution?.marketplace.mode === 'GIT_MANAGED' ? 'Git Managed' : packageDistribution?.marketplace.mode === 'SOURCE_AVAILABLE' ? 'Source Available' : 'Pending Evidence'}</small></span><StatusBadge tone={packageDistribution?.marketplace.mode === 'PENDING_EVIDENCE' ? 'warning' : 'info'}>{packageDistribution?.marketplace.mode === 'PENDING_EVIDENCE' ? 'PENDING' : 'AVAILABLE'}</StatusBadge></div>
      </div>
    </RailCard>

    <RailCard icon={<GitBranch size={18} />} title="GitHub Sync">
      <div className="academy-git-summary"><div><strong>{gitStatus?.repository?.fullName ?? 'Não configurado'}</strong><small>{gitStatus?.repository ? `${gitStatus.repository.branch} · ${gitStatus.lastCommitSha?.slice(0, 8) ?? 'sem commit'}` : 'Vincule um repository elegível'}</small></div><StatusBadge tone={gitStatus?.syncState === 'SYNCED' ? 'success' : gitStatus?.syncState === 'ERROR' ? 'danger' : 'warning'}>{gitStatus?.syncState ?? 'UNCONFIGURED'}</StatusBadge></div>
      {gitStatus?.lastError && <p className="academy-inline-error">{gitStatus.lastError}</p>}
      {!gitStatus?.repository && eligibleRepos.length > 0 && <div className="academy-git-bind"><select aria-label="Repository da Academy" value={selectedRepoId} onChange={(event) => onSelectedRepoChange(event.target.value)}>{eligibleRepos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select><button onClick={onBindRepository}>Vincular</button></div>}
      {gitStatus?.repository && <><small className="academy-muted">Último sync: {formatDate(gitStatus.lastSyncAt)}</small><div className="academy-inline-actions"><button onClick={onSyncGit}>Sync Now</button><button onClick={onOpenGit}>Abrir no Explorer</button></div></>}
    </RailCard>

    <RailCard icon={<Cloud size={18} />} title="Hosted ZIP fallback" className="academy-fallback-card">
      <div className="academy-hosted-summary"><span><strong>Hosted Personal</strong><small>Hospedagem manual de fallback</small></span><StatusBadge tone={packageDistribution?.hosted.status === 'CURRENT' ? 'success' : 'warning'}>{packageDistribution?.hosted.status === 'HOSTED_UPDATE_AVAILABLE' ? 'UPDATE' : packageDistribution?.hosted.status ?? 'UNCONFIGURED'}</StatusBadge></div>
      <div className="academy-hosted-versions"><span>Hosted <strong>{packageDistribution?.hosted.version ? `v${packageDistribution.hosted.version}` : '—'}</strong></span><span>Package <strong>{packageDistribution?.packageRevision ? `v${packageDistribution.packageRevision.version}` : '—'}</strong></span></div>
      <div className="academy-inline-actions">
        {openAiPublication?.profile ? <button onClick={onPrepareRelease}>Prepare ZIP fallback</button> : <button onClick={onBootstrapPlugin}>Registrar plugin existente</button>}
        <button disabled={!release?.artifactPath} onClick={onRevealRelease}>Reveal Package</button>
        <button disabled={release?.status !== 'READY_TO_UPLOAD'} onClick={onConfirmUpload}>Confirm Upload</button>
      </div>
      {release && <details className="academy-technical-details"><summary>Detalhes técnicos</summary><dl><dt>Status</dt><dd>{release.status}</dd><dt>Artifact</dt><dd>{release.artifactHash ?? 'não produzido'}</dd><dt>Path</dt><dd>{release.artifactPath ?? '—'}</dd></dl></details>}
    </RailCard>
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
      <label className="academy-artifact-content">Conteúdo<textarea aria-label="Conteúdo do artefato" autoFocus value={content} onChange={(event) => onContentChange(event.target.value)} /></label>
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
