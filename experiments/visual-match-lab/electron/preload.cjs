const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('liveDomLab', {
  state: () => ipcRenderer.invoke('live-dom:state'),
  capture: () => ipcRenderer.invoke('live-dom:capture'),
  inspect: (point) => ipcRenderer.invoke('live-dom:inspect', point),
  highlight: (target) => ipcRenderer.invoke('live-dom:highlight', target),
  inspectParent: (target) => ipcRenderer.invoke('live-dom:parent', target),
  scroll: (request) => ipcRenderer.invoke('live-dom:scroll', request),
});
