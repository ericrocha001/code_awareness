import React from 'react'
import { createRoot } from 'react-dom/client'
import { ChannelView } from '../../../src/renderer/src/components/ChannelView/ChannelView'
import '../../../src/renderer/src/index.css'
document.body.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(<ChannelView />)
