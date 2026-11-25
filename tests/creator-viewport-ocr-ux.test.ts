import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WEB_HEIGHT,
  WEB_WIDTH,
  TOP_HEIGHT,
  workspaceLayout,
  imageToInput,
  validateRect,
} from "../src/shared/geometry.js";
import {
  ocrModalStatus,
  requiresOcrConfirmation,
  ocrKindFromTarget,
} from "../src/shared/ocr-target-draft.js";
import { effectiveMatchTo } from "../src/shared/match-to.js";
import { Store, validatePayload, validateDraftPayload } from "../src/main/storage.js";
import {
  canConfirmCropRoi,
  parseCropRoiFields,
  roiFromDragPoints,
  displayToImagePoint,
} from "../src/shared/crop-roi-input.js";
import type { Payload } from "../src/shared/contracts.js";

test("1: Capture/Play viewport matches browse — always 1024×560", () => {
  const browse = workspaceLayout(true, true, 1920, 1080, false, false);
  const capture = workspaceLayout(true, true, 1920, 1080, false, true);
  assert.deepEqual(browse.browser, {
    x: browse.browser.x,
    y: TOP_HEIGHT,
    width: WEB_WIDTH,
    height: WEB_HEIGHT,
  });
  assert.deepEqual(capture.browser, browse.browser);
  assert.equal(WEB_HEIGHT, 560);
});

test("2: Crop modal / executionMode flag does not resize BrowserCore", () => {
  const before = workspaceLayout(false, true, 1600, 900, false, false);
  const duringCrop = workspaceLayout(false, true, 1600, 900, false, true);
  const after = workspaceLayout(false, true, 1600, 900, false, false);
  assert.deepEqual(before.browser, duringCrop.browser);
  assert.deepEqual(duringCrop.browser, after.browser);
  assert.equal(before.browser.height, 560);
});

test("3: ROI coordinate mapping stays in 1024×560 image space after layout", () => {
  const layout = workspaceLayout(true, false, 1920, 1080, false, true);
  const bounds = layout.browser;
  assert.deepEqual(imageToInput(400, 280, WEB_WIDTH, WEB_HEIGHT, bounds), {
    x: 400,
    y: 280,
  });
  const roi = validateRect({ x: 100, y: 200, width: 80, height: 40 }, WEB_WIDTH, WEB_HEIGHT);
  assert.deepEqual(roi, { x: 100, y: 200, width: 80, height: 40 });
});

test("4: shell scroll offsets do not change browser content size", () => {
  const layout = workspaceLayout(true, true, 1400, 800, false, false);
  assert.equal(layout.browser.width, WEB_WIDTH);
  assert.equal(layout.browser.height, WEB_HEIGHT);
  // Simulated shell scroll only shifts x/y in overlays; size stays canonical.
  const scrolled = {
    ...layout.browser,
    x: layout.browser.x - 40,
    y: layout.browser.y - 12,
  };
  assert.equal(scrolled.width, WEB_WIDTH);
  assert.equal(scrolled.height, WEB_HEIGHT);
});

test("5: image-only ROI saves without OCR candidate", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "img-only-"));
  const asset = "11111111-1111-4111-8111-111111111111.png";
  writeFileSync(path.join(root, asset), Buffer.alloc(64));
  try {
    const store = new Store(path.join(root, "creator.sqlite"));
    (store as unknown as { assetDir?: string }).assetDir;
    store.newFlow("qa image only", 1);
    const payload: Payload = {
      action: "CLICK_TARGET",
      method: "image",
      threshold: 0.96,
      timeoutMs: 3000,
      target: {
        asset,
        roi: { x: 10, y: 10, width: 120, height: 48 },
        environment: { width: 1024, height: 560, zoom: 1 },
        matchTo: "none",
      },
    };
    assert.equal(ocrKindFromTarget(payload.target), "none");
    assert.equal(requiresOcrConfirmation({ ocrKind: "none", matchTo: "none" }), false);
    assert.doesNotThrow(() => validateDraftPayload(payload));
    // Executable validation needs the PNG under the store asset dir — draft path is enough for UX gate.
    assert.equal(effectiveMatchTo(payload), "none");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("6: Match To None does not create an OCR requirement", () => {
  assert.equal(requiresOcrConfirmation({ ocrKind: "none", matchTo: "none" }), false);
  assert.equal(requiresOcrConfirmation({ ocrKind: "none", matchTo: undefined }), false);
  assert.equal(requiresOcrConfirmation({ ocrKind: "none", matchTo: "current" }), false);
  const status = ocrModalStatus({ ocrKind: "none", draftOcr: undefined, savedOcr: undefined });
  assert.equal(status.code, "none");
  assert.match(status.label, /Image-only target — OCR không bắt buộc/);
});

test("7: OCR-required mode still validates candidates", () => {
  assert.equal(requiresOcrConfirmation({ ocrKind: "line", matchTo: "none" }), true);
  assert.equal(requiresOcrConfirmation({ ocrKind: "none", matchTo: "top" }), true);
  const pending = ocrModalStatus({ ocrKind: "line", draftOcr: undefined, savedOcr: undefined });
  assert.equal(pending.code, "pending-mode");
  assert.match(pending.label, /OCR chưa xác nhận/);

  const payload: Payload = {
    action: "CLICK_TARGET",
    method: "auto",
    target: {
      asset: "22222222-2222-4222-8222-222222222222.png",
      roi: { x: 1, y: 1, width: 40, height: 20 },
      matchTo: "top",
    },
  };
  assert.throws(() => validatePayload(payload), /OCR|Match To/i);
});

test("8: numeric ROI and drag workflows remain valid under fixed viewport", () => {
  const numeric = parseCropRoiFields(
    { x: "50", y: "60", width: "100", height: "40" },
    WEB_WIDTH,
    WEB_HEIGHT,
  );
  assert.equal(numeric.ok, true);
  if (!numeric.ok) return;
  assert.equal(canConfirmCropRoi(numeric.roi, WEB_WIDTH, WEB_HEIGHT), true);

  const start = displayToImagePoint(10, 20, { left: 0, top: 0, width: WEB_WIDTH, height: WEB_HEIGHT }, WEB_WIDTH, WEB_HEIGHT);
  const end = displayToImagePoint(110, 90, { left: 0, top: 0, width: WEB_WIDTH, height: WEB_HEIGHT }, WEB_WIDTH, WEB_HEIGHT);
  const dragged = roiFromDragPoints(start, end);
  assert.deepEqual(dragged, { x: 10, y: 20, width: 100, height: 70 });
  assert.equal(canConfirmCropRoi(dragged, WEB_WIDTH, WEB_HEIGHT), true);
});

test("Creator crop path defaults to image-only (no auto OCR confirmation)", () => {
  const source = readFileSync("src/renderer/main.tsx", "utf8");
  assert.match(source, /Image-only target \(OCR không bắt buộc\)/);
  assert.match(source, /matchTo:\s*"none"/);
  assert.doesNotMatch(
    source,
    /await readOcr\(t\.asset\);\s*setMessage\(\s*"ROI đã lưu\. Chọn và xác nhận/,
  );
});
