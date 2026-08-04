/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar o indicador visual de dois segmentos (Blueprint Bar) que reflete o preenchimento de Instrução e Resultado.
2. Exibir um ícone de documento (FileText) como identificador visual de blueprint/documentação.
3. Expor o estado de preenchimento de forma acessível e concentrada no container (aria-label + title descritivos).
4. Otimizar a renderização com React.memo para uso em listas (um por card da timeline).

Mapa de Relacionamentos do Script

1. CheckpointTimeline.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome o BlueprintBar nos cards de implementação, passando instrução e resultado do checkpoint.
   - Criticidade: Alta

2. BlueprintBar.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos com prefixo bpb- definidos no arquivo CSS correspondente.
   - Criticidade: Alta

3. lucide-react (FileText)
   - Tipo: Dependência Direta
   - Relação: Fornece o ícone de documento usado como identificador visual.
   - Criticidade: Baixa

Invariantes do Script

1. O componente é puramente apresentacional — nunca gerencia estado, dados ou IPC.
2. A barra sempre renderiza exatamente dois segmentos: Instrução e Resultado.
3. Um campo só é considerado preenchido quando possui conteúdo além de espaços em branco.
4. O preenchimento nunca depende de hasContent — apenas dos metadados de instrução e resultado.
5. Os segmentos internos são aria-hidden — toda informação acessível está no aria-label e title do container.
6. O ícone é puramente decorativo — nunca é clicável nem captura eventos de interação.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import { FileText } from 'lucide-react'
import './BlueprintBar.css'

interface BlueprintBarProps {
  instructions?: string
  agentSummary?: string
}

/**
 * Indicador de dois segmentos que mostra, de forma imediata, se uma
 * implementação possui Instrução e Resultado preenchidos. Componente puro
 * com React.memo: apenas lê os metadados e renderiza o estado visual.
 */
export const BlueprintBar: React.FC<BlueprintBarProps> = React.memo(({ instructions, agentSummary }) => {
  const hasInstructions = (instructions ?? '').trim().length > 0
  const hasAgentSummary = (agentSummary ?? '').trim().length > 0

  // Rótulo descritivo: comunica claramente o estado de cada campo
  const label = `Blueprint: Instrução ${hasInstructions ? 'preenchida' : 'vazia'}, Resultado ${hasAgentSummary ? 'preenchido' : 'vazio'}`

  return (
    <div
      className="bpb-bar"
      role="img"
      aria-label={label}
      title={label}
    >
      <FileText
        className="bpb-icon"
        size={12}
        aria-hidden="true"
      />
      <span className={`bpb-segment${hasInstructions ? ' filled' : ''}`} aria-hidden="true" />
      <span className={`bpb-segment${hasAgentSummary ? ' filled' : ''}`} aria-hidden="true" />
    </div>
  )
})

BlueprintBar.displayName = 'BlueprintBar'