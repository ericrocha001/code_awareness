/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar um dropdown interativo e elegante para a troca de projetos ativos na aplicação.
2. Buscar a lista de projetos disponíveis chamando a API do backend ao inicializar o componente.
3. Propagar a seleção do novo projeto ativo para o componente pai.
4. Fechar o menu suspenso de projetos automaticamente quando o usuário clicar fora do componente.

Mapa de Relacionamentos do Script

1. CodeSourceView.tsx
   - Tipo: Dependência Inversa
   - Relação: Renderiza este componente como parte do cabeçalho da visualização de arquivos.
   - Criticidade: Alta

2. ProjectSwitcher.css
   - Tipo: Relação de UI
   - Relação: Define os estilos visuais, animações, transições e comportamento visual do dropdown.
   - Criticidade: Alta

Invariantes do Script

1. O menu do dropdown deve fechar se houver um clique fora do componente.
2. O botão principal deve sempre refletir o nome do projeto ativo atual.
3. A lista suspensa deve exibir apenas os outros projetos disponíveis, ocultando o projeto atualmente ativo para evitar redundância.
4. Deve remover todos os event listeners de clique global no desmonte para evitar memory leaks.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useEffect, useState, useRef } from 'react'
import { ProjectInfo } from '../../../../shared/types'
import './ProjectSwitcher.css'

interface ProjectSwitcherProps {
  activeProject: { path: string; name: string } | null
  onSelectProject: (project: { path: string; name: string } | null) => void
}

export const ProjectSwitcher: React.FC<ProjectSwitcherProps> = ({
  activeProject,
  onSelectProject
}) => {
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [isOpen, setIsOpen] = useState<boolean>(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Carrega a lista de projetos disponíveis no backend
  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const list = await window.codeAwareness.getProjectsList()
        setProjects(list)
      } catch (err) {
        console.error('Erro ao carregar lista de projetos no switcher:', err)
      }
    }
    fetchProjects()
  }, [])

  // Controla o fechamento do dropdown ao clicar fora do componente
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  // Filtra o projeto atualmente ativo para exibir apenas os demais na lista
  const otherProjects = projects.filter(
    (project) => !activeProject || project.path !== activeProject.path
  )

  const handleSelect = (project: ProjectInfo) => {
    onSelectProject({ path: project.path, name: project.name })
    setIsOpen(false)
  }

  return (
    <div className="project-switcher-container" ref={containerRef}>
      <button
        className={`project-switcher-btn ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <div className="project-switcher-info">
          <span className="project-switcher-label">Projeto Ativo</span>
          <span className="project-switcher-name">
            {activeProject ? activeProject.name : 'Nenhum projeto selecionado'}
          </span>
        </div>
        <svg
          className="project-switcher-arrow"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {isOpen && (
        <div className="project-switcher-dropdown" role="listbox">
          {otherProjects.length === 0 ? (
            <div className="project-switcher-no-options">
              Nenhum outro projeto disponível
            </div>
          ) : (
            <ul className="project-switcher-list">
              {otherProjects.map((project) => (
                <li
                  key={project.path}
                  className="project-switcher-item"
                  role="option"
                  onClick={() => handleSelect(project)}
                >
                  <span className="project-switcher-item-icon">📁</span>
                  <div className="project-switcher-item-details">
                    <span className="project-switcher-item-name">{project.name}</span>
                    <span className="project-switcher-item-path" title={project.path}>
                      {project.path}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
