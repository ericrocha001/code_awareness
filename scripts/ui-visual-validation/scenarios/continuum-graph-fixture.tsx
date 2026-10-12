import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ContinuumView } from '../../../src/renderer/src/components/ContinuumView/ContinuumView'
import '../../../src/renderer/src/index.css'

function Fixture() {
  const [path, setPath] = useState(new URLSearchParams(location.search).get('repositoryPath')!)
  useEffect(() => {
    const change = (event: Event) => setPath((event as CustomEvent<string>).detail)
    window.addEventListener('fixture-repository', change)
    return () => window.removeEventListener('fixture-repository', change)
  }, [])
  return <ContinuumView activeProject={{ id: 'graph-acceptance', path, name: 'Continuum Graph · Isolated acceptance' }} />
}
document.body.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(<Fixture />)
