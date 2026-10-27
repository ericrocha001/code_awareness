const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('codeAwareness', {
  continuumBuilder: request => ipcRenderer.invoke('continuum:builder', request),
  listContinuumArtifacts: request => ipcRenderer.invoke('builder-proof:list', request),
  getContinuumArtifact: (repositoryId, artifactId) => ipcRenderer.invoke('builder-proof:get', repositoryId, artifactId)
})
