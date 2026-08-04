/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Centralizar o mapa nível → ícone dos formatos de auditoria (Code, Sparkles, FileText, Package).
2. Ser a fonte única de verdade para os ícones dos quatro níveis de cópia/exportação.

Mapa de Relacionamentos do Script

1. AuditSection.tsx
   - Tipo: Dependência Direta
   - Relação: Importa FORMAT_ICONS para renderizar os menus Copiar e Exportar.
   - Criticidade: Alta

2. CheckpointPreview.tsx
   - Tipo: Dependência Direta
   - Relação: Importa FORMAT_ICONS para renderizar os menus Copiar e Exportar.
   - Criticidade: Alta

Invariantes do Script

1. Módulo folha de UI — sem lógica de negócio, sem IPC, sem estado.
2. O mapa é imutável (const) — nunca deve ser modificado em runtime.
3. Os ícones usam size={17} strokeWidth={2} para consistência visual.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import { Code, Sparkles, FileText, Package } from 'lucide-react'

export const FORMAT_ICONS: Record<1 | 2 | 3 | 4, React.ReactNode> = {
  1: <Code size={17} strokeWidth={2} />,
  2: <Sparkles size={17} strokeWidth={2} />,
  3: <FileText size={17} strokeWidth={2} />,
  4: <Package size={17} strokeWidth={2} />
}