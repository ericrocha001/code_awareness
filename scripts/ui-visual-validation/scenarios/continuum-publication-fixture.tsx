import React from 'react'
import { createRoot } from 'react-dom/client'
import { ContinuumView } from '../../../src/renderer/src/components/ContinuumView/ContinuumView'
import '../../../src/renderer/src/index.css'

document.body.dataset.theme = 'dark'
const repositoryPath = new URLSearchParams(location.search).get('repositoryPath')!
createRoot(document.getElementById('root')!).render(<ContinuumView activeProject={{ id: 'acceptance', path: repositoryPath, name: 'Isolated publication acceptance' }} />)
