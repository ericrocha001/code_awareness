/*
-T ---
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