/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar o rodapé da GlobalSidebar com ações secundárias.
2. Oferecer acesso rápido ao gerenciamento de tags do projeto ativo.
3. Fornecer botão de toggle para recolher/expandir a sidebar.

Mapa de Relacionamentos do Script

1. GlobalSidebar.tsx
   - Tipo: Dependência Direta
   - Criticidade: Alta

Invariantes do Script

1. Botões do rodapé não devem conflitar visualmente com a navegação principal.
2. Acessibilidade mínima com aria-label nos botões.
3. O toggle deve respeitar o estado atual da sidebar imediatamente.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import { Tag, EyeOff, ChevronsLeft, ChevronsRight, Sun, Moon, Monitor, Wrench } from 'lucide-react'
import { useTheme } from '../../hooks/useTheme'

interface GlobalSidebarFooterProps {
  isSidebarOpen: boolean
  onToggle: () => void
  onOpenTags: () => void
  onOpenIgnored: () => void
}

const themeLabel: Record<string, string> = {
  light: 'Claro',
  dark: 'Escuro',
  system: 'Sistema'
}

const themeIcon: Record<string, React.ReactNode> = {
  light: <Sun size={18} strokeWidth={2} />,
  dark: <Moon size={18} strokeWidth={2} />,
  system: <Monitor size={18} strokeWidth={2} />
}

export const GlobalSidebarFooter: React.FC<GlobalSidebarFooterProps> = ({ 
  isSidebarOpen, 
  onToggle, 
  onOpenTags, 
  onOpenIgnored 
}) => {
  const { theme, setTheme } = useTheme()

  const handleToggleTheme = () => {
    if (theme === 'light') setTheme('dark')
    else if (theme === 'dark') setTheme('system')
    else setTheme('light')
  }

  return (
    <div className="global-sidebar-footer">
      <button className="global-sidebar-footer-btn" onClick={onOpenTags} aria-label="Gerenciar tags" title="Gerenciar tags">
        <span className="global-sidebar-nav-icon" aria-hidden="true">
          <Tag size={18} strokeWidth={2} />
        </span>
        <span className="global-sidebar-nav-label">Tags</span>
      </button>
      <button className="global-sidebar-footer-btn" onClick={onOpenIgnored} aria-label="Arquivos ignorados" title="Arquivos ignorados">
        <span className="global-sidebar-nav-icon" aria-hidden="true">
          <EyeOff size={18} strokeWidth={2} />
        </span>
        <span className="global-sidebar-nav-label">Ignored</span>
      </button>
      <button
        className="global-sidebar-footer-btn global-sidebar-theme-btn"
        onClick={handleToggleTheme}
        aria-label={`Alternar tema (Atual: ${themeLabel[theme]})`}
        title={`Alternar tema (Atual: ${themeLabel[theme]})`}
      >
        <span className="global-sidebar-nav-icon" aria-hidden="true">
          {themeIcon[theme]}
        </span>
        <span className="global-sidebar-nav-label">{themeLabel[theme]}</span>
      </button>
      <button 
        className="global-sidebar-footer-btn global-sidebar-toggle-btn" 
        onClick={onToggle} 
        aria-label={isSidebarOpen ? 'Recolher sidebar' : 'Expandir sidebar'}
        title={isSidebarOpen ? 'Recolher sidebar' : 'Expandir sidebar'}
      >
        <span className="global-sidebar-nav-icon" aria-hidden="true">
          {isSidebarOpen ? <ChevronsLeft size={18} strokeWidth={2} /> : <ChevronsRight size={18} strokeWidth={2} />}
        </span>
        <span className="global-sidebar-nav-label">{isSidebarOpen ? 'Recolher' : 'Expandir'}</span>
      </button>
      <button
        className="global-sidebar-footer-btn global-sidebar-devtools-btn"
        onClick={() => window.codeAwareness.toggleDevTools()}
        aria-label="Abrir DevTools"
        title="Abrir DevTools (F12)"
      >
        <span className="global-sidebar-nav-icon" aria-hidden="true">
          <Wrench size={18} strokeWidth={2} />
        </span>
        <span className="global-sidebar-nav-label">DevTools</span>
      </button>
    </div>
  )
}
