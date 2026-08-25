/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Definir centralizadamente o array de itens de navegação principal da aplicação e exportar os tipos NavId e Tab.

Mapa de Relacionamentos do Script

1. ../components/GlobalSidebar/GlobalSidebar.tsx
   - Tipo: Dependência Inversa
   - Relação: Importa NAV_ITEMS e Tab.
   - Criticidade: Alta

2. ../components/GlobalSidebar/GlobalSidebarNav.tsx
   - Tipo: Dependência Inversa
   - Relação: Importa NavId e NavItem.
   - Criticidade: Alta

Invariantes do Script

1. A lista de navegação contém apenas abas válidas do sistema.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { Home, Flag, FileText, Archive, GitBranch, Bookmark, Map, type LucideIcon } from 'lucide-react'

export type NavId = 'home' | 'campaigns' | 'codebase' | 'compression' | 'diff' | 'journey' | 'code-map'
export type Tab = NavId

export interface NavItem {
  id: NavId
  label: string
  icon: string
  lucideIcon: LucideIcon
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Home', icon: '🏠', lucideIcon: Home },
  { id: 'campaigns', label: 'Code Campaign', icon: '🚩', lucideIcon: Flag },
  { id: 'codebase', label: 'Code Source', icon: '📄', lucideIcon: FileText },
  { id: 'compression', label: 'Code Compression', icon: '🗜', lucideIcon: Archive },
  { id: 'diff', label: 'Code Diff', icon: '🔀', lucideIcon: GitBranch },
  { id: 'journey', label: 'Code Journey', icon: '📋', lucideIcon: Bookmark },
  { id: 'code-map', label: 'Code Map', icon: '🗺️', lucideIcon: Map }
]
