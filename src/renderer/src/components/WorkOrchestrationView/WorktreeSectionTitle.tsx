import React from 'react'
import { ChevronDown, type LucideIcon } from 'lucide-react'

export function WorktreeSectionTitle({ icon: Icon, children, meta }: { icon: LucideIcon; children: React.ReactNode; meta?: React.ReactNode }) {
  return <><Icon size={18} aria-hidden="true" /><span className="wo-disclosure-label">{children}</span>{meta != null && <small>{meta}</small>}<ChevronDown className="wo-disclosure-chevron" size={15} aria-hidden="true" /></>
}
