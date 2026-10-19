import { contextBridge, ipcRenderer } from "electron";
import type { Command, Result } from "../shared/contracts.js";
contextBridge.exposeInMainWorld("creator", {
  invoke: (command: Command) => ipcRenderer.invoke("creator:command", command),
  onNavigation: (callback: (url: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, url: string) =>
      callback(url);
    ipcRenderer.on("creator:navigation", handler);
    return () => ipcRenderer.removeListener("creator:navigation", handler);
  },
  onTest: (callback: (result: Result[] | { error: string }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      result: Result[] | { error: string },
    ) => callback(result);
    ipcRenderer.on("creator:shortcut-result", handler);
    return () => ipcRenderer.removeListener("creator:shortcut-result", handler);
  },
});
