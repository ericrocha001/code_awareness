import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import '../../../src/renderer/src/index.css'
import '../../../src/renderer/src/components/GlobalSidebar/GlobalSidebar.css'
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
