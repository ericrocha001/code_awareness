import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('codeAwareness', {
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('save-settings', settings),
  getActiveProject: () => ipcRenderer.invoke('visibility-project'),
  onActiveProjectChanged: (callback: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => callback(state)
    ipcRenderer.on('active-project-changed', listener)
    return () => ipcRenderer.removeListener('active-project-changed', listener)
  },
  getPendingDeepLink: async () => null,
  onDeepLink: () => () => {},
  onThemeChanged: () => () => {},
  listRepositories: async () => [],
  refreshRepositories: async () => [],
  getGitHubStatus: async () => ({ state: 'DISCONNECTED' }),
  toggleDevTools: () => {}
})
