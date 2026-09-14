const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('api', {
  openPdf: () => ipcRenderer.invoke('pdf:open'),
  applyTextEdit: (edit) => ipcRenderer.invoke('pdf:apply-text-edit', edit),
  reset: () => ipcRenderer.invoke('pdf:reset'),
  onOpened: (cb) => ipcRenderer.on('pdf:opened', (_e, payload) => cb(payload)),
  saveAs: () => ipcRenderer.invoke('pdf:save-as')
})
