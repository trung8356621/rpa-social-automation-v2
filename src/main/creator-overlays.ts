import { WebContentsView, type BrowserWindow } from "electron";
import type { BrowserCore } from "./browser-core.js";
import { workspaceLayout } from "../shared/geometry.js";

/** Shell Editor and browser layout. Debug is detached for legacy diagnostics. */
export class CreatorOverlays {
  readonly debug: WebContentsView;
  private expanded = { editor: false, debug: true };
  private visible = true;
  scroll = {left: 0, top: 0};
  constructor(
    readonly window: BrowserWindow,
    preload: string,
    readonly browser: BrowserCore,
  ) {
    this.debug = new WebContentsView({
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.debug.setBackgroundColor("#142238");
    this.debug.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.debug.webContents.on("will-navigate", (e) => e.preventDefault());
    // Debug is retained only as a detached compatibility surface.
    this.layout();
  }
  get views() {
    return [this.debug];
  }
  get editorOpen() {
    return this.expanded.editor;
  }
  get debugOpen() {
    return this.expanded.debug;
  }
  layout() {
    const [width, height] = this.window.getContentSize();
    const bounds = workspaceLayout(
      this.expanded.editor,
      this.expanded.debug,
      width,
      height,
    );
    bounds.browser.x -= this.scroll.left;
    bounds.browser.y -= this.scroll.top;
    Object.assign(this.browser.bounds, bounds.browser);
    this.browser.view.setBounds(bounds.browser);
    // Legacy diagnostics can inspect bounds, but no Debug surface is attached.
    this.debug.setBounds(bounds.debug);
    this.debug.setVisible(false);
  }
  setExpanded(panel: "editor" | "debug", expanded: boolean) {
    this.expanded[panel] = expanded;
    this.layout();
    return expanded;
  }
  toggle(panel: "editor" | "debug") {
    return this.setExpanded(panel, !this.expanded[panel]);
  }
  setVisible(visible: boolean) {
    this.visible = visible;
    this.debug.setVisible(false);
  }
  async load(file: string) {
    // No bottom Test & Debug renderer.
  }
  close() {
    if (!this.debug.webContents.isDestroyed()) this.debug.webContents.close();
  }
}
