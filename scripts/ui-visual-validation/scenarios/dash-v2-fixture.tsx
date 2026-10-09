import React from 'react'
import { createRoot } from 'react-dom/client'
import { CodeDashView } from '../../../src/renderer/src/components/CodeDashView/CodeDashView'
import { DashCodeSurface } from '../../../src/renderer/src/components/CodeDashView/DashCodeSurface'
import '../../../src/renderer/src/index.css'
document.body.dataset.theme = 'dark'
const params = new URLSearchParams(location.search)
const repo = params.has('empty') ? '' : params.get('repo')!
const largeContext = JSON.stringify([{ source: 'Literal <> 🚀\r\n'.repeat(12_000) }])
createRoot(document.getElementById('root')!).render(
  params.has('largeOutput') ? (
    <div className="dash-view-container">
      <h2>Context Packet — prova de apresentação com payload grande</h2>
      <DashCodeSurface value={largeContext} />
    </div>
  ) : (
    <CodeDashView repoPath={repo} projectName={params.get('projectName') ?? 'Code Awareness'} />
  )
)
