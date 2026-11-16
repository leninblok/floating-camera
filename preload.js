const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  markStartup: (phase) => ipcRenderer.send('app:startup-phase', phase),
  stepLayout: (id, timestamp) => ipcRenderer.invoke('app:stepLayout', id, timestamp),
  onAnimateLayout: (handler) => ipcRenderer.on('camera:animate-layout', (_event, id) => handler(id)),
  onCancelLayout: (handler) => ipcRenderer.on('camera:cancel-layout', (_event, id) => handler(id)),
  getBounds: () => ipcRenderer.invoke('app:getBounds'),
  moveWindow: (position) => ipcRenderer.send('app:move', { x: position?.x, y: position?.y }),
  toggleFocus: () => ipcRenderer.invoke('app:toggleFocus'),
  finishMove: () => ipcRenderer.invoke('app:finishMove'),
  revealWindow: () => ipcRenderer.invoke('app:revealWindow'),
  getInitialState: () => ipcRenderer.invoke('app:getInitialState'),
  ensureCameraAccess: () => ipcRenderer.invoke('app:ensureCameraAccess'),
  openCameraPrivacySettings: () => ipcRenderer.invoke('app:openCameraPrivacySettings'),
  setCameraDeviceId: (deviceId) => ipcRenderer.invoke('camera:setDeviceId', deviceId),
  syncCameraDevices: (devices) => ipcRenderer.invoke('camera:syncDevices', devices),
  onSetMirror: (handler) => ipcRenderer.on('camera:set-mirror', (_event, enabled) => handler(Boolean(enabled))),
  onSetBorder: (handler) => ipcRenderer.on('camera:set-border', (_event, enabled) => handler(Boolean(enabled))),
  onSetShadow: (handler) => ipcRenderer.on('camera:set-shadow', (_event, enabled) => handler(Boolean(enabled))),
  onSizeChanged: (handler) => ipcRenderer.on('camera:size-changed', (_event, size) => handler(Number(size))),
  onSetShape: (handler) => ipcRenderer.on('camera:set-shape', (_event, shape) => handler({
    shapeMode: shape?.shapeMode === 'rectangle' ? 'rectangle' : 'circle',
    aspectRatio: typeof shape?.aspectRatio === 'string' ? shape.aspectRatio : '4:5',
  })),
  onSetFocus: (handler) => ipcRenderer.on('camera:set-focus', (_event, enabled) => handler(Boolean(enabled))),
  onSetCameraDevice: (handler) => ipcRenderer.on('camera:set-device', (_event, deviceId) => handler(typeof deviceId === 'string' ? deviceId : null)),
});
