import type { App } from 'electron'

export function registerApplicationShutdown(app: Pick<App, 'on' | 'quit'>, dispose: () => Promise<void>): void {
  let shuttingDown = false
  let disposed = false
  app.on('before-quit', (event) => {
    if (disposed) return
    event.preventDefault()
    if (shuttingDown) return
    shuttingDown = true
    void dispose().catch(() => {
      console.error('[Main] Shutdown cleanup failed')
    }).finally(() => {
      disposed = true
      app.quit()
    })
  })
}
