import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkOrchestrationTab } from '../../../src/renderer/src/components/WorkOrchestrationView/WorkOrchestrationTab'
import '../../../src/renderer/src/index.css'
function Fixture() {
  const [active, setActive] = useState(true), [commit, setCommit] = useState('')
  const state = { revision: 1, project: { id: 'fixture', name: 'Branch acceptance', path: new URLSearchParams(location.search).get('repositoryPath')! } }
  return <><nav className="fixture-nav"><button onClick={() => setActive(!active)}>{active ? 'Ocultar gestor' : 'Mostrar gestor'}</button><output>{commit}</output></nav><div style={{ height: 'calc(100% - 32px)' }}><WorkOrchestrationTab state={state} active={active} onCommit={intent => setCommit(intent.commitSha)}/></div></>
}
document.body.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(<Fixture/> )
