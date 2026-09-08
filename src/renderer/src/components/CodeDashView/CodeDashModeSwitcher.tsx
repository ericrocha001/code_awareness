import React, { useCallback, useRef } from 'react'

export type DashMode = 'selective' | 'quick'

interface CodeDashModeSwitcherProps {
  mode: DashMode
  onModeChange: (mode: DashMode) => void
}

const MODES: ReadonlyArray<{ value: DashMode; label: string }> = [
  { value: 'selective', label: 'Contexto Seletivo' },
  { value: 'quick', label: 'XML Rápido' }
]

export const CodeDashModeSwitcher: React.FC<CodeDashModeSwitcherProps> = ({
  mode,
  onModeChange
}) => {
  const tablistRef = useRef<HTMLDivElement>(null)

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()

      const currentIndex = MODES.findIndex((m) => m.value === mode)
      const nextIndex =
        e.key === 'ArrowRight'
          ? (currentIndex + 1) % MODES.length
          : (currentIndex - 1 + MODES.length) % MODES.length

      onModeChange(MODES[nextIndex].value)

      const tabs = Array.from(
        tablistRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []
      )
      tabs[nextIndex]?.focus()
    },
    [mode, onModeChange]
  )

  return (
    <div
      ref={tablistRef}
      className="dash-mode-switcher"
      role="tablist"
      aria-label="Modo de geração do Code Dash"
    >
      {MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          role="tab"
          className="dash-mode-tab"
          aria-selected={mode === m.value}
          tabIndex={mode === m.value ? 0 : -1}
          onClick={() => onModeChange(m.value)}
          onKeyDown={handleKeyDown}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}