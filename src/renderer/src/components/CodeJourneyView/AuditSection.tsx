/*
-T ---
*/

import React from 'react'
import { Copy, Download } from 'lucide-react'
import { ActionMenu } from '../shared/ActionMenu/ActionMenu'
import { ActionMenuItem } from '../shared/ActionMenu/ActionMenuItem'
import { AuditCopyLevel, COPY_LEVELS } from './restoreUtils'
import { formatTokens } from './checkpointUtils'
import { FORMAT_ICONS } from './auditFormatIcons'
import './AuditSection.css'

interface AuditSectionProps {
  diffTokenCount: number
  isExporting: boolean
  isCopied: boolean
  onCopyLevel: (level: AuditCopyLevel) => void
  onExportLevel: (level: AuditCopyLevel) => void
  hasContent: boolean
}

/**
 * Seção de auditoria: volume de tokens + menus ActionMenu Copiar e Exportar.
 * Os menus são autocontidos (abertura/fechamento interno, ESC em captura).
 */
export const AuditSection: React.FC<AuditSectionProps> = ({
  diffTokenCount,
  isExporting,
  isCopied,
  onCopyLevel,
  onExportLevel,
  hasContent
}) => {
  return (
    <div className="as-section">
      <div className="as-header">
        <h3 className="as-title">Auditoria</h3>
        <span className="as-volume">Volume · ≈ {formatTokens(diffTokenCount)} tokens</span>
      </div>

      <div className="as-actions">
        {/* Menu Copiar */}
        <ActionMenu
          icon={<Copy size={15} strokeWidth={2} />}
          label={isCopied ? '✓ Copiado!' : 'Copiar'}
          disabled={!hasContent}
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
          label={isExporting ? 'Exportando…' : 'Exportar'}
          disabled={isExporting || !hasContent}
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
  )
}

AuditSection.displayName = 'AuditSection'