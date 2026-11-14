import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkOrchestrationTab } from '../../../src/renderer/src/components/WorkOrchestrationView/WorkOrchestrationTab'
import '../../../src/renderer/src/index.css'
import { ContinuumView } from '../../../src/renderer/src/components/ContinuumView/ContinuumView'
import type { ActiveProjectState } from '../../../src/shared/types/active-project-types'
function Fixture() {
  const [artifact, setArtifact] = useState<{ repositoryId: string; artifactId: string } | null>(null)
  const [active, setActive] = useState(true), [commit, setCommit] = useState('')
  const query = new URLSearchParams(location.search)
  const state: ActiveProjectState = { revision: 1, project: { id: 'fixture', name: 'Branch acceptance', path: query.get('repositoryPath')! },
    ...(query.has('board') ? { context: { revision: 1, mode: 'HOST', identity: 'IDENTITY_BOUND', repositoryId: 'fixture',
      activeCheckout: null, legacyCodeMapProjectId: null, sessionId: null, dataPolicy: 'HOST_CANONICAL',
      capabilities: { continuum: { state: 'READY' }, codeMap: { state: 'READY' }, channel: { state: 'READY' } } } } : {}) }
  const showFixtureNav = !query.has('board') || !!artifact
  return <>{showFixtureNav && <nav className="fixture-nav"><button onClick={() => setActive(!active)}>{active ? 'Ocultar gestor' : 'Mostrar gestor'}</button><output>{commit}</output>{artifact && <button onClick={() => { setArtifact(null); setActive(true) }}>Voltar ao gestor</button>}</nav>}<div style={{ height: showFixtureNav ? 'calc(100% - 32px)' : '100%' }}><WorkOrchestrationTab state={state} active={active} onArtifact={intent => { setArtifact(intent); setActive(false) }} onCommit={intent => setCommit(intent.commitSha)}/>{artifact && <ContinuumView activeProject={state.project} artifactIntent={artifact}/>}</div></>
}
document.body.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(<Fixture/> )
