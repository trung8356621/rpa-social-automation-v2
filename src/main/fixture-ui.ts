import { type BrowserWindow, type WebContents } from "electron";
import type { CreatorOverlays } from "./creator-overlays.js";

const workspaces = new WeakMap<BrowserWindow, CreatorOverlays>();
export function registerFixtureWorkspace(
  window: BrowserWindow,
  overlays: CreatorOverlays,
) {
  workspaces.set(window, overlays);
}
/** Routes existing fixture selectors to the real native renderer that owns them.
 * Input coordinates remain local to that renderer; no hidden duplicate UI exists. */
export function fixtureUi(window: BrowserWindow) {
  const overlays = workspaces.get(window)!;
  const contents = [
    window.webContents,
    overlays.editor.webContents,
    overlays.debug.webContents,
  ];
  let active = window.webContents;
  let reload: Promise<unknown> = Promise.resolve();
  return {
    async executeJavaScript(code: string): Promise<any> {
      await reload;
      const match = code.match(/querySelector(?:All)?\(\s*(["'])(.*?)\1/s);
      const selector = match?.[2];
      if (!selector && code.includes("document.activeElement"))
        active = contents.find((wc) => wc.isFocused()) ?? active;
      let candidates = selector ? ([] as WebContents[]) : [active];
      if (selector)
        for (const wc of contents) {
          if (
            await wc.executeJavaScript(
              `!!document.querySelector(${JSON.stringify(selector)})`,
            )
          )
            candidates.push(wc);
        }
      const buttonText = code.match(
        /textContent\.includes\(("(?:[^"\\]|\\.)*")\)/,
      )?.[1];
      if (selector === "button" && buttonText) {
        const matching: WebContents[] = [];
        for (const wc of candidates)
          if (
            await wc.executeJavaScript(
              `[...document.querySelectorAll('button')].some(b=>b.textContent.includes(${buttonText}))`,
            )
          )
            matching.push(wc);
        candidates = matching;
      }
      if (!candidates.length) candidates = [active];
      let error: unknown;
      for (const wc of candidates) {
        try {
          // Fixtures explicitly reveal advanced controls before operating on them.
          // Read-only assertions leave the default collapsed state intact.
          if (
            code.includes("scrollIntoView") ||
            code.includes("dispatchEvent")
          ) {
            const text = code.match(
              /textContent\.includes\(("(?:[^"\\]|\\.)*")\)/,
            )?.[1];
            await wc.executeJavaScript(
              `(()=>{const e=${text ? `[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${text}))` : selector ? `document.querySelector(${JSON.stringify(selector)})` : "null"};for(let p=e?.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;})()`,
            );
          }
          const result = await wc.executeJavaScript(code);
          active = wc;
          return result;
        } catch (e) {
          error = e;
        }
      }
      throw error;
    },
    focus() {
      active.focus();
    },
    sendInputEvent(
      event:
        | Electron.MouseInputEvent
        | Electron.KeyboardInputEvent
        | Electron.MouseWheelInputEvent,
    ) {
      active.sendInputEvent(event);
    },
    reload() {
      active = window.webContents;
      reload = new Promise((resolve) => {
        window.webContents.once("did-finish-load", () =>
          setTimeout(resolve, 250),
        );
        window.webContents.reload();
      });
    },
    send(channel: string, ...args: unknown[]) {
      window.webContents.send(channel, ...args);
    },
    capturePage() {
      return window.capturePage();
    },
  };
}
