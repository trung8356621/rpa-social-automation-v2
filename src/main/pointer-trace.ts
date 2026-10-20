import { screen, type BrowserWindow, type WebContents } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { BrowserCore } from "./browser-core.js";
import type { CreatorOverlays } from "./creator-overlays.js";
export class PointerTrace {
  private events: unknown[] = [];
  readonly file: string;
  constructor(
    readonly window: BrowserWindow,
    readonly browser: BrowserCore,
    readonly overlays: CreatorOverlays,
    readonly enabled: boolean,
    dataPath: string,
  ) {
    this.file = path.join(dataPath, "pointer-routing.jsonl");
    if (!enabled) return;
    mkdirSync(dataPath, { recursive: true });
    const attach = (name: string, wc: WebContents) => {
      wc.on("before-mouse-event", (_event, mouse) => {
        if (["mouseDown", "mouseUp"].includes(mouse.type))
          this.record({
            kind: "native-mouse",
            prevented: _event.defaultPrevented,
            view: name,
            id: wc.id,
            type: mouse.type,
            x: mouse.x,
            y: mouse.y,
            ...this.snapshot(),
          });
      });
      wc.on("focus", () =>
        this.record({ kind: "focus", view: name, id: wc.id }),
      );
      wc.on("blur", () => this.record({ kind: "blur", view: name, id: wc.id }));
    };
    attach("shell", window.webContents);
    attach("debug", overlays.debug.webContents);
    browser.onViewCreated(wc => attach("browser", wc));
    this.record({ kind: "initial-layout", ...this.snapshot() });
  }
  snapshot() {
    let cursor: { x: number; y: number } | undefined;
    try {
      cursor = screen.getCursorScreenPoint();
    } catch {
      /* Locked/noninteractive desktop. */
    }
    const origin = this.window.getContentBounds();
    const point = cursor
      ? { x: cursor.x - origin.x, y: cursor.y - origin.y }
      : undefined;
    const inside = (b: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) =>
      !!point &&
      point.x >= b.x &&
      point.y >= b.y &&
      point.x < b.x + b.width &&
      point.y < b.y + b.height;
    const expected = !point
      ? "unknown"
      : this.overlays.debug.getVisible() &&
          inside(this.overlays.debug.getBounds())
        ? "debug"
        : this.browser.visible && inside(this.browser.bounds)
          ? "browser"
          : point.x < 320
            ? "step-list"
            : "shell/editor";
    return {
      cursor,
      point,
      expected,
      input: this.browser.inputFocus(),
      editorOpen: this.overlays.editorOpen,
      debugOpen: this.overlays.debugOpen,
      browser: {
        id: this.browser.view.webContents.id,
        bounds: this.browser.view.getBounds(),
        visible: this.browser.visible,
        focused: this.browser.view.webContents.isFocused(),
        zoom: this.browser.zoom,
      },
      debug: {
        id: this.overlays.debug.webContents.id,
        bounds: this.overlays.debug.getBounds(),
        visible: this.overlays.debug.getVisible(),
        focused: this.overlays.debug.webContents.isFocused(),
      },
      shell: {
        id: this.window.webContents.id,
        focused: this.window.webContents.isFocused(),
      },
      window: this.window.getContentBounds(),
      stack: this.window.contentView.children.map((v) => ({
        bounds: v.getBounds(),
        visible: v.getVisible(),
        id: (v as { webContents?: WebContents }).webContents?.id,
      })),
    };
  }
  record(event: object) {
    if (!this.enabled) return;
    const entry = { at: new Date().toISOString(), ...event };
    this.events.push(entry);
    if (this.events.length > 100) this.events.shift();
    try {
      appendFileSync(this.file, JSON.stringify(entry) + "\n");
    } catch {
      /* Diagnostics must never interfere with pointer delivery. */
    }
  }
  report() {
    return {
      enabled: this.enabled,
      file: this.file,
      ...this.snapshot(),
      events: this.events,
    };
  }
}
