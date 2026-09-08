/*
-T ---
*/

import React from 'react'
import { useTheme } from '../../../hooks/useTheme'
import { resolveTagPalette } from '../../../utils/color-utils'
import type { Tag } from '../../../../../shared/types'
import './TagChip.css'

export interface TagChipProps {
  tag: Tag
  onClick?: () => void
}

export const TagChip: React.FC<TagChipProps> = ({ tag, onClick }) => {
  const { effectiveTheme, theme } = useTheme()
  const currentTheme = (effectiveTheme || (theme === 'light' ? 'light' : 'dark')) as 'light' | 'dark'
  const palette = resolveTagPalette(tag.color, currentTheme)

  return (
    <span
      className="tag-chip"
      style={{
        backgroundColor: palette.background,
        color: palette.text
      }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {tag.name}
    </span>
  )
}
