import React from 'react'
import { createRoot } from 'react-dom/client'
import { ContextBundleBuilder } from '../../../src/renderer/src/components/ContinuumView/ContextBundleBuilder'
import '../../../src/renderer/src/index.css'
document.body.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(<ContextBundleBuilder repositoryId="proof-repository" tags={[{ slug: 'git-atlas', name: 'Git Atlas', description: 'Fontes da arquitetura Git Atlas', count: 41 }]} facets={[{ key: 'artifactRole', values: [{ value: 'ARCHITECTURE_MAP', count: 67 }] }]} onClose={() => { document.body.dataset.closed = 'true' }} />)
