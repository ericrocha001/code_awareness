import React from 'react'
import { createRoot } from 'react-dom/client'
import { AcademyView } from '../../../src/renderer/src/components/AcademyView/AcademyView'
import '../../../src/renderer/src/index.css'

document.body.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(<AcademyView />)
