// Gives the app page (and only it: main.js checks the origin and the frame) the login and call window API, and a way
// to come to the front.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  collect: (spec) => ipcRenderer.invoke('collect', spec),
  cancelCollect: () => ipcRenderer.invoke('cancel-collect'),
  focus: () => ipcRenderer.invoke('focus'),
  // Call windows (main.js): the networks they can open, one chat each; forgetCalls signs them all out.
  callNetworks: ipcRenderer.sendSync('call-networks'),
  call: (spec) => ipcRenderer.invoke('call', spec),
  forgetCalls: () => ipcRenderer.invoke('call-forget'),
});
