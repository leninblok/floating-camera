const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  closeApp: () => ipcRenderer.invoke('app:close'),
  setSize: (w, h) => ipcRenderer.invoke('app:setSize', w, h),
  getBounds: () => ipcRenderer.invoke('app:getBounds'),
  setBounds: (bounds) => ipcRenderer.invoke('app:setBounds', bounds),
  centerWindow: (size) => ipcRenderer.invoke('app:centerWindow', size),
  setResizable: (resizable) => ipcRenderer.invoke('app:setResizable', resizable),
  getCenteredBounds: (size) => ipcRenderer.invoke('app:getCenteredBounds', size),
  getBorderEnabled: () => ipcRenderer.invoke('app:getBorderEnabled'),
  setBorderEnabled: (enabled) => ipcRenderer.invoke('app:setBorderEnabled', enabled),
  getMirrorEnabled: () => ipcRenderer.invoke('app:getMirrorEnabled'),
  setMirrorEnabled: (enabled) => ipcRenderer.invoke('app:setMirrorEnabled', enabled),
});
