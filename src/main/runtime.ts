import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Payload, Result } from "../shared/contracts.js";
import { BrowserCore } from "./browser-core.js";
import { Store } from "./storage.js";
import { matchTemplate } from "./visual.js";
export class Runtime {
  busy = false;
  constructor(
    readonly browser: BrowserCore,
    readonly store: Store,
    readonly assetDir: string,
    readonly runDir: string,
  ) {}
  async test(
    stepId: string,
    version: number,
    overrideId?: string,
  ): Promise<Result[]> {
    if (this.busy) throw new Error("Đang có một tác vụ chạy.");
    const flow = this.store.flow();
    if (!flow || !flow.steps.some((s) => s.id === stepId))
      throw new Error("Step không thuộc flow.");
    if (flow.zoom !== this.browser.zoom)
      throw new Error("Zoom flow không khớp browser.");
    const step = this.store.step(stepId, version);
    const override = overrideId
      ? this.store.overrides().find((o) => o.id === overrideId)
      : undefined;
    if (
      overrideId &&
      (!override ||
        override.stepId !== stepId ||
        override.baseVersion !== version)
    )
      throw new Error(
        "Override khác Base version; cần test lại/tạo override mới.",
      );
    this.busy = true;
    try {
      const results: Result[] = [];
      for (const payload of override?.segment || [step.payload]) {
        const result = await this.execute(
          payload,
          stepId,
          version,
          override ? "override" : "base",
        );
        results.push(result);
        if (!result.ok) break;
      }
      return results;
    } finally {
      this.busy = false;
    }
  }
  private async execute(
    payload: Payload,
    stepId: string,
    version: number,
    source: "base" | "override",
  ): Promise<Result> {
    // Screenshot capture can disturb native focus on this Electron/Windows build.
    // Focus-sensitive input runs first without a pre-capture or any refocus.
    const before = ["TYPE_ONLY", "SCROLL"].includes(payload.action)
      ? undefined
      : await this.browser.capture();
    let ok = true,
      message = "Input đã gửi; cần VERIFY riêng để xác nhận nghiệp vụ.",
      match: Result["match"];
    try {
      if (payload.action === "TYPE_ONLY")
        await this.browser.typeOnly(payload.text!);
      else if (payload.action === "SCROLL")
        this.browser.scroll(payload.deltaY!);
      else {
        const template = await readFile(
          path.join(this.assetDir, payload.target!.asset),
        );
        const deadline =
          Date.now() +
          (payload.action === "WAIT_VERIFY" ? (payload.timeoutMs ?? 3000) : 0);
        let current = before!;
        do {
          match = await matchTemplate(
            this.browser.captureBuffer(current.id),
            template,
            payload.target!.roi,
          );
          if (match.score >= (payload.threshold ?? 0.96)) break;
          if (Date.now() >= deadline)
            throw new Error(
              `Không khớp target: score ${match.score.toFixed(4)}.`,
            );
          await new Promise((r) => setTimeout(r, 200));
          current = await this.browser.capture();
        } while (true);
        if (payload.action === "CLICK_TARGET")
          this.browser.click(match.x, match.y);
        message =
          payload.action === "WAIT_VERIFY"
            ? `VERIFY khớp ảnh: ${match.score.toFixed(4)}.`
            : `Click đã gửi tại ${match.x}, ${match.y}; chưa xác nhận kết quả nghiệp vụ.`;
      }
    } catch (e) {
      ok = false;
      message = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 120));
    const after = await this.browser.capture();
    const result: Result = {
      id: randomUUID(),
      ok,
      action: payload.action,
      message,
      before,
      after,
      match,
      source,
      stepId,
      version,
    };
    // Store paths/metadata in history, not duplicate base64 screenshots in SQLite.
    const metadata = {
      ...result,
      before: before ? { ...before, dataUrl: undefined } : undefined,
      after: { ...after, dataUrl: undefined },
    };
    this.store.db
      .prepare("INSERT INTO runs VALUES(?,?)")
      .run(result.id, JSON.stringify(metadata));
    await writeFile(
      path.join(this.runDir, `${result.id}.json`),
      JSON.stringify(metadata, null, 2),
    );
    return result;
  }
}
