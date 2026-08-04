/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar a seção de documentação com os campos amplos Instrução e Resultado.
2. Exibir o selo de status do autosave (Salvando…, Salvo ✓, Tentar de novo) ao lado do título.

Mapa de Relacionamentos do Script

1. CheckpointDrawer.tsx
   - Tipo: Dependência Inversa
   - Relação: Instancia DocumentationSection no miolo rolável do modo detalhes.
   - Criticidade: Alta

2. DocumentationSection.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos definidos neste arquivo.
   - Criticidade: Alta

3. types.ts
   - Tipo: Contrato / Interface
   - Relação: Importa SaveStatus para tipar a prop saveStatus.
   - Criticidade: Alta

4. Button (shared)
   - Tipo: Dependência Direta
   - Relação: Usa Button variant="ghost" para o botão de retry.
   - Criticidade: Média

Invariantes do Script

1. Componente puramente apresentacional — sem estado, sem IPC, sem lógica de negócio.
2. A prop agentSummary não é renomeada — só o rótulo visível muda para "Resultado".
3. Os campos ficam sempre abertos — sem acordeão, sem colapso.
4. O selo de status só renderiza algo quando saveStatus não é 'idle'.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '../shared/Button/Button'
import { SaveStatus } from './types'
import './DocumentationSection.css'

interface DocumentationSectionProps {
  instructions: string
  agentSummary: string
  onInstructionsChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onAgentSummaryChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  saveStatus: SaveStatus
  onRetrySave: () => void
}

/**
 * Seção protagonista do drawer: campos amplos Instrução e Resultado, sempre abertos.
 * É o único conteúdo produzido à mão — por isso ocupa o topo do miolo.
 * Exibe um selo de status do autosave ao lado do título.
 */
export const DocumentationSection: React.FC<DocumentationSectionProps> = ({
  instructions,
  agentSummary,
  onInstructionsChange,
  onAgentSummaryChange,
  saveStatus,
  onRetrySave
}) => {
  return (
    <div className="ds-section">
      <div className="ds-header" aria-live="polite" role="status">
        <h3 className="ds-title">Documentação</h3>
        {saveStatus === 'saving' && (
          <span className="ds-status ds-status--saving">Salvando…</span>
        )}
        {saveStatus === 'saved' && (
          <span className="ds-status ds-status--saved">Salvo ✓</span>
        )}
        {saveStatus === 'error' && (
          <Button
            variant="ghost"
            icon={<RefreshCw size={13} strokeWidth={2} />}
            onClick={onRetrySave}
            className="ds-retry-btn sm"
          >
            Tentar de novo
          </Button>
        )}
      </div>

      <div className="ds-field">
        <label className="ds-label">Instrução</label>
        <textarea
          className="ds-textarea"
          value={instructions}
          onChange={onInstructionsChange}
          placeholder="Descreva as instruções desta implementação..."
          rows={5}
        />
      </div>

      {/* Rótulo visível "Resultado" — a prop interna permanece agentSummary */}
      <div className="ds-field">
        <label className="ds-label">Resultado</label>
        <textarea
          className="ds-textarea"
          value={agentSummary}
          onChange={onAgentSummaryChange}
          placeholder="Cole o resultado gerado pelo agente..."
          rows={5}
        />
      </div>
    </div>
  )
}

DocumentationSection.displayName = 'DocumentationSection'