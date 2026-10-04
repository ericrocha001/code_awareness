// Responsabilidades do Script
//
// 1. Apresentar o painel inicial da aplicação (Home).
// 2. Controlar o menu flutuante de adição de projetos e pastas mães.
// 3. Renderizar a grade de projetos retornados do backend e permitir a seleção do projeto ativo.

import React, { useState, useEffect, useMemo, useRef } from 'react'
import { Upload, FolderOpen, Package, Folder, X, Check, Plus, GitBranch, Copy, RefreshCw, Download, CloudUpload, Database, Search } from 'lucide-react'
import type { GitHubStatusProjection, ProjectInfo, RepositoryRecord } from '../../../../shared/types'
import { DocumentPropagator } from '../DocumentPropagator/DocumentPropagator'
import './HomeView.css'

const sameLocalPath = (left: string, right: string) =>
  left.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase() === right.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase()

interface HomeViewProps {
  activeProject: { path: string; name: string } | null
  onSelectRepository: (repositoryId: string) => void
  onStatusMessage: (message: string, isError?: boolean) => void
}

export const HomeView: React.FC<HomeViewProps> = ({ activeProject, onSelectRepository, onStatusMessage }) => {
  const [repositories, setRepositories] = useState<RepositoryRecord[]>([])
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [repositoryToHide, setRepositoryToHide] = useState<RepositoryRecord | null>(null)
  const [isPropagatorOpen, setIsPropagatorOpen] = useState(false)
  const [githubStatus, setGitHubStatus] = useState<GitHubStatusProjection | null>(null)
  const [githubBusy, setGitHubBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [publishTarget, setPublishTarget] = useState<RepositoryRecord | null>(null)
  const [repositoryName, setRepositoryName] = useState('')
  const [visibility, setVisibility] = useState<'PUBLIC' | 'PRIVATE'>('PRIVATE')
  const [searchQuery, setSearchQuery] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  const loadRepositories = async () => {
    try {
      setRepositories(await window.codeAwareness.refreshRepositories())
    } catch (err) {
      console.error('Erro ao carregar repositórios:', err)
      onStatusMessage('Falha ao atualizar o catálogo de repositórios', true)
    }
  }

  // Effect de carregamento inicial
  useEffect(() => {
    void loadRepositories()
    void loadGitHubStatus()
  }, [])

  useEffect(() => {
    if (githubStatus?.state !== 'AUTHORIZING') return
    const timer = window.setInterval(() => void loadGitHubStatus(true), 1000)
    return () => window.clearInterval(timer)
  }, [githubStatus?.state])

  const loadGitHubStatus = async (reloadOnConnection = false) => {
    try {
      const previous = githubStatus?.state
      const status = await window.codeAwareness.getGitHubStatus()
      setGitHubStatus(status)
      if (reloadOnConnection && previous === 'AUTHORIZING' && (status.state === 'CONNECTED' || status.state === 'INSTALLATION_REQUIRED')) {
        setRepositories(await window.codeAwareness.listRepositories())
      }
    } catch { setGitHubStatus(null) }
  }

  const runGitHubOperation = async (operation: () => Promise<{ success: boolean; repositories?: RepositoryRecord[]; error?: { message: string }; warning?: string }>) => {
    setGitHubBusy(true)
    try {
      const result = await operation()
      if (result.repositories) setRepositories(result.repositories)
      if (!result.success) onStatusMessage(result.error?.message ?? 'GitHub operation failed', true)
      else onStatusMessage(result.warning ?? 'GitHub operation completed')
      await loadGitHubStatus()
      return result.success
    } finally { setGitHubBusy(false) }
  }

  const connectGitHub = async () => {
    try { setGitHubStatus(await window.codeAwareness.connectGitHub()) }
    catch (error) { onStatusMessage(error instanceof Error ? error.message : 'GitHub connection failed', true) }
  }

  // Listener para fechar o menu ao clicar fora
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false)
      }
    }
    if (isMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isMenuOpen])

  // Handlers de Importação
  const handleAddRootFolder = async () => {
    setIsMenuOpen(false)
    const list = await window.codeAwareness.importRepositoryRoot()
    if (list) setRepositories(list)
    if (list) onStatusMessage('Pasta raiz importada com sucesso!')
  }

  const handleAddIndividualProject = async () => {
    setIsMenuOpen(false)
    const list = await window.codeAwareness.importLocalRepository()
    if (list) setRepositories(list)
    if (list) onStatusMessage('Repositório adicionado com sucesso!')
  }

  const availableProjects: ProjectInfo[] = repositories
    .filter((repository) => repository.localCheckout?.availability === 'AVAILABLE')
    .map((repository) => ({
      path: repository.localCheckout!.path,
      name: repository.name,
      isGit: repository.localCheckout!.gitState === 'GIT'
    }))

  const visibleRepositories = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase()
    if (!query) return repositories
    return repositories.filter((repository) =>
      repository.name.toLocaleLowerCase().includes(query)
      || repository.github?.fullName.toLocaleLowerCase().includes(query)
    )
  }, [repositories, searchQuery])

  return (
    <div className="home-container">
      {githubStatus && (
        <section className="github-connection" aria-label="GitHub connection">
          <div className="github-connection-identity">
            <div className="github-connection-avatar">
              <GitHubMark />
            </div>
            <div className="github-connection-copy">
              <strong>GitHub{githubStatus.user ? ` · ${githubStatus.user.login}` : ''}</strong>
              <span className={`github-connection-status github-connection-status-${githubStatus.state.toLocaleLowerCase()}`}>
                <i aria-hidden="true" /> {githubStateLabel(githubStatus.state)}
              </span>
            </div>
          </div>
          <div className="github-connection-actions">
            {githubStatus.state === 'DISCONNECTED' && <button className="app-pill-btn" onClick={() => void connectGitHub()}>Connect GitHub</button>}
            {githubStatus.state === 'AUTHORIZING' && <>
              <code>{githubStatus.userCode}</code>
              <button onClick={() => void navigator.clipboard?.writeText(githubStatus.userCode ?? '')} title="Copy code"><Copy size={14} /></button>
              <button className="app-pill-btn" onClick={() => void window.codeAwareness.openGitHubAuthorization()}>Open GitHub</button>
              <button onClick={async () => setGitHubStatus(await window.codeAwareness.cancelGitHubConnect())}>Cancel</button>
            </>}
            {githubStatus.state === 'INSTALLATION_REQUIRED' && <>
              <button className="app-pill-btn" onClick={() => void window.codeAwareness.openGitHubInstallation()}>Install Code Awareness GitHub App</button>
              <button onClick={() => void runGitHubOperation(() => window.codeAwareness.refreshGitHub())}>Continue</button>
            </>}
            {(githubStatus.state === 'CONNECTED' || githubStatus.state === 'REAUTH_REQUIRED') && <>
              <button onClick={() => void runGitHubOperation(() => window.codeAwareness.refreshGitHub())} disabled={githubBusy}><RefreshCw size={14} /> Refresh</button>
              <button onClick={() => void window.codeAwareness.openGitHubManageAccess()}>Manage Access</button>
              {githubStatus.state === 'REAUTH_REQUIRED'
                ? <button className="app-pill-btn" onClick={() => void connectGitHub()}>Reconnect</button>
                : <button onClick={async () => setGitHubStatus(await window.codeAwareness.disconnectGitHub())}>Disconnect</button>}
            </>}
          </div>
        </section>
      )}
      <div className="home-header">
        <div className="home-title-area">
          <div className="home-title-heading">
            <Database size={25} aria-hidden="true" />
            <h2>Repositórios</h2>
          </div>
          <p>Repositórios conhecidos pelo Code Awareness e seus checkouts locais.</p>
        </div>

        <div className="home-tools">
          <label className="home-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label="Buscar repositórios"
              placeholder="Buscar repositórios..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </label>
          <div className="home-actions" ref={menuRef}>
            <button
            className="app-pill-btn home-add-button"
            onClick={() => setIsMenuOpen(!isMenuOpen)}
          >
            <Plus size={16} strokeWidth={2} /> Adicionar
          </button>
          
          {isMenuOpen && (
            <div className="home-dropdown-menu">
              <button onClick={() => { setIsMenuOpen(false); setIsPropagatorOpen(true) }}>
                <Upload size={14} strokeWidth={2} /> Propagar Documento
              </button>
              <button onClick={handleAddRootFolder}>
                <FolderOpen size={14} strokeWidth={2} /> Importar Pasta Raiz (Múltiplos)
              </button>
              <button onClick={handleAddIndividualProject}>
                <Package size={14} strokeWidth={2} /> Importar Repositório Local
              </button>
              {githubStatus?.state === 'CONNECTED' && <button onClick={() => { setIsMenuOpen(false); setRepositoryName(''); setCreateOpen(true) }}>
                <GitBranch size={14} strokeWidth={2} /> New Repository
              </button>}
            </div>
          )}
          </div>
        </div>
      </div>

      {repositories.length === 0 ? (
        <div className="home-empty-state">
          <div className="home-empty-icon"><Folder size={48} strokeWidth={1.5} /></div>
          <h3>Nenhum repositório cadastrado ainda</h3>
          <p>Clique no botão <strong>+ Adicionar</strong> acima para carregar seus diretórios e começar.</p>
        </div>
      ) : visibleRepositories.length === 0 ? (
        <div className="home-empty-state home-search-empty">
          <div className="home-empty-icon"><Search size={42} strokeWidth={1.5} /></div>
          <h3>Nenhum repositório encontrado</h3>
          <p>Tente buscar por outro nome ou pelo identificador completo do GitHub.</p>
        </div>
      ) : (
        <div className="home-projects-grid">
          {visibleRepositories.map((repository) => {
            const checkout = repository.localCheckout
            const isRemoteOnly = !checkout && Boolean(repository.github)
            const isMissing = Boolean(checkout && checkout.availability === 'MISSING')
            const isUnavailable = !checkout || isMissing
            const isActive = Boolean(checkout && activeProject && sameLocalPath(activeProject.path, checkout.path))
            return (
              <div 
                key={repository.id}
                className={`project-card ${isActive ? 'project-card-active' : ''} ${isMissing ? 'project-card-missing' : ''} ${isRemoteOnly ? 'project-card-remote' : ''}`}
                onClick={() => { if (!isUnavailable) onSelectRepository(repository.id) }}
                aria-disabled={isUnavailable}
              >
                <button
                  className="project-card-delete-btn"
                  title="Ocultar repositório"
                  aria-label={`Ocultar ${repository.name}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    setRepositoryToHide(repository)
                  }}
                >
                  <X size={14} strokeWidth={2} />
                </button>
                <div className="project-card-badges">
                  {checkout && <span className={`project-card-badge ${isMissing ? 'missing' : 'local'}`}><Folder size={11} />{isMissing ? 'Missing' : 'Local'}</span>}
                  {checkout && <span className={`project-card-badge ${checkout.gitState === 'GIT' ? 'git' : 'non-git'}`}><GitBranch size={11} />{checkout.gitState === 'GIT' ? 'Git' : 'Non-Git'}</span>}
                  {repository.github && <span className="project-card-badge github"><GitBranch size={11} />GitHub</span>}
                  {repository.github && <span className="project-card-badge visibility">{repository.github.visibility}</span>}
                </div>
                <div className="project-card-identity">
                  <div className="project-card-title-row">
                    <h4 className="project-card-title" title={repository.name}>{repository.name}</h4>
                    {isActive && <span className="project-card-selected"><Check size={12} strokeWidth={3} /> Selecionado</span>}
                  </div>
                </div>
                <div className={`project-card-location ${isRemoteOnly ? 'project-card-location-remote' : ''}`} title={checkout?.path ?? repository.github?.fullName}>
                  {checkout ? <Folder size={16} aria-hidden="true" /> : <GitBranch size={16} aria-hidden="true" />}
                  <span>{checkout?.path ?? repository.github?.fullName ?? 'Sem checkout local'}</span>
                </div>
                <div className="project-card-footer">
                  {isMissing && <div className="project-card-unavailable">Checkout local indisponível</div>}
                  {isRemoteOnly && <button className="project-card-action" onClick={(event) => {
                    event.stopPropagation()
                    void runGitHubOperation(() => window.codeAwareness.cloneGitHubRepository(repository.id))
                  }} disabled={githubStatus?.state !== 'CONNECTED' || repository.github?.accessState !== 'AVAILABLE' || githubBusy}><Download size={14} /> Clone</button>}
                  {checkout?.availability === 'AVAILABLE' && checkout.gitState === 'GIT' && !repository.github && <button className="project-card-action" onClick={(event) => {
                    event.stopPropagation(); setPublishTarget(repository); setRepositoryName(repository.name); setVisibility('PRIVATE')
                  }} disabled={githubStatus?.state !== 'CONNECTED'}><CloudUpload size={14} /> Publish to GitHub</button>}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {isPropagatorOpen && (
        <DocumentPropagator
          projects={availableProjects}
          onClose={() => setIsPropagatorOpen(false)}
          onStatusMessage={onStatusMessage}
        />
      )}

      {repositoryToHide && (
        <div className="home-modal-overlay">
          <div className="home-modal-content">
            <h3>Ocultar {repositoryToHide.name}?</h3>
            <p>O repositório continuará preservado no catálogo e os arquivos locais não serão alterados.</p>
            <div className="home-modal-actions">
              <button 
                className="home-modal-cancel" 
                onClick={() => setRepositoryToHide(null)}
              >
                Cancelar
              </button>
              <button 
                className="home-modal-confirm" 
                onClick={async () => {
                  const hiddenName = repositoryToHide.name
                  const list = await window.codeAwareness.hideRepository(repositoryToHide.id)
                  setRepositories(list)
                  setRepositoryToHide(null)
                  if (list) onStatusMessage(`Repositório ${hiddenName} ocultado com sucesso!`)
                }}
              >
                Confirmar e Remover
              </button>
            </div>
          </div>
        </div>
      )}

      {(createOpen || publishTarget) && (
        <div className="home-modal-overlay">
          <form className="home-modal-content" onSubmit={async (event) => {
            event.preventDefault()
            const success = publishTarget
              ? await runGitHubOperation(() => window.codeAwareness.publishGitHubRepository({ repositoryId: publishTarget.id, name: repositoryName, visibility }))
              : await runGitHubOperation(() => window.codeAwareness.createGitHubRepository({ name: repositoryName, visibility }))
            if (success) { setCreateOpen(false); setPublishTarget(null) }
          }}>
            <h3>{publishTarget ? 'Publish to GitHub' : 'New Repository'}</h3>
            <label className="home-form-field">Name<input value={repositoryName} onChange={(event) => setRepositoryName(event.target.value)} required /></label>
            <label className="home-form-field">Visibility<select value={visibility} onChange={(event) => setVisibility(event.target.value as 'PUBLIC' | 'PRIVATE')}><option value="PRIVATE">Private</option><option value="PUBLIC">Public</option></select></label>
            <div className="home-modal-actions">
              <button type="button" className="home-modal-cancel" onClick={() => { setCreateOpen(false); setPublishTarget(null) }}>Cancel</button>
              <button type="submit" className="app-pill-btn" disabled={githubBusy}>{publishTarget ? 'Publish' : 'Create and Clone'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

function githubStateLabel(state: GitHubStatusProjection['state']): string {
  return ({
    CONFIGURATION_REQUIRED: 'Configuração do aplicativo necessária', DISCONNECTED: 'Desconectado', AUTHORIZING: 'Aguardando autorização',
    INSTALLATION_REQUIRED: 'Conectado · instalação necessária', CONNECTED: 'Conectado', REAUTH_REQUIRED: 'Reconexão necessária'
  })[state]
}

function GitHubMark() {
  return (
    <svg data-testid="github-mark" viewBox="0 0 24 24" role="img" aria-label="GitHub">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.084-.729.084-.729 1.205.084 1.84 1.237 1.84 1.237 1.07 1.835 2.809 1.305 3.495.998.108-.776.418-1.305.762-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.467-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.435.375.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}
