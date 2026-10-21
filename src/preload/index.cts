import { contextBridge, ipcRenderer } from "electron";
import type { Command, Result, ExecutionStart, BrowserSessionsState, State } from "../shared/contracts.js";
contextBridge.exposeInMainWorld("creator", {
  onRecording: (callback: (message: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: unknown) => callback(message);
    ipcRenderer.on("creator:recording", handler);
    return () => ipcRenderer.removeListener("creator:recording", handler);
  },
  onCaseState: (callback: (state: State) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: State) => callback(state);
    ipcRenderer.on("creator:case-state", handler);
    return () => ipcRenderer.removeListener("creator:case-state", handler);
  },
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
  onLayout: (callback: (bounds: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, bounds: unknown) =>
      callback(bounds);
    ipcRenderer.on("creator:layout", handler);
    return () => ipcRenderer.removeListener("creator:layout", handler);
  },
  onFocusFlow: (callback: () => void) => {
    ipcRenderer.on("creator:focus-flow", callback);
    return () => ipcRenderer.removeListener("creator:focus-flow", callback);
  },
  onRequestClose: (callback: () => void) => {
    ipcRenderer.on("creator:request-close", callback);
    return () => ipcRenderer.removeListener("creator:request-close", callback);
  },
  invoke: (command: Command) => ipcRenderer.invoke("creator:command", command),
  onNavigation: (callback: (url: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, url: string) =>
      callback(url);
    ipcRenderer.on("creator:navigation", handler);
    return () => ipcRenderer.removeListener("creator:navigation", handler);
  },
  onBrowserSessions: (callback: (snapshot: BrowserSessionsState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: BrowserSessionsState) => callback(snapshot);
    ipcRenderer.on("creator:browser-sessions", handler);
    return () => ipcRenderer.removeListener("creator:browser-sessions", handler);
  },
  onExecution: (callback: (execution: ExecutionStart) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, execution: ExecutionStart) => callback(execution);
    ipcRenderer.on("creator:execution-start", handler);
    return () => ipcRenderer.removeListener("creator:execution-start", handler);
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

// Observe UI only. No script is injected into Facebook, no event is cancelled.
window.addEventListener("DOMContentLoaded", () => {
  if (!ipcRenderer.sendSync("creator:pointer-enabled")) return;
  for (const type of ["pointerdown", "pointerup", "click"])
    document.addEventListener(
      type,
      (event) => {
        const mouse = event as MouseEvent,
          element = event.target;
        if (!(element instanceof Element)) return;
        const control = element.closest("button,input,select,summary");
        ipcRenderer.send("creator:pointer-dom", {
          type,
          x: mouse.clientX,
          y: mouse.clientY,
          trusted: event.isTrusted,
          control:
            control?.getAttribute("aria-label") ||
            control?.textContent?.trim().slice(0, 80) ||
            element.tagName,
        });
      },
      true,
    );
});
