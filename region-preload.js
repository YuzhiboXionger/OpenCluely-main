const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('regionAPI', {
  reportPoint: (point) => ipcRenderer.send('region-point', point),
  cancel: () => ipcRenderer.send('region-cancel')
});
