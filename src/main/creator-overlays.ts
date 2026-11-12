import { WebContentsView, type BrowserWindow } from "electron";
import type { BrowserCore } from "./browser-core.js";
import {
  isCollectorBrowserHostPage,
  resolveBrowserViewBounds,
  shouldShowBrowserForPage,
  type CollectorBrowserHost,
} from "../shared/collector-browser-host.js";
import { workspaceLayout } from "../shared/geometry.js";
import type { AppPage } from "../shared/contracts.js";

/** Shell Editor and browser layout. Debug is detached for legacy diagnostics. */
export class CreatorOverlays {
  readonly debug: WebContentsView;
  private expanded = { editor: false, debug: true };
  private executionDepth = 0;
  private visible = true;
  page: AppPage = "scenarios";
  sidebarCollapsed: boolean;
  scroll = { left: 0, top: 0 };
  /** Capture-step host from renderer; ignored outside collectors. */
  collectorHost: CollectorBrowserHost | null = null;
  constructor(
    readonly window: BrowserWindow,
    preload: string,
    readonly browser: BrowserCore,
    sidebarCollapsed = false,
  ) {
    this.sidebarCollapsed = sidebarCollapsed;
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
  setCollectorHost(host: CollectorBrowserHost | null) {
    this.collectorHost = host;
    this.layout();
  }
  layout() {
    const [width, height] = this.window.getContentSize();
    const bounds = workspaceLayout(
      this.expanded.editor,
      this.expanded.debug,
      width,
      height,
      this.sidebarCollapsed,
      this.executionDepth > 0,
    );
    const scrollLeft = Math.min(this.scroll.left, Math.max(0, bounds.minWidth - width));
    bounds.browser.x -= scrollLeft;
    bounds.browser.y -= this.scroll.top;
    const browserBounds = resolveBrowserViewBounds({
      page: this.page,
      collectorHost: this.collectorHost,
      creatorBrowser: bounds.browser,
    });
    Object.assign(this.browser.bounds, browserBounds);
    this.browser.view.setBounds(browserBounds);
    const show = shouldShowBrowserForPage({
      page: this.page,
      browserVisible: this.browser.visible,
      collectorHostActive: Boolean(this.collectorHost?.active),
    });
    this.browser.view.setVisible(show);
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
  enterExecutionMode() {
    this.executionDepth++;
    this.layout();
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      this.executionDepth = Math.max(0, this.executionDepth - 1);
      this.layout();
    };
  }
  setVisible(visible: boolean) {
    this.visible = visible;
    this.debug.setVisible(false);
    this.layout();
  }
  setPage(page: AppPage) {
    this.page = page;
    this.scroll = { left: 0, top: 0 };
    // Leaving collector-host pages drops Capture/Inspection host so Browser Core does not linger over other pages.
    if (!isCollectorBrowserHostPage(page)) this.collectorHost = null;
    this.layout();
  }
  setSidebarCollapsed(collapsed: boolean) {
    this.sidebarCollapsed = collapsed;
    this.layout();
  }
  async load(file: string) {
    // No bottom Test & Debug renderer.
  }
  close() {
    if (!this.debug.webContents.isDestroyed()) this.debug.webContents.close();
  }
}
