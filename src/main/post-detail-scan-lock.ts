import { WebContentsView, type BrowserWindow } from "electron";
import type { BrowserCore } from "./browser-core.js";

/**
 * Auto Scan input lock:
 * 1) Event-level: BrowserCore before-mouse/before-input preventDefault (blocks OS input;
 *    sendInputEvent wheels still work).
 * 2) Transparent native WebContentsView above BrowserCore — catches hit-tests so the user
 *    cannot scroll/click the live Facebook view. Fully transparent (no gray veil).
 * 3) scanHoldVisible — keeps BrowserCore shown across overlays.layout mid-scan.
 */
export class PostDetailScanInputLock {
  private view: WebContentsView | null = null;
  private locked = false;

  constructor(
    private readonly window: BrowserWindow,
    private readonly browser: BrowserCore,
  ) {}

  get isLocked() {
    return this.locked;
  }

  setLocked(locked: boolean) {
    this.locked = locked;
    this.browser.setUserInputLocked(locked);
    this.browser.setScanHoldVisible(locked);
    if (locked) this.showShield();
    else this.hideShield();
    return {
      ok: true as const,
      locked: this.locked,
      mechanism: "transparent-shield+before-input" as const,
    };
  }

  syncBounds() {
    if (!this.locked || !this.view) return;
    const b = this.browser.view.getBounds();
    this.view.setBounds({ ...b });
    this.view.setVisible(this.browser.visible || this.browser.isScanHoldVisible);
  }

  private showShield() {
    if (!this.view) {
      this.view = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      try {
        this.view.setBackgroundColor("#00000000");
      } catch {
        /* ignore */
      }
      // Fully transparent hit-target — Facebook remains visible underneath.
      void this.view.webContents.loadURL(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(`<!doctype html><html><head><style>
            html,body{margin:0;width:100%;height:100%;background:transparent;cursor:not-allowed;overflow:hidden}
          </style></head><body>
          <script>
            const block=e=>{e.preventDefault();e.stopPropagation();};
            ["wheel","mousedown","mouseup","mousemove","click","contextmenu","keydown","keyup"].forEach(t=>
              window.addEventListener(t,block,{capture:true}));
          </script></body></html>`),
      );
      this.window.contentView.addChildView(this.view);
      try {
        const wc = this.view.webContents as Electron.WebContents & {
          setFocusable?: (focusable: boolean) => void;
        };
        wc.setFocusable?.(false);
      } catch {
        /* ignore */
      }
    }
    this.syncBounds();
    this.view.setVisible(true);
    try {
      this.window.contentView.addChildView(this.view);
    } catch {
      /* already attached */
    }
  }

  private hideShield() {
    if (!this.view) return;
    this.view.setVisible(false);
  }

  dispose() {
    this.locked = false;
    try {
      this.browser.setUserInputLocked(false);
      this.browser.setScanHoldVisible(false);
    } catch {
      /* ignore */
    }
    if (this.view && !this.view.webContents.isDestroyed()) {
      try {
        this.window.contentView.removeChildView(this.view);
      } catch {
        /* ignore */
      }
      this.view.webContents.close();
    }
    this.view = null;
  }
}
