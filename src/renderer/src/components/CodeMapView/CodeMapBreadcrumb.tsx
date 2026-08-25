/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar breadcrumb do arquivo selecionado (caminho hierárquico separado por ›).
2. Adicionar " › nome do elemento" quando há elemento focado.

Mapa de Relacionamentos do Script

1. CodeMapView.tsx
   - Tipo: Dependência Inversa
   - Relação: É instanciado pelo orquestrador dentro do painel de leitura.
   - Criticidade: Alta

2. CodeMapBreadcrumb.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos do breadcrumb (prefixo cmb-).
   - Criticidade: Alta

Invariantes do Script

1. O breadcrumb é puramente apresentacional — sem estado, sem IPC.
2. Se file é null, renderiza null (o breadcrumb só existe quando o painel existe).
3. O caminho é derivado do relativePath; partes separadas por ›.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import type { CodeMapElement, CodeMapFile } from '../../../../shared/types'
import './CodeMapBreadcrumb.css'

interface CodeMapBreadcrumbProps {
  file: CodeMapFile | null
  focusedElement: CodeMapElement | null
}

export const CodeMapBreadcrumb: React.FC<CodeMapBreadcrumbProps> = ({ file, focusedElement }) => {
  if (!file) return null

  const parts = file.relativePath.split('/')
  if (focusedElement) {
    parts.push(focusedElement.name)
  }

  return (
    <div className="cmb-breadcrumb">
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="cmb-separator">›</span>}
          <span className="cmb-part">{part}</span>
        </React.Fragment>
      ))}
    </div>
  )
}