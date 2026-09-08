/*
-T ---
*/

import React from 'react'
import { Eye } from 'lucide-react'
import { DrawerFileCard } from './DrawerFileCard'
import { FileListItem } from './types'
import { Button } from '../shared/Button/Button'
import './ChangesSection.css'

interface ChangesSectionProps {
  fileList: FileListItem[]
  selectedFilePaths: Set<string>
  onToggleFile: (path: string) => void
  onPreview: () => void
  isGeneratingPreview: boolean
  previewError: string
  fileCount: number
}

/** Filtra e renderiza um subgrupo de arquivos por tipo. Retorna null se vazio. */
function FileGroup({
  title,
  files,
  selectedFilePaths,
  onToggleFile
}: {
  title: string
  files: FileListItem[]
  selectedFilePaths: Set<string>
  onToggleFile: (path: string) => void
}) {
  if (files.length === 0) return null

  return (
    <div className="cs-group">
      <span className="cs-group-title">
        {title} <span className="cs-group-count">({files.length})</span>
      </span>
      <div className="cs-group-cards">
        {files.map(file => (
          <DrawerFileCard
            key={file.path}
            name={file.name}
            path={file.path}
            changeType={file.changeType}
            checked={selectedFilePaths.has(file.path)}
            onToggle={() => onToggleFile(file.path)}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Seção de mudanças: escopo, botão de diff e arquivos agrupados por tipo.
 * O agrupamento é puramente visual — os dados de fileList não são mutados.
 */
export const ChangesSection: React.FC<ChangesSectionProps> = ({
  fileList,
  selectedFilePaths,
  onToggleFile,
  onPreview,
  isGeneratingPreview,
  previewError,
  fileCount
}) => {
  const previewDisabled = selectedFilePaths.size === 0 || isGeneratingPreview

  const added    = fileList.filter(f => f.changeType === 'added')
  const modified = fileList.filter(f => f.changeType === 'modified')
  const deleted  = fileList.filter(f => f.changeType === 'deleted')

  return (
    <div className="cs-section">
      {/* Cabeçalho com métrica e botão */}
      <div className="cs-header">
        <div className="cs-header-left">
          <h3 className="cs-title">Mudanças</h3>
          <span className="cs-scope">Escopo · {fileCount} arquivo{fileCount !== 1 ? 's' : ''}</span>
        </div>
        <Button
          variant="ghost"
          icon={isGeneratingPreview ? <span>⏳</span> : <Eye size={13} />}
          onClick={onPreview}
          disabled={previewDisabled}
          title={selectedFilePaths.size === 0 ? 'Selecione ao menos um arquivo' : 'Visualizar diff'}
          aria-label="Visualizar diff"
        >
          Visualizar diff
        </Button>
      </div>

      {/* Erro de preview inline */}
      {previewError && (
        <div className="cs-preview-error">
          <span>❌</span>
          <span>{previewError}</span>
        </div>
      )}

      {/* Subgrupos de arquivos */}
      {fileList.length === 0 ? (
        <p className="cs-empty">Nenhuma alteração detectada nesta implementação.</p>
      ) : (
        <div className="cs-groups">
          <FileGroup
            title="Criados"
            files={added}
            selectedFilePaths={selectedFilePaths}
            onToggleFile={onToggleFile}
          />
          <FileGroup
            title="Modificados"
            files={modified}
            selectedFilePaths={selectedFilePaths}
            onToggleFile={onToggleFile}
          />
          <FileGroup
            title="Removidos"
            files={deleted}
            selectedFilePaths={selectedFilePaths}
            onToggleFile={onToggleFile}
          />
        </div>
      )}
    </div>
  )
}

ChangesSection.displayName = 'ChangesSection'
