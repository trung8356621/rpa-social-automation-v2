import { WebContentsView, type BrowserWindow } from "electron";
import { SIDE_WIDTH, TOP_HEIGHT, WEB_WIDTH, WEB_HEIGHT } from "../shared/geometry.js";

/** Native siblings above the browser. Only panel bounds change, never browser bounds. */
export class CreatorOverlays {
  readonly editor: WebContentsView;
  readonly debug: WebContentsView;
  private expanded = { editor: true, debug: true };
  private visible = true;
  constructor(readonly window: BrowserWindow, preload: string) {
    const make = () => new WebContentsView({ webPreferences: {
      preload, contextIsolation: true, nodeIntegration: false, sandbox: true,
    }});
    this.editor = make();
    this.debug = make();
    for (const view of this.views) {
      window.contentView.addChildView(view);
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      view.webContents.on("will-navigate", e => e.preventDefault());
    }
    this.layout();
  }
  get views() { return [this.editor, this.debug]; }
  layout() {
    this.editor.setBounds({ x: SIDE_WIDTH + WEB_WIDTH - 360, y: TOP_HEIGHT + 8,
      width: 352, height: this.expanded.editor ? 374 : 36 });
    this.debug.setBounds({ x: SIDE_WIDTH + 8, y: TOP_HEIGHT + WEB_HEIGHT - (this.expanded.debug ? 170 : 36) - 8,
      width: WEB_WIDTH - 16, height: this.expanded.debug ? 170 : 36 });
  }
  toggle(panel: "editor" | "debug") {
    this.expanded[panel] = !this.expanded[panel];
    this.layout();
    return this.expanded[panel];
  }
  setVisible(visible: boolean) {
    this.visible = visible;
    for (const view of this.views) view.setVisible(visible);
  }
  async load(file: string) {
    await Promise.all(this.views.map((view, index) => view.webContents.loadFile(file, {
      query: { panel: index === 0 ? "editor" : "debug" },
    })));
  }
  close() { for (const view of this.views) if (!view.webContents.isDestroyed()) view.webContents.close(); }
}
