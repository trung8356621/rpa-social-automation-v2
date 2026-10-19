import type { Debugger, Event } from "electron";
import type { UploadInfo } from "../shared/contracts.js";
import { UploadError } from "./upload-files.js";

// Only handles the chooser actually opened by this visual click. No DOM search.
export async function chooseUploadFiles(
  debuggerApi: Debugger,
  files: string[],
  click: () => void,
  timeoutMs = 8000,
): Promise<UploadInfo> {
  const info: UploadInfo = {
    transport: "cdp-file-chooser",
    fileCount: files.length,
    assignedCount: 0,
    phase: "waiting_chooser",
    preview: "unverified",
  };
  let active = true,
    handled = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (value: UploadInfo) => void, reject!: (error: Error) => void;
  const chosen = new Promise<UploadInfo>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Attach a rejection handler before setup; avoid an unhandled rejection on detach.
  void chosen.catch(() => {});
  const fail = (message: string) => reject(new UploadError(message, info));
  const listener = (
    _event: Event,
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
  ) => {
    if (!active || method !== "Page.fileChooserOpened") return;
    if (handled) {
      fail(
        "Có thêm file chooser trong cùng lần chạy; đã dừng, hãy kiểm tra preview trước khi thử lại.",
      );
      return;
    }
    handled = true;
    if (params.mode !== "selectSingle" && params.mode !== "selectMultiple") {
      fail("Loại file chooser chưa được hỗ trợ.");
      return;
    }
    info.chooserMode = params.mode;
    if (params.mode === "selectSingle" && files.length > 1) {
      fail(
        "Chooser chỉ nhận một file nhưng Step có nhiều ảnh. Không tự cắt bớt danh sách.",
      );
      return;
    }
    if (
      !Number.isInteger(params.backendNodeId) ||
      Number(params.backendNodeId) <= 0
    ) {
      fail(
        "Chooser không cung cấp backendNodeId; chưa hỗ trợ loại picker này.",
      );
      return;
    }
    info.phase = "assigning_files";
    void debuggerApi
      .sendCommand(
        "DOM.setFileInputFiles",
        { files, backendNodeId: params.backendNodeId },
        sessionId || undefined,
      )
      .then(
        () => {
          if (!active) return;
          info.phase = "files_selected";
          info.assignedCount = files.length;
          resolve(info);
        },
        (error) => fail(`Không chọn được file qua chooser: ${String(error)}`),
      );
  };
  const detached = () =>
    fail(
      "Debugger bị ngắt trong lúc chọn file; hãy kiểm tra browser trước khi thử lại.",
    );
  debuggerApi.on("message", listener);
  debuggerApi.on("detach", detached);
  try {
    if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
    await debuggerApi.sendCommand("Page.enable");
    await debuggerApi.sendCommand("Page.setInterceptFileChooserDialog", {
      enabled: true,
    });
    timer = setTimeout(
      () =>
        fail(
          "Không nhận được file chooser sau click. Có thể nút chỉ mở modal hoặc giao diện đã đổi; xem ảnh sau và Redesign/ thêm CLICK riêng.",
        ),
      timeoutMs,
    );
    click();
    return await chosen;
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError((error as Error).message, info);
  } finally {
    active = false;
    if (timer) clearTimeout(timer);
    debuggerApi.removeListener("message", listener);
    debuggerApi.removeListener("detach", detached);
    try {
      if (debuggerApi.isAttached())
        await debuggerApi.sendCommand("Page.setInterceptFileChooserDialog", {
          enabled: false,
        });
    } catch {
      info.cleanupWarning =
        "Không tắt được interception; dừng test và mở lại app trước khi tiếp tục.";
    }
  }
}
