/*
-T ---
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
