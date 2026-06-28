// Responsabilidades do Script
//
// 1. Apresentar o painel inicial da aplicação (Home).
// 2. Controlar o menu flutuante de adição de projetos e pastas mães.
// 3. Renderizar a grade de projetos retornados do backend e permitir a seleção do projeto ativo.

import React, { useState, useEffect, useRef } from 'react'
import { ProjectInfo } from '../../../../shared/types'
import { DocumentPropagator } from '../DocumentPropagator/DocumentPropagator'
import './HomeView.css'

interface HomeViewProps {
  activeProject: { path: string; name: string } | null
  onSelectProject: (project: { path: string; name: string }) => void
  onStatusMessage: (message: string, isError?: boolean) => void
}

export const HomeView: React.FC<HomeViewProps> = ({ activeProject, onSelectProject, onStatusMessage }) => {
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [projectToHide, setProjectToHide] = useState<ProjectInfo | null>(null)
  const [isPropagatorOpen, setIsPropagatorOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Carrega a listagem de projetos
  const loadProjects = async () => {
    try {
      const list = await window.codeAwareness.getProjectsList()
      setProjects(list)
    } catch (err) {
      console.error('Erro ao carregar projetos:', err)
    }
  }

  // Effect de carregamento inicial
  useEffect(() => {
    loadProjects()
  }, [])

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
    const list = await window.codeAwareness.addRootFolder()
    if (list) setProjects(list)
    if (list) onStatusMessage('Pasta raiz importada com sucesso!')
  }

  const handleAddIndividualProject = async () => {
    setIsMenuOpen(false)
    const list = await window.codeAwareness.addIndividualProject()
    if (list) setProjects(list)
    if (list) onStatusMessage('Projeto adicionado com sucesso!')
  }

  return (
    <div className="home-container">
      <div className="home-header">
        <div className="home-title-area">
          <h2>Seus Projetos</h2>
          <p>Selecione um projeto para usar nos modos de Análise ou Code Diff.</p>
        </div>

        <div className="home-actions" ref={menuRef}>
          <button 
            className="app-pill-btn" 
            onClick={() => setIsMenuOpen(!isMenuOpen)}
          >
            <span className="home-add-icon">+</span> Adicionar
          </button>
          
          {isMenuOpen && (
            <div className="home-dropdown-menu">
              <button onClick={() => { setIsMenuOpen(false); setIsPropagatorOpen(true) }}>
                <span>📤</span> Propagar Documento
              </button>
              <button onClick={handleAddRootFolder}>
                <span>📁</span> Importar Pasta Raiz (Múltiplos)
              </button>
              <button onClick={handleAddIndividualProject}>
                <span>📦</span> Importar Projeto Avulso
              </button>
            </div>
          )}
        </div>
      </div>

      {projects.length === 0 ? (
        <div className="home-empty-state">
          <div className="home-empty-icon">📂</div>
          <h3>Nenhum projeto cadastrado ainda</h3>
          <p>Clique no botão <strong>+ Adicionar</strong> acima para carregar seus diretórios e começar.</p>
        </div>
      ) : (
        <div className="home-projects-grid">
          {projects.map((proj) => {
            const isActive = activeProject?.path === proj.path
            return (
              <div 
                key={proj.path} 
                className={`project-card ${isActive ? 'project-card-active' : ''}`}
                onClick={() => onSelectProject({ path: proj.path, name: proj.name })}
              >
                <div className="project-card-header">
                  <div className="project-card-title-row">
                    <h4 className="project-card-title">{proj.name}</h4>
                    {isActive && <span className="project-card-selected">✓ Selecionado</span>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {proj.isGit && <span className="project-card-badge git">Git</span>}
                    <button 
                      className="project-card-delete-btn" 
                      title="Ocultar Projeto"
                      onClick={(e) => {
                        e.stopPropagation()
                        setProjectToHide(proj)
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <div className="project-card-path" title={proj.path}>
                  {proj.path}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {isPropagatorOpen && (
        <DocumentPropagator
          projects={projects}
          onClose={() => setIsPropagatorOpen(false)}
          onStatusMessage={onStatusMessage}
        />
      )}

      {projectToHide && (
        <div className="home-modal-overlay">
          <div className="home-modal-content">
            <h3>Remover {projectToHide.name} do aplicativo?</h3>
            <p>Isso apenas ocultará o atalho do seu painel inicial. Todos os arquivos de código no seu computador continuarão 100% seguros, intactos e intocados.</p>
            <div className="home-modal-actions">
              <button 
                className="home-modal-cancel" 
                onClick={() => setProjectToHide(null)}
              >
                Cancelar
              </button>
              <button 
                className="home-modal-confirm" 
                onClick={async () => {
                  const list = await window.codeAwareness.hideProject(projectToHide.path)
                  setProjects(list)
                  setProjectToHide(null)
                  if (list) onStatusMessage(`Projeto ${projectToHide.name} ocultado com sucesso!`)
                }}
              >
                Confirmar e Remover
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
