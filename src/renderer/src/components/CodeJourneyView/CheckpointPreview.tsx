/*
-T ---
*/

import React from 'react'
import { Copy, Download, ArrowLeft } from 'lucide-react'
import Markdown from 'markdown-to-jsx'
import { formatTokens } from './checkpointUtils'
import { AuditCopyLevel, COPY_LEVELS } from './restoreUtils'
import { ActionMenu } from '../shared/ActionMenu/ActionMenu'
import { ActionMenuItem } from '../shared/ActionMenu/ActionMenuItem'
import { FORMAT_ICONS } from './auditFormatIcons'
import './CheckpointPreview.css'

interface CheckpointPreviewProps {
  previewMarkdown: string
  diffTokenCount: number
  isCopied: boolean
  isExporting: boolean
  onCopyLevel: (level: AuditCopyLevel) => void
  onExportLevel: (level: AuditCopyLevel) => void
  onBack: () => void
}

/**
 * Renderizador de preview do diff Markdown.
 * Inclui cabeçalho com menus ActionMenu de copiar/exportar em 4 níveis
 * e conteúdo rolável com tipografia harmonizada ao drawer.
 */
export const CheckpointPreview: React.FC<CheckpointPreviewProps> = ({
  previewMarkdown,
  diffTokenCount,
  isCopied,
  isExporting,
  onCopyLevel,
  onExportLevel,
  onBack
}) => {
  return (
    <div className="cp-root">
      <div className="cp-header">
        <button className="cp-back-btn" onClick={onBack} title="Voltar aos detalhes" aria-label="Voltar aos detalhes">
          <ArrowLeft size={16} />
        </button>
        <div className="cp-token-count">
          <span className="cp-token-label">📊 Tokens:</span>
          <span className="cp-token-value">≈ {formatTokens(diffTokenCount)}</span>
        </div>
        <div className="cp-actions">
          {/* Menu Copiar */}
          <ActionMenu
            icon={<Copy size={15} strokeWidth={2} />}
            label={isCopied ? '✓ Copiado!' : 'Copiar'}
            disabled={!previewMarkdown}
          >
            {COPY_LEVELS.map(item => (
              <ActionMenuItem
                key={item.level}
                icon={FORMAT_ICONS[item.level]}
                onClick={() => onCopyLevel(item.level)}
              >
                {item.label}
              </ActionMenuItem>
            ))}
          </ActionMenu>

          {/* Menu Exportar */}
          <ActionMenu
            icon={<Download size={15} strokeWidth={2} />}
            label={isExporting ? 'Exportando...' : 'Exportar'}
            disabled={isExporting || !previewMarkdown}
          >
            {COPY_LEVELS.map(item => (
              <ActionMenuItem
                key={item.level}
                icon={FORMAT_ICONS[item.level]}
                onClick={() => onExportLevel(item.level)}
              >
                {item.label}
              </ActionMenuItem>
            ))}
          </ActionMenu>
        </div>
      </div>

      <div className="cp-content">
        <Markdown>{previewMarkdown}</Markdown>
      </div>
    </div>
  )
}