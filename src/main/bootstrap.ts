import { app } from 'electron'
import { initializeElectronPreview, isRuntimePreview, failPreviewBootstrap } from './work-orchestration/runtime-preview/electron-mode'

async function bootstrap() {
  if (isRuntimePreview()) {
    try { await initializeElectronPreview(app) } catch (error) { failPreviewBootstrap(app, error) }
  }
  await import('./main.js')
}
void bootstrap()
