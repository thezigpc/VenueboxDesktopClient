// The settings window's only door into the app.

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("venuebox", {
  state: () => ipcRenderer.invoke("state"),
  onState: (fn: (s: unknown) => void) => ipcRenderer.on("state", (_e, s) => fn(s)),
  testBox: (address: string) => ipcRenderer.invoke("box:test", address),
  setBox: (address: string) => ipcRenderer.invoke("box:set", address),
  setName: (name: string) => ipcRenderer.invoke("name:set", name),
  unpair: () => ipcRenderer.invoke("unpair"),
  setStartAtLogin: (on: boolean) => ipcRenderer.invoke("login:set", on),
  identify: (id: string) => ipcRenderer.invoke("identify", id),
  quit: () => ipcRenderer.invoke("quit"),
});
