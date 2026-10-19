import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Action,
  Capture,
  Command,
  CreatorApi,
  Payload,
  Rect,
  Result,
  OcrResult,
  OcrSegment,
  State,
  Step,
} from "../shared/contracts";
import "./style.css";
import { WEB_HEIGHT } from "../shared/geometry";
document.documentElement.style.setProperty("--web-height", `${WEB_HEIGHT}px`);
declare global {
  interface Window {
    creator: CreatorApi;
  }
}

function Creator() {
  const [state, setState] = useState<State>();
  const [url, setUrl] = useState("https://www.facebook.com/");
  const [action, setAction] = useState<Action>("CLICK_TARGET");
  const [name, setName] = useState("");
  const [text, setText] = useState(
    "Nội dung bản nháp kiểm thử — không xuất bản.",
  );
  const [delta, setDelta] = useState(-400);
  const [inputMethod, setInputMethod] = useState<"keyboard" | "clipboard">(
    "keyboard",
  );
  const [pairDelay, setPairDelay] = useState(800);
  const [target, setTarget] = useState<Payload["target"]>();
  const [targetImage, setTargetImage] = useState("");
  const [method, setMethod] = useState<"image" | "ocr">("image");
  const [ocrResult, setOcrResult] = useState<OcrResult>();
  const [ocrError, setOcrError] = useState("");
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrKind, setOcrKind] = useState<"line" | "word">("line");
  const [selected, setSelected] = useState<Step>();
  const [overrideId, setOverrideId] = useState("");
  const [shot, setShot] = useState<Capture>();
  const [cropMode, setCropMode] = useState(false);
  const [roi, setRoi] = useState<Rect>();
  const [message, setMessage] = useState(
    "Tạo flow, chọn Action rồi crop target nếu cần.",
  );
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [flowName, setFlowName] = useState("Facebook draft POC");
  const [context, setContext] = useState("Ngữ cảnh sửa lỗi");
  const drag = useRef<{ x: number; y: number } | undefined>(undefined);
  const flowInput = useRef<HTMLInputElement>(null);
  const resultPanel = useRef<HTMLDivElement>(null);
  const latest = useRef({ selected, overrideId, busy });
  latest.current = { selected, overrideId, busy };
  useEffect(() => {
    if (results.length)
      resultPanel.current?.scrollIntoView({ block: "nearest" });
  }, [results]);

  function newStep() {
    setSelected(undefined);
    setTarget(undefined);
    setTargetImage("");
    setMethod("image");
    setOcrResult(undefined);
    setOcrError("");
    setName("");
    setOverrideId("");
    setResults([]);
    setAction("CLICK_TARGET");
    setInputMethod("keyboard");
    setMessage(
      "Chọn Action cho Step tiếp theo từ trạng thái browser hiện tại. Không chạy lại flow.",
    );
    requestAnimationFrame(() =>
      document
        .querySelector('[aria-label="Action"]')
        ?.scrollIntoView({ block: "center" }),
    );
  }
  async function reviewClick(result: Result, verdict: "correct" | "incorrect") {
    if (shot) await closeShot();
    const reviewed = await invoke<Result>({
      type: "reviewTest",
      runId: result.id,
      verdict,
    });
    setResults((previous) =>
      previous.map((r) =>
        r.id === reviewed.id
          ? { ...r, ...reviewed, before: r.before, after: r.after }
          : r,
      ),
    );
    if (verdict === "incorrect") {
      const base = state!.steps.find(
        (s) => s.id === result.stepId && s.version === result.version,
      )!;
      const overlay = state!.overrides.find((o) => o.id === result.overrideId);
      await loadStep({ ...base, payload: overlay?.segment[0] ?? base.payload });
      setMessage(
        `Redesign ${base.name} / v${base.version}. Base giữ nguyên; chỉ tạo version mới khi lưu. Browser vẫn ở trạng thái sau click.`,
      );
      document
        .querySelector('[aria-label="Action"]')
        ?.scrollIntoView({ block: "center" });
    } else
      setMessage(
        "Đã VERIFIED bằng xác nhận của bạn. Có thể tạo Step tiếp theo từ browser hiện tại.",
      );
  }

  async function invoke<T>(command: Command): Promise<T> {
    return window.creator.invoke(command) as Promise<T>;
  }
  async function task(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void invoke<State>({ type: "state" })
      .then(setState)
      .catch((e) => setMessage(String(e)));
    return window.creator.onTest((result) => {
      if (Array.isArray(result)) {
        setResults(result);
        setMessage(result.map((r) => r.message).join("\n"));
      } else {
        setResults([]);
        setMessage(result.error);
      }
    });
  }, []);
  useEffect(() => {
    if (selected)
      void invoke({
        type: "armTest",
        stepId: selected.id,
        version: selected.version,
        overrideId: overrideId || undefined,
      }).catch((e) => setMessage(String(e)));
    else
      void invoke({ type: "disarmTest" }).catch((e) => setMessage(String(e)));
  }, [selected, overrideId]);
  useEffect(() => {
    if (!shot) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        void task(closeShot);
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [shot, busy]);
  async function loadStep(step: Step) {
    setSelected(step);
    setName(step.name);
    setAction(step.payload.action);
    setText(step.payload.text || "");
    setInputMethod(step.payload.inputMethod ?? "keyboard");
    setDelta(step.payload.deltaY ?? -400);
    setTarget(step.payload.target);
    setMethod(step.payload.method ?? "image");
    setOcrResult(undefined);
    setOcrError("");
    setOverrideId("");
    setTargetImage(
      step.payload.target
        ? await invoke<string>({
            type: "targetImage",
            asset: step.payload.target.asset,
          })
        : "",
    );
  }
  function payload(): Payload {
    return {
      action,
      ...(action === "TYPE_ONLY" ? { text, inputMethod } : {}),
      ...(action === "SCROLL" ? { deltaY: delta } : {}),
      ...(["CLICK_TARGET", "WAIT_VERIFY"].includes(action)
        ? { target, method, threshold: 0.96, timeoutMs: 3000 }
        : {}),
    };
  }
  async function run(step: Step, overlay: string, fromBrowser = false) {
    // Disabling a previously focused editor button can pull focus away from the
    // native browser view. The browser shortcut must not mutate UI before input.
    latest.current.busy = true;
    if (!fromBrowser) {
      setBusy(true);
      setResults([]);
    }
    try {
      const r = await invoke<Result[]>({
        type: "test",
        stepId: step.id,
        version: step.version,
        overrideId: overlay || undefined,
      });
      setResults(r);
      setMessage(r.map((r) => r.message).join("\n"));
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function closeShot() {
    await invoke({ type: "browserVisible", visible: true });
    drag.current = undefined;
    setShot(undefined);
    setCropMode(false);
    setRoi(undefined);
  }
  async function capture() {
    if (!state?.flow) {
      setMessage("Tạo hoặc chọn flow ở Bước 1 trước khi chụp ROI.");
      return;
    }
    const image = await invoke<Capture>({ type: "capture" });
    await invoke({ type: "browserVisible", visible: false });
    setShot(image);
    setRoi(undefined);
    setCropMode(true);
    setMessage(
      `Kéo ROI trên ảnh 1024×${WEB_HEIGHT} DIP. Browser vẫn giữ nguyên kích thước.`,
    );
  }
  async function inspect(image: Capture) {
    await invoke({ type: "browserVisible", visible: false });
    setShot(image);
    setCropMode(false);
  }
  async function saveCrop() {
    if (!shot || !roi) return;
    const t = await invoke<{ asset: string; roi: Rect; dataUrl: string }>({
      type: "crop",
      captureId: shot.id,
      roi,
    });
    setTarget({ asset: t.asset, roi: t.roi });
    setMethod("image");
    setOcrResult(undefined);
    setOcrError("");
    setTargetImage(t.dataUrl);
    await closeShot();
    await readOcr(t.asset);
    setMessage(
      "ROI đã lưu. Chọn và xác nhận một dòng/từ OCR, hoặc giữ image-only; sau đó lưu Base/Override.",
    );
  }
  async function readOcr(asset: string) {
    setOcrLoading(true);
    setOcrError("");
    setOcrResult(undefined);
    try {
      setOcrResult(await invoke<OcrResult>({ type: "ocrTarget", asset }));
    } catch (error) {
      setOcrError(
        `OCR thất bại: ${(error as Error).message}. Vẫn có thể lưu target chỉ dùng ảnh.`,
      );
    } finally {
      setOcrLoading(false);
    }
  }
  function confirmOcr(segment: OcrSegment) {
    setTarget((previous) =>
      previous
        ? {
            ...previous,
            ocr: {
              text: segment.text,
              bbox: segment.bbox,
              confidence: segment.confidence,
              kind: segment.kind,
              language: "vie+eng",
              confirmed: true,
            },
          }
        : previous,
    );
    setMessage(
      `Đã xác nhận chữ “${segment.text}”. Chọn phương thức OCR nếu muốn test bằng chữ; lưu để áp dụng.`,
    );
  }
  function goToFlow() {
    flowInput.current?.scrollIntoView({ block: "center" });
    flowInput.current?.focus();
    setMessage("Bước 1: nhập tên và bấm Tạo flow, hoặc chọn một flow đã lưu.");
  }
  function point(e: React.PointerEvent) {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1024, e.clientX - r.left)),
      y: Math.max(0, Math.min(WEB_HEIGHT, e.clientY - r.top)),
    };
  }
  const needsTarget = ["CLICK_TARGET", "WAIT_VERIFY"].includes(action);
  const selectedIndex =
    state?.flow?.steps.findIndex((s) => s.id === selected?.id) ?? -1;
  const previousRef =
    selectedIndex > 0 ? state?.flow?.steps[selectedIndex - 1] : undefined;
  const previousClick = previousRef
    ? state?.steps.find(
        (s) =>
          s.id === previousRef.id &&
          s.version === previousRef.version &&
          s.payload.action === "CLICK_TARGET",
      )
    : undefined;
  const locked = busy || !!shot;
  const field = (label: string, child: React.ReactNode) => (
    <label>
      {label}
      {child}
    </label>
  );
  return (
    <main>
      <header>
        <div className="brand">
          ◈ <b>RPA Creator</b>
          <span>V2 / POC</span>
        </div>
        <div className="environment">
          ONE SESSION <i />
          1024 × {WEB_HEIGHT} DIP · {Math.round((state?.zoom || 1) * 100)}% zoom
        </div>
        <button
          className="window-mode"
          onClick={() =>
            void invoke({ type: "toggleFullscreen" }).catch((e) =>
              setMessage(String(e)),
            )
          }
        >
          Toàn màn hình · F11
        </button>
      </header>
      <nav>
        {shot ? (
          <>
            <span className="capture-instructions" role="note">
              {cropMode
                ? "Kéo để chọn ROI trên ảnh. Esc để hủy."
                : "Đang xem ảnh kiểm thử. Esc để quay lại."}
            </span>
            {cropMode && (
              <button
                className="primary"
                disabled={!roi || roi.width < 4 || roi.height < 4 || busy}
                onClick={() => void task(saveCrop)}
              >
                Dùng ROI {roi ? `${roi.width}×${roi.height}` : ""}
              </button>
            )}
            <button disabled={busy} onClick={() => void task(closeShot)}>
              Quay lại browser · Esc
            </button>
          </>
        ) : (
          <>
            <input
              aria-label="URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button
              disabled={locked}
              onClick={() =>
                void task(async () =>
                  setState(await invoke<State>({ type: "navigate", url })),
                )
              }
            >
              Mở URL
            </button>
            <button
              disabled={locked}
              onClick={() =>
                void task(async () =>
                  setState(await invoke<State>({ type: "fixture" })),
                )
              }
            >
              Trang kiểm chuẩn
            </button>
            <label>
              Zoom
              <select
                aria-label="Zoom"
                disabled={locked || !!state?.flow?.steps.length}
                value={state?.zoom || 1}
                onChange={(e) =>
                  void task(async () =>
                    setState(
                      await invoke<State>({
                        type: "environment",
                        zoom: Number(e.target.value),
                      }),
                    ),
                  )
                }
              >
                <option value="1">100%</option>
                <option value="0.9">90%</option>
                <option value="0.8">80%</option>
              </select>
            </label>
          </>
        )}
      </nav>
      <aside>
        <div className="eyebrow">01 / FLOW</div>
        <p className="flow-guide">
          Bước 1: tạo hoặc chọn flow. Sau đó chọn Action, crop target và lưu
          step.
        </p>
        <select
          aria-label="Flow đã lưu"
          disabled={locked}
          value={state?.flow?.id || ""}
          onChange={(e) =>
            void task(async () => {
              setState(
                await invoke<State>({ type: "openFlow", id: e.target.value }),
              );
              setSelected(undefined);
              setTarget(undefined);
              setTargetImage("");
              setMethod("image");
              setOcrResult(undefined);
              setOcrError("");
              setResults([]);
            })
          }
        >
          <option value="" disabled>
            Chọn flow đã lưu
          </option>
          {state?.flows.map((f) => (
            <option value={f.id} key={f.id}>
              {f.name} · {Math.round(f.zoom * 100)}%
            </option>
          ))}
        </select>
        <div className="row">
          <input
            ref={flowInput}
            aria-label="Tên flow mới"
            value={flowName}
            onChange={(e) => setFlowName(e.target.value)}
          />
          <button
            disabled={locked}
            onClick={() =>
              void task(async () => {
                setState(
                  await invoke<State>({ type: "newFlow", name: flowName }),
                );
                setSelected(undefined);
                setTarget(undefined);
                setTargetImage("");
                setMethod("image");
                setOcrResult(undefined);
                setOcrError("");
                setResults([]);
                setMessage(
                  `Đã tạo flow “${flowName}”. Có thể chụp & crop ROI; chọn zoom trước khi lưu step đầu tiên.`,
                );
              })
            }
          >
            Tạo flow
          </button>
        </div>
        {state?.flow && (
          <p className="flow-active" aria-live="polite">
            Flow đang chọn: <b>{state.flow.name}</b>
          </p>
        )}
        <div className="steps">
          {state?.flow?.steps.map((ref, i) => {
            const s = state.steps.find(
              (s) => s.id === ref.id && s.version === ref.version,
            )!;
            return (
              <button
                className={selected?.id === s.id ? "step active" : "step"}
                key={s.id}
                disabled={locked}
                onClick={() => void task(() => loadStep(s))}
              >
                <span>{String(i + 1).padStart(2, "0")}</span>
                <b>{s.name}</b>
                <small>v{s.version}</small>
              </button>
            );
          })}
        </div>
        <div className="row">
          <div className="eyebrow">02 / ACTION-FIRST</div>
          <button className="link" disabled={locked} onClick={newStep}>
            + Step mới
          </button>
        </div>
        {field(
          "Action",
          <select
            aria-label="Action"
            disabled={locked}
            value={action}
            onChange={(e) => {
              setAction(e.target.value as Action);
              setTarget(undefined);
              setTargetImage("");
              setMethod("image");
              setOcrResult(undefined);
              setOcrError("");
            }}
          >
            <option>CLICK_TARGET</option>
            <option>TYPE_ONLY</option>
            <option value="WAIT_VERIFY">WAIT / VERIFY</option>
            <option>SCROLL</option>
          </select>,
        )}
        {field(
          "Tên step",
          <input
            aria-label="Tên step"
            disabled={locked}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />,
        )}
        {action === "TYPE_ONLY" && (
          <>
            <label>
              Phương thức nhập
              <select
                aria-label="Phương thức nhập"
                disabled={locked}
                value={inputMethod}
                onChange={(e) =>
                  setInputMethod(e.target.value as "keyboard" | "clipboard")
                }
              >
                <option value="keyboard">
                  Keyboard · native text + Shift+Enter
                </option>
                <option value="clipboard">
                  Clipboard paste · phục hồi clipboard
                </option>
              </select>
            </label>
            <textarea
              aria-label="Nội dung TYPE_ONLY"
              disabled={locked}
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <p className="hint">
              Gửi vào caret hiện tại; không tự click/focus. Native browser focus
              không chứng minh caret sẵn sàng. Lưu → test cặp CLICK → TYPE bên
              dưới, hoặc click thủ công ô nhập rồi Ctrl+Shift+T. Clipboard chỉ
              phục hồi khi chưa bị thay đổi trong lúc paste.
            </p>
          </>
        )}
        {action === "SCROLL" &&
          field(
            "Delta Y (âm = xuống)",
            <input
              aria-label="Scroll delta"
              disabled={locked}
              type="number"
              value={delta}
              onChange={(e) => setDelta(Number(e.target.value))}
            />,
          )}
        {needsTarget && (
          <>
            <button
              disabled={locked || !state?.flow}
              aria-describedby="roi-flow-help"
              onClick={() => void task(capture)}
            >
              Chụp & crop ROI
            </button>
            <p id="roi-flow-help" className="hint">
              {!state?.flow
                ? "Chưa có flow: nhập tên và bấm Tạo flow ở Bước 1, hoặc chọn flow đã lưu để bật chụp ROI."
                : "Chụp trang web hiện tại và kéo ROI; Dùng ROI để xác nhận hoặc Esc để hủy."}
            </p>
            {!state?.flow && (
              <button className="link" disabled={locked} onClick={goToFlow}>
                Đi tới bước 1
              </button>
            )}
            {targetImage && (
              <img alt="Target ROI" className="target" src={targetImage} />
            )}
            <p className="hint">
              {target
                ? `${target.roi.width}×${target.roi.height} · x${target.roi.x}, y${target.roi.y}`
                : "Chưa có target. Crop nhãn/icon cùng biên."}{" "}
              Tìm trong vùng ROI ±64 DIP bằng ảnh hoặc chữ đã xác nhận.
            </p>
          </>
        )}
        {needsTarget && target && (
          <section className="ocr-panel" aria-label="OCR ROI">
            <div className="eyebrow">OCR LOCAL · VIỆT + ANH</div>
            {ocrLoading && <p role="note">Đang đọc OCR trên máy…</p>}
            {ocrError && (
              <p role="note" className="hint">
                {ocrError}
              </p>
            )}
            {ocrResult && !ocrResult.segments.length && (
              <p className="hint">
                ROI không có chữ đọc được. Có thể lưu image-only cho nút icon.
              </p>
            )}
            {ocrResult && ocrResult.segments.length > 0 && (
              <>
                <p className="hint">
                  {target.ocr
                    ? "Bấm dòng/từ khác để đổi chữ đã xác nhận."
                    : "Không tự chọn chữ. Bấm một dòng/từ bên dưới để xác nhận target."}
                </p>
                <label>
                  Đơn vị chọn
                  <select
                    aria-label="Đơn vị OCR"
                    value={ocrKind}
                    disabled={locked}
                    onChange={(e) =>
                      setOcrKind(e.target.value as "line" | "word")
                    }
                  >
                    <option value="line">Dòng chữ</option>
                    <option value="word">Từ riêng lẻ</option>
                  </select>
                </label>
                <div className="ocr-candidates">
                  {ocrResult.segments
                    .filter((s) => s.kind === ocrKind)
                    .map((s) => (
                      <button
                        key={s.id}
                        className="ocr-candidate"
                        disabled={locked}
                        aria-pressed={
                          target.ocr?.text === s.text &&
                          target.ocr.kind === s.kind &&
                          target.ocr.bbox.x === s.bbox.x &&
                          target.ocr.bbox.y === s.bbox.y
                        }
                        onClick={() => confirmOcr(s)}
                      >
                        <b>{s.text}</b>
                        <small>
                          {s.confidence.toFixed(1)}% · bbox {s.bbox.x},
                          {s.bbox.y} · {s.bbox.width}×{s.bbox.height}
                        </small>
                      </button>
                    ))}
                </div>
              </>
            )}
            {target.ocr ? (
              <div className="ocr-confirmed">
                <b>Chữ đã xác nhận: {target.ocr.text}</b>
                <p className="hint">
                  {target.ocr.kind} · {target.ocr.confidence.toFixed(1)}% khi
                  thiết kế. Runtime đọc lại và cần confidence ≥80%, chỉ một vị
                  trí khớp chính xác.
                </p>
                <button
                  disabled={locked}
                  onClick={() => {
                    setTarget((previous) => {
                      if (!previous) return previous;
                      const { ocr, ...rest } = previous;
                      return rest;
                    });
                    setMethod("image");
                  }}
                >
                  Bỏ chữ, dùng image-only
                </button>
              </div>
            ) : (
              <p className="hint">Image-only: chưa có chữ được bạn xác nhận.</p>
            )}
            <button
              disabled={locked}
              onClick={() => void task(() => readOcr(target.asset))}
            >
              Đọc lại OCR
            </button>
            <label>
              Phương thức nhận diện
              <select
                aria-label="Phương thức nhận diện"
                disabled={locked}
                value={method}
                onChange={(e) => setMethod(e.target.value as "image" | "ocr")}
              >
                <option value="image">Image matching</option>
                <option value="ocr" disabled={!target.ocr}>
                  OCR text matching
                </option>
              </select>
            </label>
            <p className="hint">
              OCR chỉ dùng chữ bạn chọn; không fallback sang ảnh khi không chắc
              chắn.
            </p>
          </section>
        )}
        <button
          className="primary"
          disabled={locked || !state?.flow || (needsTarget && !target)}
          onClick={() =>
            void task(async () => {
              const next = await invoke<State>({
                type: "saveStep",
                id: selected?.id,
                name,
                payload: payload(),
              });
              setState(next);
              const ref = selected
                ? next.flow!.steps.find((s) => s.id === selected.id)!
                : next.flow!.steps.at(-1)!;
              await loadStep(
                next.steps.find(
                  (s) => s.id === ref.id && s.version === ref.version,
                )!,
              );
              setMessage(
                `Đã lưu Base v${ref.version}; version cũ vẫn được giữ.`,
              );
            })
          }
        >
          {selected
            ? `Lưu redesign → v${Math.max(...(state?.steps.filter((s) => s.id === selected.id).map((s) => s.version) || [1])) + 1}`
            : "Lưu Base v1"}
        </button>
        {selected && (
          <>
            <div className="row">
              {field(
                "Base version",
                <select
                  aria-label="Base version"
                  disabled={locked}
                  value={selected.version}
                  onChange={(e) =>
                    void task(() =>
                      loadStep(
                        state!.steps.find(
                          (s) =>
                            s.id === selected.id &&
                            s.version === Number(e.target.value),
                        )!,
                      ),
                    )
                  }
                >
                  {state?.steps
                    .filter((s) => s.id === selected.id)
                    .map((s) => (
                      <option key={s.version} value={s.version}>
                        v{s.version}
                      </option>
                    ))}
                </select>,
              )}
              <button
                disabled={locked}
                onClick={() =>
                  void task(async () => {
                    setState(
                      await invoke<State>({
                        type: "selectVersion",
                        id: selected.id,
                        version: selected.version,
                      }),
                    );
                    setMessage(`Flow ghim Base v${selected.version}.`);
                  })
                }
              >
                Ghim version
              </button>
            </div>
            <div className="eyebrow">03 / TEST & DEBUG</div>
            {field(
              "Implementation",
              <select
                aria-label="Implementation"
                disabled={locked}
                value={overrideId}
                onChange={(e) => setOverrideId(e.target.value)}
              >
                <option value="">Base v{selected.version}</option>
                {state?.overrides
                  .filter(
                    (o) =>
                      o.stepId === selected.id &&
                      o.baseVersion === selected.version,
                  )
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      Override · {o.name}
                    </option>
                  ))}
              </select>,
            )}
            <button
              disabled={locked}
              onClick={() => void run(selected, overrideId)}
            >
              Test step đã lưu · Ctrl+Shift+T
            </button>
            <p className="hint">
              Test dùng payload đã lưu. TYPE_ONLY/SCROLL: giữ focus trong web và
              dùng phím tắt.
            </p>
            {["CLICK_TARGET", "WAIT_VERIFY"].includes(
              selected.payload.action,
            ) && (
              <p className="hint saved-method">
                Phương thức đã lưu:{" "}
                {(
                  state?.overrides.find((o) => o.id === overrideId)
                    ?.segment[0] ?? selected.payload
                ).method === "ocr"
                  ? "OCR text matching"
                  : "Image Matching"}
                . Thay đổi form cần lưu trước khi Test.
              </p>
            )}
            {selected.payload.action === "TYPE_ONLY" && (
              <section aria-label="Test hai Step" className="flow-guide">
                <b>Test CLICK → TYPE liền nhau</b>
                <p>
                  Chạy Base đã lưu của Step CLICK ngay trước và Step TYPE này;
                  không về sidebar hoặc chụp ảnh giữa hai Step. CLICK phải mở
                  composer và đặt caret; nếu chỉ mở hộp thoại, hãy tạo CLICK
                  riêng vào ô nhập trước TYPE. Kết quả vẫn cần xác nhận.
                </p>
                <label>
                  Đợi sau click (ms)
                  <input
                    aria-label="Đợi sau click"
                    disabled={locked}
                    type="number"
                    min={0}
                    max={10000}
                    value={pairDelay}
                    onChange={(e) => setPairDelay(Number(e.target.value))}
                  />
                </label>
                <button
                  disabled={
                    locked ||
                    !previousClick ||
                    state?.flow?.steps[selectedIndex]?.version !==
                      selected.version
                  }
                  onClick={() =>
                    void task(async () => {
                      setResults([]);
                      const r = await invoke<Result[]>({
                        type: "testPair",
                        firstId: previousClick!.id,
                        secondId: selected.id,
                        delayMs: pairDelay,
                      });
                      setResults(r);
                      setMessage(r.map((r) => r.message).join("\n"));
                    })
                  }
                >
                  Test 2 Step · CLICK → TYPE (Base)
                </button>
                <p>
                  {previousClick
                    ? `${previousClick.name} v${previousClick.version} → ${selected.name} v${selected.version}. TYPE đã lưu: ${selected.payload.inputMethod ?? "keyboard"}. Override không áp dụng cho cặp này.`
                    : "Cần Step Base CLICK_TARGET ngay trước TYPE_ONLY trong flow. Lưu/pin đúng version trước khi test cặp."}
                </p>
              </section>
            )}

            <input
              aria-label="Ngữ cảnh Override"
              disabled={locked}
              value={context}
              onChange={(e) => setContext(e.target.value)}
            />
            <button
              disabled={locked || (needsTarget && !target)}
              onClick={() =>
                void task(async () => {
                  const next = await invoke<State>({
                    type: "saveOverride",
                    stepId: selected.id,
                    version: selected.version,
                    name: context,
                    segment: [payload()],
                  });
                  setState(next);
                  setOverrideId(next.overrides.at(-1)!.id);
                  setMessage(
                    "Đã lưu Override riêng; Base không thay đổi. Chọn Base để bỏ áp dụng Override.",
                  );
                })
              }
            >
              Lưu form thành Override riêng
            </button>
            <p className="hint mono">
              {selected.id} / v{selected.version}
            </p>
          </>
        )}
        <div role="status" className="status">
          {busy ? "Đang xử lý…" : message}
        </div>
        <div ref={resultPanel} aria-label="Kết quả Test">
          {results.map((r) => (
            <div
              className={
                "result " +
                (r.status === "VERIFIED"
                  ? "pass"
                  : r.status === "ACTION_SENT"
                    ? "sent"
                    : "fail")
              }
              key={r.id}
            >
              <b>
                {r.status} · {r.action}
              </b>
              <p>{r.message}</p>
              <p>
                Step {r.stepId.slice(0, 8)} · v{r.version} ·{" "}
                {r.source === "override" ? "Override" : "Base"}
              </p>
              {r.match && (
                <div className="match-detail">
                  <b>
                    Đã dùng:{" "}
                    {r.match.method === "ocr"
                      ? "OCR text matching"
                      : "Image Matching"}
                  </b>
                  {r.match.method === "ocr" ? (
                    <p>
                      Chữ tìm được: “{r.match.text}” · confidence{" "}
                      {r.match.confidence?.toFixed(1)}%
                    </p>
                  ) : (
                    <>
                      <p>
                        Ảnh ROI đã khớp · score {r.match.score.toFixed(4)}.
                        Không dùng OCR cho lần test này.
                      </p>
                      <ResultTarget asset={r.targetAsset} />
                    </>
                  )}
                  <p>
                    Tọa độ browser: ({r.match.x.toFixed(1)},{" "}
                    {r.match.y.toFixed(1)}) DIP
                  </p>
                </div>
              )}
              {r.input && (
                <div className="match-detail">
                  <b>
                    Phương thức nhập:{" "}
                    {r.input.method === "clipboard"
                      ? "Clipboard paste"
                      : "Keyboard · native text + Shift+Enter"}
                  </b>
                  <p>
                    Browser focus: {String(r.input.focus.browser)} · editor
                    focus: {String(r.input.focus.editor)} · route:{" "}
                    {r.input.focus.route}. Caret: chưa kiểm chứng.
                  </p>
                  {r.input.clipboard && (
                    <p>
                      Clipboard: {r.input.clipboard}. {r.input.warning}
                    </p>
                  )}
                </div>
              )}
              {r.status === "ACTION_SENT" && (
                <p>
                  Chỉ mới gửi thao tác; chưa xác nhận kết quả nghiệp vụ. Quan
                  sát browser đang hiển thị và chờ giao diện phản hồi.
                </p>
              )}
              {["CLICK_TARGET", "TYPE_ONLY"].includes(r.action) && !r.after && (
                <p>
                  Browser live được giữ nguyên; không tự chụp ảnh sau input để
                  tránh mất focus. Ảnh trước chỉ xem khi bạn yêu cầu. Nếu cần gõ
                  tiếp sau thao tác ở sidebar/chụp ảnh, click thủ công vào ô
                  nhập.
                </p>
              )}
              {r.status === "ACTION_SENT" &&
                ["CLICK_TARGET", "TYPE_ONLY"].includes(r.action) && (
                  <div className="review-actions">
                    <button
                      disabled={
                        locked ||
                        !state?.flow?.steps.some(
                          (s) => s.id === r.stepId && s.version === r.version,
                        )
                      }
                      onClick={() => void task(() => reviewClick(r, "correct"))}
                    >
                      Đúng — Hoàn thành Step
                    </button>
                    <button
                      disabled={
                        locked ||
                        !state?.flow?.steps.some(
                          (s) => s.id === r.stepId && s.version === r.version,
                        )
                      }
                      onClick={() =>
                        void task(() => reviewClick(r, "incorrect"))
                      }
                    >
                      Sai — Redesign Step
                    </button>
                  </div>
                )}
              {r.review?.verdict === "correct" && (
                <button disabled={locked} onClick={newStep}>
                  + Tạo Step tiếp theo từ browser hiện tại
                </button>
              )}
              {!r.before && (
                <p>Không chụp trước TYPE_ONLY/SCROLL để giữ focus.</p>
              )}
              <div className="row">
                <button
                  disabled={busy || !r.before}
                  onClick={() => void task(() => inspect(r.before!))}
                >
                  Ảnh trước
                </button>
                <button
                  disabled={busy || !!shot}
                  onClick={() =>
                    void task(async () =>
                      inspect(
                        r.after ?? (await invoke<Capture>({ type: "capture" })),
                      ),
                    )
                  }
                >
                  {r.after ? "Ảnh sau" : "Chụp trạng thái hiện tại"}
                </button>
              </div>
            </div>
          ))}
        </div>
        <p className="hint">
          Đăng nhập thủ công; session giữ local. CAPTCHA/checkpoint: dừng và xử
          lý thủ công. POC không có Publish action.
        </p>
      </aside>
      {shot && (
        <div
          className="snapshot"
          onPointerDown={(e) => {
            if (!cropMode) return;
            drag.current = point(e);
            e.currentTarget.setPointerCapture(e.pointerId);
            setRoi(undefined);
          }}
          onPointerMove={(e) => {
            if (!drag.current || !cropMode) return;
            const p = point(e),
              s = drag.current;
            setRoi({
              x: Math.round(Math.min(p.x, s.x)),
              y: Math.round(Math.min(p.y, s.y)),
              width: Math.round(Math.abs(p.x - s.x)),
              height: Math.round(Math.abs(p.y - s.y)),
            });
          }}
          onPointerUp={() => {
            drag.current = undefined;
          }}
          onPointerCancel={() => {
            drag.current = undefined;
            setRoi(undefined);
          }}
          onLostPointerCapture={() => {
            drag.current = undefined;
          }}
        >
          <img alt="Browser screenshot" draggable={false} src={shot.dataUrl} />
          {roi && (
            <div
              className="roi"
              style={{
                left: roi.x,
                top: roi.y,
                width: roi.width,
                height: roi.height,
              }}
            />
          )}
        </div>
      )}
    </main>
  );
}
function ResultTarget({ asset }: { asset?: string }) {
  const [image, setImage] = useState("");
  useEffect(() => {
    let active = true;
    setImage("");
    if (asset)
      void window.creator
        .invoke({ type: "targetImage", asset })
        .then((value) => {
          if (active) setImage(value as string);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [asset]);
  return image ? (
    <img className="target" alt="Ảnh target đã dùng khi test" src={image} />
  ) : null;
}
createRoot(document.getElementById("root")!).render(<Creator />);
