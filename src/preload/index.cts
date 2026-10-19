import { contextBridge, ipcRenderer } from "electron";
import type { Command, Result } from "../shared/contracts.js";
contextBridge.exposeInMainWorld("creator", {
  readDraft: (key: string, initial: unknown) =>
    ipcRenderer.sendSync("creator:draft", { key, initial }),
  writeDraft: (key: string, value: unknown) =>
    ipcRenderer.sendSync("creator:draft", { key, value, write: true }),
  onDraft: (callback: (key: string, entry: unknown) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      key: string,
      entry: unknown,
    ) => callback(key, entry);
    ipcRenderer.on("creator:draft-update", handler);
    return () => ipcRenderer.removeListener("creator:draft-update", handler);
  },
  onFocusFlow: (callback: () => void) => {
    ipcRenderer.on("creator:focus-flow", callback);
    return () => ipcRenderer.removeListener("creator:focus-flow", callback);
  },
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
