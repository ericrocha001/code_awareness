/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar a seção de auditoria com volume de tokens e menus ActionMenu de Copiar e Exportar.
2. Delegar abertura/fechamento e ESC ao ActionMenu (autocontido).

Mapa de Relacionamentos do Script

1. CheckpointDrawer.tsx
   - Tipo: Dependência Inversa
   - Relação: Instancia AuditSection no miolo rolável do modo detalhes.
   - Criticidade: Alta

2. ActionMenu.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza os menus Copiar e Exportar com balão via Popover (portal).
   - Criticidade: Alta

3. ActionMenuItem.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza as faixas de formato dentro dos menus.
   - Criticidade: Alta

4. auditFormatIcons.tsx
   - Tipo: Dependência Direta
   - Relação: Importa FORMAT_ICONS para os ícones dos formatos.
   - Criticidade: Alta

5. restoreUtils.ts
   - Tipo: Dependência Direta
   - Relação: Importa COPY_LEVELS para os rótulos dos formatos de cópia e exportação.
   - Criticidade: Alta

6. checkpointUtils.ts
   - Tipo: Dependência Direta
   - Relação: Consome formatTokens para formatar o volume de tokens.
   - Criticidade: Alta

7. AuditSection.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos definidos neste arquivo.
   - Criticidade: Alta

Invariantes do Script

1. Componente puramente apresentacional — sem IPC, sem lógica de negócio.
2. ESC dos menus nunca fecha o drawer — o ActionMenu registra listener na fase de captura.
3. Se hasContent === false, os botões ficam desabilitados.
4. Os dois menus são independentes — abrir um fecha o outro (clique-fora do Popover).
5. As props (diffTokenCount, isExporting, isCopied, onCopyLevel, onExportLevel, hasContent) não mudam — o orquestrador não é tocado.
6. O tipo do nível de cópia/exportação é AuditCopyLevel (1 a 4), importado de restoreUtils.

--- FIM ARQUITETURA DO SCRIPT ---
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