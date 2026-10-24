import React from 'react'
import { createRoot } from 'react-dom/client'
import { CodeMapView } from '../../../src/renderer/src/components/CodeMapView/CodeMapView'
import '../../../src/renderer/src/index.css'
const path = new URLSearchParams(location.search).get('repository')!
document.body.dataset.theme = 'dark'
const status = (message: string, error?: boolean) => { if (error) console.error(message) }
createRoot(document.getElementById('root')!).render(<CodeMapView activeProject={{ path, name: 'Code Map — convergence acceptance' }} onSelectProject={() => {}} onStatusMessage={status} />)
