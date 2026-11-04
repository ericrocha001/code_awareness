import React from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsModal } from '../../../src/renderer/src/components/SettingsModal/SettingsModal'
import '../../../src/renderer/src/index.css'
import type { CodexArchiveReadiness } from '../../../src/shared/types/codex-archive-types'

let state: CodexArchiveReadiness = { state: 'NOT_CONFIGURED' }
const listeners = new Set<(value: CodexArchiveReadiness) => void>()
const emit = (value: CodexArchiveReadiness) => { state = value; for (const callback of listeners) callback(value) }
window.codeAwareness = {
  loadSettings: async () => ({ gitManagement: { automaticFetch: false } }), saveSettings: async () => ({ success: true }),
  codexArchive: { inspect: async () => state, onChanged: callback => { listeners.add(callback); return () => { listeners.delete(callback) } },
    enable: async () => { emit({ state: 'READY', version: '0.155.0' }); return state }, disable: async () => { emit({ state: 'NOT_CONFIGURED' }); return state } }
} as typeof window.codeAwareness
;(window as any).codexArchiveFixture = { emit }
document.body.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(<><div style={{ padding: 12 }}>Fixture visual: não conecta ao Codex.</div><SettingsModal hidden={[]} ready saving={false} error={null} onSetVisible={() => {}} onRestore={() => {}} onClose={() => {}} /></>)
