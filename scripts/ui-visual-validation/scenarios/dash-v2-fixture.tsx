import React from 'react'
import { createRoot } from 'react-dom/client'
import { CodeDashView } from '../../../src/renderer/src/components/CodeDashView/CodeDashView'
import '../../../src/renderer/src/index.css'
document.body.dataset.theme = 'dark'
const repo = new URLSearchParams(location.search).get('repo')!
createRoot(document.getElementById('root')!).render(
  <CodeDashView repoPath={repo} projectName="Code Awareness" />
)
