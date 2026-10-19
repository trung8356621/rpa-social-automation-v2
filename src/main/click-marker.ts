import { BrowserWindow } from "electron";
import type { BrowserCore } from "./browser-core.js";

/** Creator-only native overlay; never touches the page or receives input. */
export class ClickMarker {
  private timer?: ReturnType<typeof setTimeout>;
  private point?: { x: number; y: number };
  private readonly view: BrowserWindow;
  private readonly ready: Promise<void>;
  constructor(private readonly parent: BrowserWindow, private readonly browser: BrowserCore) {
    this.view = new BrowserWindow({ parent, width: 12, height: 12, show: false,
      frame: false, transparent: true, focusable: false, skipTaskbar: true,
      resizable: false, hasShadow: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    this.view.setIgnoreMouseEvents(true);
    this.ready = this.view.loadURL('data:text/html,' + encodeURIComponent(
      '<body style="margin:0;overflow:hidden;pointer-events:none"><div style="width:12px;height:12px;border-radius:50%;background:red"></div>'));
    parent.on("move", () => this.position());
    parent.on("resize", () => this.hide());
    parent.on("minimize", () => this.hide());
  }
  private position() {
    if (!this.point || this.view.isDestroyed()) return;
    const origin = this.parent.getContentBounds(), bounds = this.browser.bounds;
    this.view.setPosition(Math.round(origin.x + bounds.x + this.point.x - 6),
      Math.round(origin.y + bounds.y + this.point.y - 6));
  }
  private hide() {
    if (this.timer) clearTimeout(this.timer);
    this.point = undefined;
    if (!this.view.isDestroyed()) this.view.hide();
  }
  show(x: number, y: number) {
    this.hide();
    this.point = { x: Math.floor(x), y: Math.floor(y) };
    this.position();
    void this.ready.then(() => {
      if (this.point && !this.view.isDestroyed()) this.view.showInactive();
    }).catch(() => this.hide());
    this.timer = setTimeout(() => this.hide(), 3000);
  }
}
