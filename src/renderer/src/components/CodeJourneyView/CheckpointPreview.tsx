/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar a visualização do preview do diff Markdown dentro do drawer.
2. Exibir contagem de tokens e menus ActionMenu de copiar e exportar em quatro níveis.
3. Fornecer botão de retorno aos detalhes do checkpoint.

Mapa de Relacionamentos do Script

1. CheckpointDrawer.tsx
   - Tipo: Dependência Inversa
   - Relação: É instanciado pelo drawer quando previewMarkdown está preenchido.
   - Criticidade: Alta

2. checkpointUtils.ts
   - Tipo: Dependência Direta
   - Relação: Consome formatTokens para exibir a contagem de tokens.
   - Criticidade: Média

3. ActionMenu.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza os menus Copiar e Exportar com balão via Popover (portal).
   - Criticidade: Alta

4. ActionMenuItem.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza as faixas de formato dentro dos menus.
   - Criticidade: Alta

5. auditFormatIcons.tsx
   - Tipo: Dependência Direta
   - Relação: Importa FORMAT_ICONS para os ícones dos formatos.
   - Criticidade: Alta

6. restoreUtils.ts
   - Tipo: Dependência Direta
   - Relação: Importa COPY_LEVELS para os rótulos dos formatos de cópia e exportação.
   - Criticidade: Alta

Invariantes do Script

1. Nunca gerenciar geração do markdown — apenas receber e renderizar.
2. O botão de voltar sempre deve chamar onBack, sem lógica própria.
3. Os menus usam ActionMenu (autocontido) — sem estado externo de abertura.
4. ESC dos menus nunca fecha o drawer — o ActionMenu registra listener na fase de captura.
5. Os dois menus são independentes — abrir um fecha o outro (clique-fora do Popover).

--- FIM ARQUITETURA DO SCRIPT ---
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