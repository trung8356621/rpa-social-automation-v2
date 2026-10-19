import { WebContentsView, type BrowserWindow } from "electron";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Capture, Rect } from "../shared/contracts.js";
import {
  WEB_WIDTH,
  WEB_HEIGHT,
  SIDE_WIDTH,
  TOP_HEIGHT,
  validateZoom,
  imageToInput,
} from "../shared/geometry.js";

export class BrowserCore {
  readonly view: WebContentsView;
  readonly bounds: Rect = {
    x: SIDE_WIDTH,
    y: TOP_HEIGHT,
    width: WEB_WIDTH,
    height: WEB_HEIGHT,
  };
  private captures = new Map<string, Buffer>();
  zoom = 1;
  visible = true;
  constructor(
    readonly window: BrowserWindow,
    readonly evidenceDir: string,
    partition: string,
  ) {
    this.view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    window.contentView.addChildView(this.view);
    this.view.setBounds(this.bounds);
    const wc = this.view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void this.navigate(url).catch(() => {});
      return { action: "deny" };
    });
    wc.on("will-navigate", (event, url) => {
      if (!/^https?:\/\//.test(url)) event.preventDefault();
    });
    wc.on("did-finish-load", () => wc.setZoomFactor(this.zoom));
    wc.on("before-input-event", (event, input) => {
      if (
        (input.control || input.meta) &&
        ["+", "=", "-", "0"].includes(input.key)
      )
        event.preventDefault();
    });
    void wc.setVisualZoomLevelLimits(1, 1);
    wc.session.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );
  }
  async navigate(url: string) {
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
    this.visible = visible;
    this.view.setVisible(visible);
  }
  async capture(): Promise<Capture> {
    const wc = this.view.webContents;
    const zoom = wc.getZoomFactor();
    if (Math.abs(zoom - this.zoom) > 0.001)
      throw new Error("Zoom đã thay đổi. Nạp lại môi trường trước khi test.");
    let raw: Buffer;
    {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
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
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (!raw.length) throw new Error("Browser trả về ảnh rỗng.");
    // Normalize physical PNG pixels to view DIPs; crop and input share this space.
    const buffer = await sharp(raw)
      .resize(this.bounds.width, this.bounds.height, { fit: "fill" })
      .png()
      .toBuffer();
    const id = randomUUID();
    await mkdir(this.evidenceDir, { recursive: true });
    await writeFile(path.join(this.evidenceDir, `${id}.png`), buffer);
    this.captures.set(id, buffer);
    if (this.captures.size > 12)
      this.captures.delete(this.captures.keys().next().value!);
    return {
      id,
      width: this.bounds.width,
      height: this.bounds.height,
      zoom,
      url: wc.getURL(),
      timestamp: new Date().toISOString(),
      backend: "cdp-surface",
      dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
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
  async typeOnly(text: string) {
    // Deliberately do not call focus(), click(), or any DOM/CDP focus helper.
    if (
      !this.visible ||
      !this.window.isVisible() ||
      this.window.isMinimized() ||
      !this.view.webContents.isFocused()
    )
      throw new Error(
        "TYPE_ONLY: browser chưa có focus. Click thủ công vào ô nhập rồi dùng phím tắt test.",
      );
    if (!text || text.length > 20000)
      throw new Error("Nội dung cần từ 1 đến 20.000 ký tự.");
    for (const char of text) {
      this.view.webContents.sendInputEvent({
        type: "char",
        keyCode: char === "\n" ? "\r" : char,
      });
    }
  }
  scroll(deltaY: number) {
    if (!Number.isFinite(deltaY) || Math.abs(deltaY) > 3000)
      throw new Error("Scroll cần trong khoảng -3000 đến 3000 DIP.");
    if (
      !this.visible ||
      !this.window.isVisible() ||
      !this.view.webContents.isFocused()
    )
      throw new Error("SCROLL: browser cần đang hiển thị và có focus.");
    this.view.webContents.sendInputEvent({
      type: "mouseWheel",
      x: 512,
      y: 320,
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
