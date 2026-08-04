/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar o card de um arquivo alterado com badge de tipo, nome, caminho e toggle de seleção.
2. Aplicar cor de destaque ao badge conforme o tipo de mudança (added, modified, deleted).
3. Exibir o caminho truncado embaixo do nome.

Mapa de Relacionamentos do Script

1. ChangesSection.tsx
   - Tipo: Dependência Inversa
   - Relação: Instancia DrawerFileCard para cada arquivo dos subgrupos Criados/Modificados/Removidos.
   - Criticidade: Alta

2. ToggleSwitch.tsx
   - Tipo: Dependência Direta
   - Relação: Reutiliza o toggle de seleção existente no canto direito do card.
   - Criticidade: Alta

3. DrawerFileCard.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos definidos neste arquivo.
   - Criticidade: Alta

Invariantes do Script

1. Componente puramente apresentacional — sem estado, sem IPC, sem lógica de negócio.
2. O toggle não gerencia seu próprio estado — o pai controla checked e onToggle.
3. O badge de tipo nunca fica vazio — M, A ou D sempre é renderizado.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import { ToggleSwitch } from '../ToggleSwitch/ToggleSwitch'
import './DrawerFileCard.css'

const CHANGE_TYPE_LABEL: Record<'modified' | 'added' | 'deleted', string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D'
}

interface DrawerFileCardProps {
  name: string
  path: string
  changeType: 'modified' | 'added' | 'deleted'
  checked: boolean
  onToggle: () => void
}

/**
 * Card de arquivo com badge colorido, nome, caminho e toggle de seleção.
 * Separado por vão (gap) no container, não por divisória — produz o respiro da referência.
 */
export const DrawerFileCard: React.FC<DrawerFileCardProps> = ({
  name,
  path,
  changeType,
  checked,
  onToggle
}) => {
  return (
    <div className="dfc-card">
      <div className="dfc-top-row">
        <span className={`dfc-badge dfc-badge--${changeType}`}>
          {CHANGE_TYPE_LABEL[changeType]}
        </span>
        <span className="dfc-name" title={name}>{name}</span>
        <div className="dfc-toggle">
          <ToggleSwitch checked={checked} onChange={onToggle} />
        </div>
      </div>
      <div className="dfc-path" title={path}>{path}</div>
    </div>
  )
}

DrawerFileCard.displayName = 'DrawerFileCard'
