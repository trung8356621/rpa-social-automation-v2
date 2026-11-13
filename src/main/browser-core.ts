import {
  WebContentsView,
  type WebContents,
  clipboard,
  ClipboardItem,
  Menu,
  type BrowserWindow,
} from "electron";
import { buildBrowserContextMenuSpec, isCopyableLinkUrl } from "../shared/browser-context-menu.js";
import { createHash } from "node:crypto";
import { pasteWithClipboard } from "./clipboard-guard.js";
import { chooseUploadFiles } from "./file-chooser.js";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Capture, Rect } from "../shared/contracts.js";
import {
  EXECUTION_VIEWPORT,
  SIDE_WIDTH,
  TOP_HEIGHT,
  validateZoom,
  imageToInput,
  assertCanonicalScreenshot,
} from "../shared/geometry.js";
export class InputNotReady extends Error {
  constructor(readonly focus: ReturnType<BrowserCore["inputFocus"]>) {
    super(
      `TYPE_ONLY: focus đang ở sidebar/cửa sổ khác hoặc chưa có tương tác browser (browser=${focus.browser}, editor=${focus.editor}, route=${focus.route}; caret=unknown). Click thủ công ô nhập rồi dùng phím tắt, hoặc test cặp CLICK → TYPE. Native focus không chứng minh caret sẵn sàng.`,
    );
  }
}

export class BrowserCore {
  private currentView: WebContentsView;
  get view() { return this.currentView; }
  private readonly viewListeners = new Set<(contents: WebContents) => void>();
  private partition: string;
  readonly bounds: Rect = {
    x: SIDE_WIDTH,
    y: TOP_HEIGHT,
    ...EXECUTION_VIEWPORT,
  };
  private editors: WebContents[] = [];
  trackEditor(contents: WebContents) {
    this.editors.push(contents);
    contents.on("before-mouse-event", () => {
      this.inputRoute = "editor";
    });
    contents.on("before-input-event", () => {
      this.inputRoute = "editor";
    });
    contents.on("focus", () => {
      this.inputRoute = "editor";
    });
  }
  private captures = new Map<string, Buffer>();
  /** Serialize CDP screenshots — overlapping capture/detach races hang first extends. */
  private captureGate: Promise<void> = Promise.resolve();
  zoom = 1;
  visible = true;
  /**
   * When true, OS mouse/wheel/keyboard to BrowserCore are preventDefault'd.
   * Does not affect programmatic sendInputEvent (Auto Scan wheel).
   */
  private userInputLocked = false;
  /**
   * Auto Scan hold: overlays.layout must keep the native view visible even if
   * collector host briefly goes inactive (root cause of false WHEEL_BLOCKED_NOT_VISIBLE).
   */
  private scanHoldVisible = false;
  private inputRoute: "browser" | "editor" | "unknown" = "unknown";

  setUserInputLocked(locked: boolean) {
    this.userInputLocked = Boolean(locked);
  }

  get isUserInputLocked() {
    return this.userInputLocked;
  }

  setScanHoldVisible(hold: boolean) {
    this.scanHoldVisible = Boolean(hold);
    if (this.scanHoldVisible) {
      this.visible = true;
      this.view.setVisible(true);
    }
  }

  get isScanHoldVisible() {
    return this.scanHoldVisible;
  }
  constructor(
    readonly window: BrowserWindow,
    readonly evidenceDir: string,
    partition: string,
  ) {
    this.partition = partition;
    this.currentView = this.createView(partition);
    window.contentView.addChildView(this.view);
    this.view.setBounds(this.bounds);
    window.webContents.on("before-mouse-event", () => { this.inputRoute = "editor"; });
    window.webContents.on("before-input-event", () => { this.inputRoute = "editor"; });
    window.webContents.on("focus", () => { this.inputRoute = "editor"; });
    window.on("blur", () => { this.inputRoute = "unknown"; });
  }
  private createView(partition: string) {
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    view.setVisible(false);
    const wc = view.webContents;
    wc.on("before-mouse-event", (event) => {
      this.inputRoute = "browser";
      // Block user click/drag/wheel while Auto Scan owns the view.
      // sendInputEvent used by scroll() does not go through this hook.
      if (this.userInputLocked) event.preventDefault();
    });
    wc.on("before-input-event", (event, input) => {
      this.inputRoute = "browser";
      if (this.userInputLocked) {
        event.preventDefault();
        return;
      }
      if (
        (input.control || input.meta) &&
        ["+", "=", "-", "0"].includes(input.key)
      )
        event.preventDefault();
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void this.navigate(url).catch(() => {});
      return { action: "deny" };
    });
    wc.on("will-navigate", (event, url) => {
      if (!/^https?:\/\//.test(url)) event.preventDefault();
    });
    wc.on("did-finish-load", () => wc.setZoomFactor(this.zoom));
    void wc.setVisualZoomLevelLimits(1, 1);
    wc.session.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );
    // WebContentsView has no default context menu. Provide the standard
    // browser actions on this same webContents (no new browser/session).
    wc.on("context-menu", (_event, params) => this.showContextMenu(wc, params));
    return view;
  }
  private showContextMenu(wc: WebContents, params: Electron.ContextMenuParams) {
    if (wc.isDestroyed()) return;
    const spec = buildBrowserContextMenuSpec(params, {
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    });
    // Electron 44 clipboard.writeText is async — must await or the copy can be dropped.
    const run = async (id: string) => {
      if (wc.isDestroyed()) return;
      switch (id) {
        case "copy-link":
          // Exact linkURL from Chromium params; never saved to Collector.
          if (isCopyableLinkUrl(params.linkURL)) await clipboard.writeText(params.linkURL);
          return;
        case "copy": return wc.copy();
        case "cut": return wc.cut();
        case "paste": return wc.paste();
        case "select-all": return wc.selectAll();
        case "back": return wc.navigationHistory.goBack();
        case "forward": return wc.navigationHistory.goForward();
        case "reload": return wc.reload();
      }
    };
    const menu = Menu.buildFromTemplate(
      spec.map((item) =>
        item.type === "separator"
          ? { type: "separator" as const }
          : { label: item.label, enabled: item.enabled, click: () => { void run(item.id); } },
      ),
    );
    menu.popup({ window: this.window });
  }
  onViewCreated(listener: (contents: WebContents) => void) {
    this.viewListeners.add(listener);
    listener(this.view.webContents);
    return () => { this.viewListeners.delete(listener); };
  }
  async switchPartition(partition: string) {
    if (partition === this.partition) return;
    await this.flush(); // Abort replacement if the current persistent data cannot be flushed.
    const previous = this.view;
    const next = this.createView(partition);
    try { for (const listener of this.viewListeners) listener(next.webContents); }
    catch (error) { next.webContents.close(); throw error; }
    const index = this.window.contentView.children.indexOf(previous);
    next.setBounds(this.bounds);
    this.window.contentView.removeChildView(previous);
    try { this.window.contentView.addChildView(next, Math.max(0, index)); }
    catch (error) {
      this.window.contentView.addChildView(previous, Math.max(0, index));
      next.webContents.close();
      throw error;
    }
    this.currentView = next;
    this.partition = partition;
    this.inputRoute = "unknown";
    this.captures.clear();
    previous.webContents.close({ waitForBeforeUnload: false });
  }
  async navigate(url: string) {
    this.inputRoute = "unknown";
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol))
      throw new Error("Chỉ mở URL HTTP/HTTPS.");
    await this.view.webContents.loadURL(parsed.href);
    this.view.webContents.setZoomFactor(this.zoom);
  }
  setZoom(zoom: number) {
    this.zoom = validateZoom(zoom);
    this.view.webContents.setZoomFactor(this.zoom);
  }
  setVisible(visible: boolean) {
    // Auto Scan owns BrowserCore visibility until its input lock is released.
    // A delayed collector-host cleanup must not hide the native view mid-run.
    if (!visible && this.scanHoldVisible) return;
    this.visible = visible;
    this.view.setVisible(visible);
  }

  /**
   * Prime CDP + compositor after the view is hidden for Capture Mode.
   * With stayHidden capture, hidden surface stalls are avoided.
   */
  async prepareSurfaceCapture(): Promise<{ ok: boolean; attempts: number; error?: string }> {
    try {
      const img = await this.view.webContents.capturePage(undefined, { stayHidden: true });
      if (img.isEmpty()) throw new Error("Empty surface frame");
      return { ok: true, attempts: 1 };
    } catch (e) {
      return { ok: false, attempts: 1, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async capture(options?: {
    requireCanonical?: boolean;
    /** Skip evidence disk write + dataUrl (Collector extend path). */
    light?: boolean;
  }): Promise<Capture> {
    let release!: () => void;
    const prev = this.captureGate;
    this.captureGate = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await this.captureExclusive(options);
    } finally {
      release();
    }
  }

  private async captureExclusive(options?: {
    requireCanonical?: boolean;
    light?: boolean;
  }): Promise<Capture> {
    const requireCanonical = options?.requireCanonical !== false;
    const light = options?.light === true;
    const wc = this.view.webContents;
    const zoom = wc.getZoomFactor();
    if (Math.abs(zoom - this.zoom) > 0.001)
      throw new Error("Zoom đã thay đổi. Nạp lại môi trường trước khi test.");
    let raw: Buffer;
    const wasHidden = !this.visible;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (wasHidden) {
        // Temporarily wake WebContentsView visibility so Chromium compositor generates
        // the display surface frame for the scrolled content without stalling.
        this.view.setVisible(true);
      }
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
      await wc.debugger.sendCommand("Page.enable").catch(() => undefined);
      const frame = await Promise.race([
        wc.debugger.sendCommand("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error("Screenshot timeout: không có frame sau 4 giây."),
              ),
            4000,
          );
        }),
      ]);
      raw = Buffer.from(frame.data, "base64");
    } catch (e) {
      if (wc.debugger.isAttached()) wc.debugger.detach();
      try {
        const image = await wc.capturePage(undefined, { stayHidden: true });
        raw = image.toPNG();
      } catch {
        throw e;
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (wasHidden) {
        this.view.setVisible(false);
      }
    }
    if (!raw.length) throw new Error("Browser trả về ảnh rỗng.");
    const metadata = await sharp(raw).metadata();
    if (requireCanonical) assertCanonicalScreenshot(metadata.width, metadata.height);
    const buffer = raw;
    const id = randomUUID();
    if (!light) {
      await mkdir(this.evidenceDir, { recursive: true });
      await writeFile(path.join(this.evidenceDir, `${id}.png`), buffer);
    }
    this.captures.set(id, buffer);
    if (this.captures.size > 70)
      this.captures.delete(this.captures.keys().next().value!);
    const width = requireCanonical
      ? this.bounds.width
      : (metadata.width ?? this.bounds.width);
    const height = requireCanonical
      ? this.bounds.height
      : (metadata.height ?? this.bounds.height);
    return {
      id,
      width,
      height,
      zoom,
      url: wc.getURL(),
      timestamp: new Date().toISOString(),
      backend: "cdp-surface",
      dataUrl: light ? "" : `data:image/png;base64,${buffer.toString("base64")}`,
    };
  }
  captureBuffer(id: string) {
    const b = this.captures.get(id);
    if (!b) throw new Error("Ảnh đã hết hạn; chụp lại.");
    return b;
  }
  click(x: number, y: number) {
    if (!this.visible || !this.window.isVisible() || this.window.isMinimized())
      throw new Error("POC chỉ gửi input khi browser đang hiển thị.");
    const p = imageToInput(
      x,
      y,
      this.bounds.width,
      this.bounds.height,
      this.bounds,
    );
    this.view.webContents.focus();
    this.inputRoute = "browser";
    this.view.webContents.sendInputEvent({ type: "mouseMove", ...p });
    this.view.webContents.sendInputEvent({
      type: "mouseDown",
      ...p,
      button: "left",
      clickCount: 1,
    });
    this.view.webContents.sendInputEvent({
      type: "mouseUp",
      ...p,
      button: "left",
      clickCount: 1,
    });
  }
  inputFocus() {
    return {
      browser: this.view.webContents.isFocused(),
      editor:
        this.window.webContents.isFocused() ||
        this.editors.some((wc) => wc.isFocused()),
      route: this.inputRoute,
      caret: "unknown" as const,
    };
  }
  async uploadFiles(files: string[], click: () => void, timeoutMs = 8000) {
    return chooseUploadFiles(
      this.view.webContents.debugger,
      files,
      click,
      timeoutMs,
    );
  }
  private requireInputRoute() {
    const focus = this.inputFocus();
    if (
      !this.visible ||
      !this.window.isVisible() ||
      this.window.isMinimized() ||
      focus.editor ||
      (!focus.browser &&
        (focus.route !== "browser" || !this.window.isFocused()))
    )
      throw new InputNotReady(focus);
    return focus;
  }
  async typeOnly(text: string, method: "keyboard" | "clipboard" = "keyboard") {
    // Deliberately do not call focus(), click(), or any DOM/CDP focus helper.
    const focus = this.requireInputRoute();
    if (!text || text.length > 20000)
      throw new Error("Nội dung cần từ 1 đến 20.000 ký tự.");
    if (!["keyboard", "clipboard"].includes(method))
      throw new Error("Phương thức nhập không hợp lệ.");
    if (method === "clipboard") {
      const read = async () => {
        const items = await clipboard.read();
        return Promise.all(
          items.map(
            async (item) =>
              new ClipboardItem(
                Object.fromEntries(
                  await Promise.all(
                    item.types.map(async (type) => [
                      type,
                      await item.getType(type),
                    ]),
                  ),
                ),
              ),
          ),
        );
      };
      const fingerprint = async (items: ClipboardItem[]) => {
        const hash = createHash("sha256");
        for (const item of items)
          for (const type of [...item.types].sort()) {
            hash.update(type);
            const value = await item.getType(type);
            hash.update(
              value instanceof Blob
                ? Buffer.from(await value.arrayBuffer())
                : JSON.stringify(value),
            );
          }
        return hash.digest("hex");
      };
      const result = await pasteWithClipboard(
        {
          read,
          write: async (items) => {
            if (items.length) await clipboard.write(items);
            else clipboard.clear();
          },
          writeText: (value) => clipboard.writeText(value),
          fingerprint,
        },
        text,
        () => this.view.webContents.paste(),
        () => {
          this.requireInputRoute();
        },
      );
      return { method, focus, ...result };
    }
    // Dispatch native keyboard text to the current focus, not insertText's last editable.
    // Shift+Enter sends a native line break without submitting by plain Enter.
    const wc = this.view.webContents;
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      this.requireInputRoute();
      if (i) {
        this.view.webContents.sendInputEvent({
          type: "keyDown",
          keyCode: "Enter",
          modifiers: ["shift"],
        });
        this.view.webContents.sendInputEvent({
          type: "char",
          keyCode: "\r",
          modifiers: ["shift"],
        });
        this.view.webContents.sendInputEvent({
          type: "keyUp",
          keyCode: "Enter",
          modifiers: ["shift"],
        });
      }
      for (const character of lines[i]) {
        this.requireInputRoute();
        await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
          type: "char",
          text: character,
          unmodifiedText: character,
        });
      }
    }
    return { method, focus };
  }
  /**
   * Wheel at BrowserCore viewport center (or explicit DIP point inside the view).
   * Coordinates are relative to the WebContentsView, not the Windows desktop.
   * mouseMove first so Chromium routes the wheel to the element under the cursor
   * (required for Facebook nested scroll containers / post-detail modals).
   * Sign convention (verified by self-test): negative deltaY increases page scrollY (content moves up).
   */
  scroll(deltaY: number, point?: { x: number; y: number }, opts?: { requireFocus?: boolean }) {
    if (!Number.isFinite(deltaY) || Math.abs(deltaY) > 3000)
      throw new Error("Scroll cần trong khoảng -3000 đến 3000 DIP.");
    const requireFocus = opts?.requireFocus !== false;
    if (!this.visible || !this.window.isVisible())
      throw new Error("SCROLL: browser cần đang hiển thị.");
    if (requireFocus && !this.view.webContents.isFocused())
      throw new Error("SCROLL: browser cần đang hiển thị và có focus.");
    const bounds = this.view.getBounds();
    const x = point && Number.isFinite(point.x) ? Math.round(point.x) : Math.round(bounds.width / 2);
    const y = point && Number.isFinite(point.y) ? Math.round(point.y) : Math.round(bounds.height / 2);
    const p = { x, y };
    this.inputRoute = "browser";
    // Park pointer on the wheel target before wheel — same pattern as click().
    this.view.webContents.sendInputEvent({ type: "mouseMove", ...p });
    this.view.webContents.sendInputEvent({
      type: "mouseWheel",
      ...p,
      deltaY,
      deltaX: 0,
    });
  }
  async flush() {
    await this.view.webContents.session.cookies.flushStore();
    await this.view.webContents.session.flushStorageData();
  }
  close() {
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
  }
}
