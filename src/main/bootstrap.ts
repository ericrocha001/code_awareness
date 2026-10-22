import { app } from 'electron'
import { initializeElectronPreview } from './work-orchestration/runtime-preview/electron-mode'

if (process.env.PREVIEW_SESSION_ID) initializeElectronPreview(app)
void import('./main.js')
