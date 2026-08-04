/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar um dropdown para seleção de projetos a partir da lista do backend.
2. Exibir o projeto ativo e permitir alternar para outro projeto disponível.
3. Fechar automaticamente ao clicar fora do componente ou ao selecionar uma opção.

Mapa de Relacionamentos do Script

1. App.tsx
   - Tipo: Dependência Inversa
   - Relação: Recebe o projeto ativo e o callback `onSelectProject`.
   - Criticidade: Alta

2. window.codeAwareness.getProjectsList()
   - Tipo: Fluxo de Dados
   - Relação: Fornece a lista de projetos disponíveis no backend.
   - Criticidade: Alta

3. ProjectDropdown.css
   - Tipo: Relação de UI
   - Relação: Aparência e comportamento visual do dropdown.
   - Criticidade: Alta

Invariantes do Script

1. O dropdown deve sempre fechar ao clicar fora do componente.
2. O projeto atualmente selecionado não deve aparecer duplicado na lista.
3. Se `getProjectsList` falhar, o componente não deve crashar a aplicação.
4. Ao selecionar um projeto, o callback do componente pai deve ser chamado exatamente uma vez.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useEffect, useState, useRef } from 'react'
import { FolderGit2 } from 'lucide-react'
import DOMPurify from 'dompurify'
import { ProjectInfo } from '../../../../shared/types'
import './ProjectDropdown.css'

interface ProjectDropdownProps {
  activeProject: { path: string; name: string } | null
  onSelectProject: (project: { path: string; name: string } | null) => void
}

export const ProjectDropdown: React.FC<ProjectDropdownProps> = ({
  activeProject,
  onSelectProject
}) => {
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [isOpen, setIsOpen] = useState<boolean>(false)
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const list = await window.codeAwareness.getProjectsList()
        setProjects(list)
        setStatus('success')
      } catch (err) {
        console.error('Erro ao carregar lista de projetos:', err)
        setStatus('error')
      }
    }
    fetchProjects()
  }, [])

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

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false)
    }

    if (isOpen) {
      document.addEventListener('keydown', handleEscape)
    }

    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen])

  const otherProjects = projects.filter(
    (project) => !activeProject || project.path !== activeProject.path
  )

  const handleSelect = (project: ProjectInfo) => {
    onSelectProject({ path: project.path, name: project.name })
    setIsOpen(false)
  }

  return (
    <div className="project-dropdown-container" ref={containerRef}>
      <button
        className={`project-dropdown-btn ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="project-dropdown-current-name">
          {activeProject ? activeProject.name : 'Selecione um projeto'}
        </span>
        <svg
          className="project-dropdown-arrow"
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
        <div className="project-dropdown-menu" role="listbox">
          {status === 'error' && (
            <div className="project-dropdown-empty">Erro ao carregar projetos</div>
          )}
          {status === 'success' && otherProjects.length === 0 && (
            <div className="project-dropdown-empty">Nenhum projeto disponível</div>
          )}
          {status === 'success' && otherProjects.length > 0 && (
            <ul className="project-dropdown-list">
              {otherProjects.map((project) => (
                <li
                  key={project.path}
                  className="project-dropdown-item"
                  role="option"
                  onClick={() => handleSelect(project)}
                >
                  <span className="project-dropdown-item-icon">
                    <FolderGit2 size={16} strokeWidth={2} />
                  </span>
                  <div className="project-dropdown-item-info">
                    <span
                      className="project-dropdown-item-name"
                      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(project.name) }}
                    />
                    <span
                      className="project-dropdown-item-path"
                      title={DOMPurify.sanitize(project.path)}
                      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(project.path) }}
                    />
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