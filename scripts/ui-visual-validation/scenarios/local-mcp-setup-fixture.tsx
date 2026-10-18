import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChannelTab } from '../../../src/renderer/src/components/ChannelView/ChannelTab'
import '../../../src/renderer/src/index.css'
document.body.dataset.theme = 'dark'
function Fixture() {
  const [active, setActive] = useState(false)
  return <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}><nav><button onClick={() => setActive(true)}>Channel</button><button onClick={() => setActive(false)}>Home</button></nav><ChannelTab active={active} /></div>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
