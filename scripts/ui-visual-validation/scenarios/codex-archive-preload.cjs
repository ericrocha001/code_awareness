const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('codeAwareness', {
  codexArchive: {
    inspect: () => ipcRenderer.invoke('codex-archive:inspect'),
    enable: () => ipcRenderer.invoke('codex-archive:enable'),
    disable: () => ipcRenderer.invoke('codex-archive:disable'),
    select: id => ipcRenderer.invoke('codex-archive:select', id),
    chooseAdvanced: () => ipcRenderer.invoke('codex-archive:choose-advanced'),
    onChanged: callback => {
      const listener = (_event, value) => callback(value)
      ipcRenderer.on('codex-archive:changed', listener)
      return () => ipcRenderer.removeListener('codex-archive:changed', listener)
    }
  },
  loadSettings: async () => ({ gitManagement: { automaticFetch: false } }),
  saveSettings: async () => ({ success: true })
})
