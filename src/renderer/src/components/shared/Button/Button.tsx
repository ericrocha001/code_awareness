/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar a peça atômica de botão com duas variantes (pill, ghost) e suporte a ícone e seta.
2. Repassar a referência ao elemento <button> raiz via forwardRef — essencial para que o Popover do ActionMenu possa ancorar o balão.
3. Definir type="button" como default para evitar submit acidental em formulários.

Mapa de Relacionamentos do Script

1. Button.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos dos elementos internos (btn-icon, btn-chevron).
   - Criticidade: Alta

2. ChevronDown (lucide-react)
   - Tipo: Dependência Direta
   - Relação: Ícone de seta que gira 180° quando open é true.
   - Criticidade: Baixa

3. ActionMenu.tsx
   - Tipo: Dependência Inversa
   - Relação: Usa Button como gatilho, passando ref para ancorar o Popover.
   - Criticidade: Alta

4. ChangesSection.tsx
   - Tipo: Dependência Inversa
   - Relação: Usa Button variant="ghost" para o "Visualizar diff".
   - Criticidade: Média

Invariantes do Script

1. forwardRef é obrigatório — sem ele a referência não atravessa e o balão do ActionMenu perde a âncora.
2. type default é 'button' — evita submit acidental se o Button morar dentro de um formulário.
3. O type não vaza duas vezes para o DOM (desestruturado com default, não espalhado de novo).
4. A seta (chevron) é interna ao Button — o consumidor não renderiza ChevronDown nem cuida da rotação.
5. O ícone é opcional — se não fornecido, o span btn-icon não é renderizado.
6. A classe raiz é a composição app-${variant}-btn + className extra.
7. Prefixo btn- nos elementos internos.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { forwardRef } from 'react'
import { ChevronDown } from 'lucide-react'
import './Button.css'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'pill' | 'ghost'
  icon?: React.ReactNode
  chevron?: boolean
  open?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'pill',
      icon,
      chevron = false,
      open = false,
      children,
      type = 'button',
      className = '',
      ...rest
    },
    ref
  ) => {
    const baseClass = `app-${variant}-btn`
    const combinedClass = `${baseClass}${className ? ` ${className}` : ''}`

    return (
      <button
        ref={ref}
        type={type}
        className={combinedClass}
        {...rest}
      >
        {icon && <span className="btn-icon" aria-hidden="true">{icon}</span>}
        {children}
        {chevron && (
          <ChevronDown
            size={14}
            strokeWidth={2}
            className={`btn-chevron${open ? ' btn-chevron--open' : ''}`}
            aria-hidden="true"
          />
        )}
      </button>
    )
  }
)

Button.displayName = 'Button'