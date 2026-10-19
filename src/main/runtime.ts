import { resolvePayload } from "../shared/flow-model.js";
import { validatePayload } from "./storage.js";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Payload, Result } from "../shared/contracts.js";
import { BrowserCore, InputNotReady } from "./browser-core.js";
import { Store } from "./storage.js";
import { localOcr, type OcrEngine } from "./ocr.js";
import { resolveVisualTarget, TargetNotConfident } from "./target-resolver.js";
import { inspectUploadFiles, UploadError } from "./upload-files.js";
import { assertVisualEnvironment } from "../shared/visual-environment.js";
export class Runtime {
  busy = false;
  private latestRuns = new Set<string>();
  constructor(
    readonly browser: BrowserCore,
    readonly store: Store,
    readonly assetDir: string,
    readonly runDir: string,
    readonly ocr: OcrEngine = localOcr,
    readonly onClick?: (x: number, y: number) => void,
  ) {}
  async test(
    stepId: string,
    version: number,
    overrideId?: string,
  ): Promise<Result[]> {
    return this.testRequests([{ stepId, version, overrideId }]);
  }
  async testPair(
    firstId: string,
    secondId: string,
    delayMs: number,
  ): Promise<Result[]> {
    const flow = this.store.flow();
    const index = flow?.steps.findIndex((s) => s.id === firstId) ?? -1;
    if (
      !flow ||
      index < 0 ||
      flow.steps[index + 1]?.id !== secondId ||
      !Number.isInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > 10000
    )
      throw new Error(
        "Cần hai Step Base liên tiếp trong flow, delay 0–10000ms.",
      );
    const first = flow.steps[index],
      second = flow.steps[index + 1];
    if (
      this.store.step(first.id, first.version).payload.action !==
        "CLICK_TARGET" ||
      this.store.step(second.id, second.version).payload.action !== "TYPE_ONLY"
    )
      throw new Error("Cặp test chỉ hỗ trợ CLICK_TARGET → TYPE_ONLY đã lưu.");
    return this.testRequests(
      [
        { stepId: first.id, version: first.version },
        { stepId: second.id, version: second.version },
      ],
      delayMs,
    );
  }
  private async testRequests(
    requests: { stepId: string; version: number; overrideId?: string }[],
    delayMs = 0,
  ): Promise<Result[]> {
    if (this.busy) throw new Error("Đang có một tác vụ chạy.");
    const flow = this.store.flow();
    if (
      !flow ||
      requests.some((r) => !flow.steps.some((s) => s.id === r.stepId))
    )
      throw new Error("Step không thuộc flow.");
    if (flow.zoom !== this.browser.zoom)
      throw new Error("Zoom flow không khớp browser.");
    const plans = requests.map(({ stepId, version, overrideId }) => {
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
      return {
        stepId,
        version,
        overrideId,
        payloads: (override?.segment || [step.payload]).map((p) => {
          const resolved = resolvePayload(p, flow);
          validatePayload(resolved);
          return resolved;
        }),
        source: override ? ("override" as const) : ("base" as const),
      };
    });
    // Width changes reflow page content. Refuse the entire plan before any capture,
    // click, file chooser or input; legacy targets retain their original 1024 viewport.
    for (const plan of plans)
      for (const payload of plan.payloads)
        assertVisualEnvironment(payload, flow.zoom, {
          ...this.browser.bounds,
          zoom: this.browser.zoom,
        });
    this.busy = true;
    this.latestRuns.clear();
    try {
      const results: Result[] = [];
      for (let i = 0; i < plans.length; i++) {
        const { stepId, version, overrideId, payloads, source } = plans[i];
        if (i && delayMs) await new Promise((r) => setTimeout(r, delayMs));
        for (const payload of payloads) {
          const result = await this.execute(
            payload,
            stepId,
            version,
            source,
            overrideId,
          );
          results.push(result);
          this.latestRuns.add(result.id);
          if (!result.ok) return results;
        }
      }
      return results;
    } finally {
      this.busy = false;
    }
  }
  async review(
    runId: string,
    verdict: "correct" | "incorrect",
    previewConfirmed = false,
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
      !["CLICK_TARGET", "CLICK_AND_TYPE", "UPLOAD_FILE", "TYPE_ONLY"].includes(
        result.action,
      ) ||
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
    if (
      result.action === "UPLOAD_FILE" &&
      verdict === "correct" &&
      (previewConfirmed !== true || result.upload?.phase !== "files_selected")
    )
      throw new Error(
        "Cần quan sát đủ thumbnail/preview ảnh thật trước khi xác nhận UPLOAD_FILE; chọn file chưa phải upload thành công.",
      );
    result.review = { verdict, at: new Date().toISOString(), by: "user" };
    result.status = verdict === "correct" ? "VERIFIED" : "REJECTED";
    result.ok = verdict === "correct";
    if (result.upload && verdict === "correct")
      result.upload.preview = "confirmed_by_user";
    result.message =
      verdict === "correct"
        ? result.action === "UPLOAD_FILE"
          ? "Người dùng xác nhận đủ thumbnail/preview ảnh thật trong composer. Chưa Publish."
          : "Người dùng đã quan sát browser và xác nhận kết quả đúng cho Step này."
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
    if (payload.target?.ocr?.confirmed && payload.target.matchTo && payload.target.matchTo !== "current") {
      const fraction = { top: 0, middle: 0.5, bottom: 1 }[payload.target.matchTo];
      // Two passes allow one lazy-load expansion; no unbounded scrolling loop.
      for (let pass = 0; pass < 2; pass++) {
        await this.browser.view.webContents.executeJavaScript(`(async () => {
          const root = document.scrollingElement;
          const candidates = [...document.querySelectorAll('[role="dialog"], [role="dialog"] *')]
            .filter(el => el.clientHeight > 100 && el.scrollHeight > el.clientHeight &&
              el.getBoundingClientRect().bottom > 0 && el.getBoundingClientRect().top < innerHeight &&
              /auto|scroll/.test(getComputedStyle(el).overflowY));
          const el = candidates.sort((a,b) => b.clientHeight - a.clientHeight)[0] || root;
          if (el) {
            const end = Math.max(0, el.scrollHeight - el.clientHeight);
            el.scrollTo({ top: Math.max(0, end * ${fraction} + (${fraction} === 0 ? 80 : -80)), behavior: 'instant' });
            await new Promise(resolve => setTimeout(resolve, 80));
            el.scrollTo({ top: end * ${fraction}, behavior: 'instant' });
          }
        })()`);
        await new Promise(r => setTimeout(r, 350));
      }
    }
    const before = ["TYPE_ONLY", "SCROLL"].includes(payload.action)
      ? undefined
      : await this.browser.capture();
    let status: Result["status"] = "FAILED",
      message = "Input đã gửi; cần VERIFY riêng để xác nhận nghiệp vụ.",
      match: Result["match"],
      input: Result["input"];
    let resolution: Result["resolution"];
    let clickSent = false;
    let upload: Result["upload"] =
      payload.action === "UPLOAD_FILE"
        ? {
            transport: "cdp-file-chooser",
            fileCount: payload.files?.length ?? 0,
            assignedCount: 0,
            phase: "waiting_chooser",
            preview: "unverified",
          }
        : undefined;
    try {
      if (payload.action === "TYPE_ONLY") {
        input = await this.browser.typeOnly(payload.text!, payload.inputMethod);
        message = `Đã gửi ${input.method === "clipboard" ? "clipboard paste" : "native text + phím Shift+Enter"}; caret chưa được tự kiểm chứng. Quan sát chữ và xác nhận thủ công hoặc VERIFY riêng.${input.warning ? ` ${input.warning}` : ""}`;
        status = "ACTION_SENT";
      } else if (payload.action === "SCROLL") {
        this.browser.scroll(payload.deltaY!);
        status = "ACTION_SENT";
      } else {
        const files =
          payload.action === "UPLOAD_FILE"
            ? await inspectUploadFiles(payload.files)
            : undefined;
        const template = await readFile(
          path.join(this.assetDir, payload.target!.asset),
        );
        const deadline =
          Date.now() +
          (payload.action === "WAIT_VERIFY" ? (payload.timeoutMs ?? 3000) : 0);
        let current = before!;
        do {
          try {
            const resolved = await resolveVisualTarget(
              this.browser.captureBuffer(current.id),
              template,
              payload,
              this.ocr,
            );
            const { resolution: trace, ...position } = resolved;
            match = position;
            resolution = trace;
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
        if (payload.action === "UPLOAD_FILE") {
          upload = await this.browser.uploadFiles(files!, () => {
            this.browser.click(match!.x, match!.y);
            this.onClick?.(match!.x, match!.y);
            clickSent = true;
          });
          status = "ACTION_SENT";
        } else if (
          ["CLICK_TARGET", "CLICK_AND_TYPE"].includes(payload.action)
        ) {
          this.browser.click(match.x, match.y);
          this.onClick?.(match.x, match.y);
          clickSent = true;
          if (payload.action === "CLICK_AND_TYPE")
            input = await this.browser.typeOnly(
              payload.text!,
              payload.inputMethod,
            );
          status = "ACTION_SENT";
        } else status = "VERIFIED";
        message =
          payload.action === "UPLOAD_FILE"
            ? `Đã giao ${upload!.assignedCount} ảnh cho file chooser. Chưa xác nhận upload/preview thành công; đợi và quan sát đủ thumbnail ảnh thật, không Publish.`
            : payload.action === "WAIT_VERIFY"
              ? `VERIFIED: điều kiện ${match.method === "ocr" ? `chữ “${match.text}”` : "ảnh"} đã khớp. Chỉ xác nhận điều kiện của step.`
              : `Đã gửi click một lần${input ? " rồi gửi nội dung nhập" : ""}; chưa xác nhận kết quả nghiệp vụ.${input?.warning ? ` ${input.warning}` : ""}`;
      }
    } catch (e) {
      status =
        e instanceof TargetNotConfident ||
        e instanceof InputNotReady ||
        (e instanceof UploadError && !clickSent)
          ? "BLOCKED"
          : "FAILED";
      if (e instanceof InputNotReady)
        input = { method: payload.inputMethod ?? "keyboard", focus: e.focus };
      message =
        e instanceof TargetNotConfident
          ? "Target chưa đủ rõ hoặc vị trí nhận diện không thống nhất. Chưa gửi thao tác; hãy Redesign target. Chi tiết trong Debug."
          : (e as Error).message;
      if (e instanceof TargetNotConfident) resolution = e.resolution;
      if (e instanceof UploadError && e.upload) upload = e.upload;
      if (payload.action === "CLICK_AND_TYPE" && clickSent)
        message = `Đã click target một lần; nhập liệu chưa hoàn tất và có thể đã nhập một phần. ${message}`;
    }
    if (upload?.cleanupWarning) message += ` ${upload.cleanupWarning}`;
    await new Promise((r) => setTimeout(r, 120));
    // Keep the live page/focus after input. Evidence capture is an explicit user action.
    let after: Result["after"], evidenceWarning: string | undefined;
    if (payload.action === "UPLOAD_FILE") {
      await new Promise((r) => setTimeout(r, 750));
      try {
        after = await this.browser.capture();
      } catch (error) {
        evidenceWarning = `Không chụp được ảnh sau upload: ${(error as Error).message}`;
      }
    } else
      after = ["CLICK_TARGET", "CLICK_AND_TYPE", "TYPE_ONLY"].includes(
        payload.action,
      )
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
      input,
      source,
      stepId,
      version,
      flowId: this.store.flow()!.id,
      overrideId,
      targetAsset: payload.target?.asset,
      clickSent,
      resolution,
      upload,
      evidenceWarning,
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
