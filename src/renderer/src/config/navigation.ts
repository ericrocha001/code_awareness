/*
-T ---
*/

import { Home, Flag, FileText, Archive, Zap, GitBranch, Bookmark, Map, type LucideIcon } from 'lucide-react'

export type NavId = 'home' | 'campaigns' | 'codebase' | 'compression' | 'dash' | 'diff' | 'journey' | 'code-map'
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
  { id: 'dash', label: 'Code Dash', icon: 'codicon-zap', lucideIcon: Zap },
  { id: 'diff', label: 'Code Diff', icon: '🔀', lucideIcon: GitBranch },
  { id: 'journey', label: 'Code Journey', icon: '📋', lucideIcon: Bookmark },
  { id: 'code-map', label: 'Code Map', icon: '🗺️', lucideIcon: Map }
]

