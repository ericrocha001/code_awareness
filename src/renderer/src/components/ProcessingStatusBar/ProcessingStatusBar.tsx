/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar barra de progresso shimmer decorativa no topo do container pai.
2. Controlar visibilidade exclusivamente via prop booleana `isVisible`.
3. Ser componente puramente visual, sem estado interno, efeitos ou lógica de negócio.

Mapa de Relacionamentos do Script

1. ProcessingStatusBar.css
   - Tipo: Dependência Direta
   - Relação: Consome estilos de posicionamento, gradiente, animação shimmer e transição.
   - Criticidade: Alta

2. CodeCompressionView.tsx (futuro)
   - Tipo: Fluxo de Dados
   - Relação: Consumirá este componente passando prop `isVisible`.
   - Criticidade: Média

3. CodeSourceView.tsx (futuro)
   - Tipo: Fluxo de Dados
   - Relação: Consumirá este componente passando prop `isVisible`.
   - Criticidade: Média

Invariantes do Script

1. Nunca renderizar a barra quando `isVisible` for `false` (retornar `null`).
2. Nunca conter estado interno (useState) ou efeitos (useEffect).
3. Nunca aceitar props além de `isVisible: boolean`.
4. Nunca conter chamadas IPC ou lógica de negócio.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import './ProcessingStatusBar.css'

interface ProcessingStatusBarProps {
  isVisible: boolean
}

export function ProcessingStatusBar({ isVisible }: ProcessingStatusBarProps) {
  if (!isVisible) {
    return null
  }

  return (
    <div className="processing-status-bar processing-status-bar--visible">
      <div className="processing-status-bar-fill" />
    </div>
  )
}