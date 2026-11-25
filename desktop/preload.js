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
  // The follow window (main.js): a profile on Instagram or Facebook with only its follow / add-friend button.
  followNetworks: ipcRenderer.sendSync('follow-networks'),
  follow: (spec) => ipcRenderer.invoke('follow', spec),
  // „Prejsť z Beeperu“ (main.js): a copy of Beeper Desktop's index.db, read in pieces, deleted by beeperDone.
  beeperFind: () => ipcRenderer.invoke('beeper-find'),
  beeperPiece: (name, offset, length) => ipcRenderer.invoke('beeper-piece', name, offset, length),
  beeperDone: () => ipcRenderer.invoke('beeper-done'),
});
