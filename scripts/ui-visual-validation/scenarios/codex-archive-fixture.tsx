import React from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsModal } from '../../../src/renderer/src/components/SettingsModal/SettingsModal'
import '../../../src/renderer/src/index.css'
document.body.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(<><div style={{ padding: 12 }}>Fixture visual: não conecta ao Codex.</div><SettingsModal hidden={[]} ready saving={false} error={null} onSetVisible={() => {}} onRestore={() => {}} onClose={() => {}} /></>)
