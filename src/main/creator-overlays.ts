import { WebContentsView, type BrowserWindow } from "electron";
import type { BrowserCore } from "./browser-core.js";
import { workspaceLayout } from "../shared/geometry.js";

/** The Editor lives in the shell DOM. Only Debug remains a native overlay. */
export class CreatorOverlays {
  readonly debug: WebContentsView;
  private expanded = { editor: false, debug: true };
  private visible = true;
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
    window.contentView.addChildView(this.debug);
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
    Object.assign(this.browser.bounds, bounds.browser);
    this.browser.view.setBounds(bounds.browser);
    // This native surface exactly matches the visible Debug panel, including collapse.
    this.debug.setBounds(bounds.debug);
    this.debug.setVisible(this.visible);
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
    this.debug.setVisible(visible);
  }
  async load(file: string) {
    await this.debug.webContents.loadFile(file, { query: { panel: "debug" } });
  }
  close() {
    if (!this.debug.webContents.isDestroyed()) this.debug.webContents.close();
  }
}
