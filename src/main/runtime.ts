import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Payload, Result } from "../shared/contracts.js";
import { BrowserCore } from "./browser-core.js";
import { Store } from "./storage.js";
import { localOcr, type OcrEngine } from "./ocr.js";
import { resolveVisualTarget, TargetNotConfident } from "./target-resolver.js";
export class Runtime {
  busy = false;
  private latestRuns = new Set<string>();
  constructor(
    readonly browser: BrowserCore,
    readonly store: Store,
    readonly assetDir: string,
    readonly runDir: string,
    readonly ocr: OcrEngine = localOcr,
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
    this.latestRuns.clear();
    try {
      const results: Result[] = [];
      for (const payload of override?.segment || [step.payload]) {
        const result = await this.execute(
          payload,
          stepId,
          version,
          override ? "override" : "base",
          overrideId,
        );
        results.push(result);
        this.latestRuns.add(result.id);
        if (!result.ok) break;
      }
      return results;
    } finally {
      this.busy = false;
    }
  }
  async review(
    runId: string,
    verdict: "correct" | "incorrect",
  ): Promise<Result> {
    if (this.busy) throw new Error("Đang test; đợi tác vụ kết thúc.");
    if (
      !["correct", "incorrect"].includes(verdict) ||
      !this.latestRuns.has(runId)
    )
      throw new Error("Chỉ xác nhận lần test mới nhất trong phiên hiện tại.");
    const row = this.store.db
      .prepare("SELECT payload FROM runs WHERE id=?")
      .get(runId) as { payload: string } | undefined;
    if (!row) throw new Error("Không tìm thấy lần test.");
    const result: Result = JSON.parse(row.payload);
    const flow = this.store.flow();
    if (
      result.action !== "CLICK_TARGET" ||
      result.status !== "ACTION_SENT" ||
      result.review ||
      !flow ||
      result.flowId !== flow.id ||
      !flow.steps.some(
        (s) => s.id === result.stepId && s.version === result.version,
      )
    )
      throw new Error(
        "Lần test không còn chờ xác nhận ở flow/version hiện tại; hãy test lại.",
      );
    result.review = { verdict, at: new Date().toISOString(), by: "user" };
    result.status = verdict === "correct" ? "VERIFIED" : "REJECTED";
    result.ok = verdict === "correct";
    result.message =
      verdict === "correct"
        ? "Người dùng đã quan sát browser và xác nhận kết quả đúng cho Step này."
        : "Người dùng xác nhận kết quả sai. Base được giữ nguyên; lưu Redesign để tạo version mới.";
    this.busy = true;
    try {
      await writeFile(
        path.join(this.runDir, `${result.id}.json`),
        JSON.stringify(result, null, 2),
      );
      this.store.db
        .prepare("UPDATE runs SET payload=? WHERE id=?")
        .run(JSON.stringify(result), runId);
      return result;
    } finally {
      this.busy = false;
    }
  }
  private async execute(
    payload: Payload,
    stepId: string,
    version: number,
    source: "base" | "override",
    overrideId?: string,
  ): Promise<Result> {
    // Screenshot capture can disturb native focus on this Electron/Windows build.
    // Focus-sensitive input runs first without a pre-capture or any refocus.
    const before = ["TYPE_ONLY", "SCROLL"].includes(payload.action)
      ? undefined
      : await this.browser.capture();
    let status: Result["status"] = "FAILED",
      message = "Input đã gửi; cần VERIFY riêng để xác nhận nghiệp vụ.",
      match: Result["match"];
    try {
      if (payload.action === "TYPE_ONLY") {
        await this.browser.typeOnly(payload.text!);
        status = "ACTION_SENT";
      } else if (payload.action === "SCROLL") {
        this.browser.scroll(payload.deltaY!);
        status = "ACTION_SENT";
      } else {
        const template = await readFile(
          path.join(this.assetDir, payload.target!.asset),
        );
        const deadline =
          Date.now() +
          (payload.action === "WAIT_VERIFY" ? (payload.timeoutMs ?? 3000) : 0);
        let current = before!;
        do {
          try {
            match = await resolveVisualTarget(
              this.browser.captureBuffer(current.id),
              template,
              payload,
              this.ocr,
            );
            break;
          } catch (error) {
            if (
              !(error instanceof TargetNotConfident) ||
              Date.now() >= deadline
            )
              throw error;
          }
          await new Promise((r) => setTimeout(r, 200));
          current = await this.browser.capture();
        } while (true);
        if (payload.action === "CLICK_TARGET") {
          this.browser.click(match.x, match.y);
          status = "ACTION_SENT";
        } else status = "VERIFIED";
        message =
          payload.action === "WAIT_VERIFY"
            ? `VERIFIED: điều kiện ${match.method === "ocr" ? `chữ “${match.text}”` : "ảnh"} đã khớp. Chỉ xác nhận điều kiện của step.`
            : `Click đã gửi tại ${match.x}, ${match.y}; chưa xác nhận kết quả nghiệp vụ.`;
      }
    } catch (e) {
      status = e instanceof TargetNotConfident ? "BLOCKED" : "FAILED";
      message = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 120));
    // Keep the live page/focus after click. Evidence capture is an explicit user action.
    const after =
      payload.action === "CLICK_TARGET"
        ? undefined
        : await this.browser.capture();
    const result: Result = {
      id: randomUUID(),
      ok: status === "ACTION_SENT" || status === "VERIFIED",
      status,
      action: payload.action,
      message,
      before,
      after,
      match,
      source,
      stepId,
      version,
      flowId: this.store.flow()!.id,
      overrideId,
      targetAsset: payload.target?.asset,
    };
    // Store paths/metadata in history, not duplicate base64 screenshots in SQLite.
    const metadata = {
      ...result,
      before: before ? { ...before, dataUrl: undefined } : undefined,
      after: after ? { ...after, dataUrl: undefined } : undefined,
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
