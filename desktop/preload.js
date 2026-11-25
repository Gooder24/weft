// Gives the app page (and only it: main.js checks the origin and the frame) the login and call window API, and a way
// to come to the front.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  // „Prejsť z Beeperu“ (main.js): a copy of Beeper Desktop's index.db and the cached files asked for, read in pieces;
  // beeperDone deletes the copy.
  beeperFind: () => ipcRenderer.invoke('beeper-find'),
  beeperPiece: (name, offset, length) => ipcRenderer.invoke('beeper-piece', name, offset, length),
  beeperMedia: (ids) => ipcRenderer.invoke('beeper-media', ids),
  beeperDone: () => ipcRenderer.invoke('beeper-done'),
  // The board (main.js, localsend.js). A file goes by the path of the File the page holds (dropped or picked), so the
  // page cannot name another; a File without one (a pasted picture) goes as its bytes.
  board: {
    call: (op, ...args) => ipcRenderer.invoke('board', op, ...args),
    send: async ({ files = [], text, to } = {}) => ipcRenderer.invoke('board-send', {
      text, to,
      files: await Promise.all(Array.from(files, async (f) => {
        const path = webUtils.getPathForFile(f);
        return path ? { path } : { name: f.name, type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) };
      })),
    }),
    on: (fn) => { const h = (_e, ev) => fn(ev); ipcRenderer.on('board', h); return () => ipcRenderer.off('board', h); },
  },
});
