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