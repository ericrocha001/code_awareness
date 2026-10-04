/*
-T ---
*/

import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RepositoryRecord } from '../../../../shared/types'
import './ProjectSwitcher.css'

const sameLocalPath = (left: string, right: string) =>
  left.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase() === right.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase()

interface ProjectSwitcherProps {
  activeProject: { path: string; name: string } | null
  onSelectRepository: (repositoryId: string) => void
}

export const ProjectSwitcher: React.FC<ProjectSwitcherProps> = ({
  activeProject,
  onSelectRepository
}) => {
  const [repositories, setRepositories] = useState<RepositoryRecord[]>([])
  const [isOpen, setIsOpen] = useState<boolean>(false)
  const [popoverPosition, setPopoverPosition] = useState({ left: 12, top: 0, width: 320 })
  const popoverId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Carrega a lista de projetos disponíveis no backend
  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const list = await window.codeAwareness.listRepositories()
        setRepositories(list.filter((repository) => repository.localCheckout?.availability === 'AVAILABLE'))
      } catch (err) {
        console.error('Erro ao carregar lista de projetos no switcher:', err)
      }
    }
    fetchProjects()
  }, [])

  // Controla o fechamento do dropdown ao clicar fora do componente
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (!containerRef.current?.contains(target) && !dropdownRef.current?.contains(target)) {
        setIsOpen(false)
      }
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false)
        buttonRef.current?.focus()
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('keydown', handleEscape)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen])

  useLayoutEffect(() => {
    if (!isOpen) return

    const updatePosition = () => {
      const button = buttonRef.current
      if (!button) return
      const bounds = button.getBoundingClientRect()
      const viewportPadding = 12
      const width = Math.min(340, window.innerWidth - viewportPadding * 2)
      const left = Math.min(
        Math.max(viewportPadding, bounds.left),
        Math.max(viewportPadding, window.innerWidth - width - viewportPadding)
      )
      setPopoverPosition({ left, top: bounds.bottom + 6, width })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [isOpen])

  // Filtra o projeto atualmente ativo para exibir apenas os demais na lista
  const otherProjects = repositories.filter(
    (repository) => !activeProject || !repository.localCheckout || !sameLocalPath(repository.localCheckout.path, activeProject.path)
  )

  const handleSelect = (repository: RepositoryRecord) => {
    onSelectRepository(repository.id)
    setIsOpen(false)
  }

  return (
    <div className="project-switcher-container" ref={containerRef}>
      <button
        ref={buttonRef}
        className={`project-switcher-btn ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? popoverId : undefined}
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

      {isOpen && createPortal(
        <div
          ref={dropdownRef}
          id={popoverId}
          className="project-switcher-dropdown"
          role="listbox"
          aria-label="Projetos disponíveis"
          style={{ ...popoverPosition, position: 'fixed', zIndex: 1400 }}
        >
          {otherProjects.length === 0 ? (
            <div className="project-switcher-no-options">
              Nenhum outro projeto disponível
            </div>
          ) : (
            <ul className="project-switcher-list">
              {otherProjects.map((project) => (
                <li
                  key={project.id}
                  className="project-switcher-item"
                  role="option"
                  onClick={() => handleSelect(project)}
                >
                  <span className="project-switcher-item-icon">📁</span>
                  <div className="project-switcher-item-details">
                    <span className="project-switcher-item-name">{project.name}</span>
                    <span className="project-switcher-item-path" title={project.localCheckout!.path}>
                      {project.localCheckout!.path}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
