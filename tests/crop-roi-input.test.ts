import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CROP_ROI_CONFIRM_LABEL,
  CROP_ROI_FIELD_LABELS,
  CROP_ROI_GROUP_LABEL,
  canConfirmCropRoi,
  cropRoiFieldsFromRect,
  displayToImagePoint,
  emptyCropRoiFields,
  parseCropRoiFields,
  roiFromDragPoints,
} from "../src/shared/crop-roi-input.js";

const IMAGE_W = 1024;
const IMAGE_H = 560;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("1: valid numeric ROI parses in image DIP space", () => {
  const parsed = parseCropRoiFields(
    { x: "120", y: "80", width: "360", height: "64" },
    IMAGE_W,
    IMAGE_H,
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.roi, { x: 120, y: 80, width: 360, height: 64 });
  assert.equal(canConfirmCropRoi(parsed.roi, IMAGE_W, IMAGE_H), true);
});

test("2: invalid negative or zero dimensions are rejected without clamping", () => {
  for (const fields of [
    { x: "10", y: "10", width: "0", height: "40" },
    { x: "10", y: "10", width: "-8", height: "40" },
    { x: "10", y: "10", width: "40", height: "0" },
    { x: "10", y: "10", width: "40", height: "-4" },
    { x: "-1", y: "10", width: "40", height: "40" },
    { x: "10", y: "-2", width: "40", height: "40" },
  ]) {
    const parsed = parseCropRoiFields(fields, IMAGE_W, IMAGE_H);
    assert.equal(parsed.ok, false, JSON.stringify(fields));
    if (parsed.ok) continue;
    assert.match(parsed.error, /ROI|0|âm|lớn hơn/i);
  }
});

test("3: ROI exceeding image bounds is rejected without clamping", () => {
  const parsed = parseCropRoiFields(
    { x: "1000", y: "10", width: "40", height: "20" },
    IMAGE_W,
    IMAGE_H,
  );
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /ngoài ảnh|4 px/i);
  // Prove we did not silently shrink into bounds.
  assert.notDeepEqual(
    { x: 1000, y: 10, width: 24, height: 20 },
    { x: 1000, y: 10, width: 40, height: 20 },
  );
});

test("4: scaled screenshot maps display pixels to original image DIPs", () => {
  // Displayed at 50% CSS size of a 1024×560 capture.
  const display = { left: 100, top: 50, width: 512, height: 280 };
  const center = displayToImagePoint(100 + 256, 50 + 140, display, IMAGE_W, IMAGE_H);
  assert.deepEqual(
    { x: Math.round(center.x), y: Math.round(center.y) },
    { x: 512, y: 280 },
  );
  const corner = displayToImagePoint(100 + 512, 50 + 280, display, IMAGE_W, IMAGE_H);
  assert.deepEqual(corner, { x: IMAGE_W, y: IMAGE_H });
});

test("5: numeric input updates crop preview fields → confirmable ROI", () => {
  const fields = { x: "200", y: "100", width: "80", height: "40" };
  const parsed = parseCropRoiFields(fields, IMAGE_W, IMAGE_H);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(cropRoiFieldsFromRect(parsed.roi), fields);
  assert.equal(canConfirmCropRoi(parsed.roi, IMAGE_W, IMAGE_H), true);
});

test("6: drag selection updates numeric input fields", () => {
  const dragged = roiFromDragPoints({ x: 50.2, y: 60.8 }, { x: 150.7, y: 120.1 });
  assert.deepEqual(dragged, { x: 50, y: 61, width: 100, height: 59 });
  assert.deepEqual(cropRoiFieldsFromRect(dragged), {
    x: "50",
    y: "61",
    width: "100",
    height: "59",
  });
});

test("7: Dùng ROI works without dragging when numeric ROI is valid", () => {
  const empty = emptyCropRoiFields();
  assert.equal(canConfirmCropRoi(undefined, IMAGE_W, IMAGE_H), false);
  assert.equal(parseCropRoiFields(empty, IMAGE_W, IMAGE_H).ok, false);

  const typed = parseCropRoiFields(
    { x: "16", y: "24", width: "120", height: "48" },
    IMAGE_W,
    IMAGE_H,
  );
  assert.equal(typed.ok, true);
  if (!typed.ok) return;
  assert.equal(canConfirmCropRoi(typed.roi, IMAGE_W, IMAGE_H), true);
  assert.equal(CROP_ROI_CONFIRM_LABEL, "Dùng ROI");
});

test("8: existing drag workflow still produces a confirmable ROI", () => {
  const start = displayToImagePoint(10, 20, { left: 0, top: 0, width: IMAGE_W, height: IMAGE_H }, IMAGE_W, IMAGE_H);
  const end = displayToImagePoint(210, 120, { left: 0, top: 0, width: IMAGE_W, height: IMAGE_H }, IMAGE_W, IMAGE_H);
  const dragged = roiFromDragPoints(start, end);
  assert.deepEqual(dragged, { x: 10, y: 20, width: 200, height: 100 });
  assert.equal(canConfirmCropRoi(dragged, IMAGE_W, IMAGE_H), true);
});

test("9: keyboard/accessibility labels are present in Creator crop UI", () => {
  const mainSource = readFileSync(path.join(root, "src/renderer/main.tsx"), "utf8");
  assert.match(mainSource, /aria-label=\{CROP_ROI_GROUP_LABEL\}/);
  assert.match(mainSource, /aria-label=\{CROP_ROI_FIELD_LABELS\[key\]\}/);
  assert.match(mainSource, /aria-label=\{CROP_ROI_CONFIRM_LABEL\}/);
  assert.match(mainSource, /crop-roi-numeric/);
  assert.match(mainSource, /applyNumericRoiField/);
  assert.deepEqual(CROP_ROI_FIELD_LABELS, {
    x: "ROI X",
    y: "ROI Y",
    width: "ROI Width",
    height: "ROI Height",
  });
  assert.equal(CROP_ROI_GROUP_LABEL, "ROI numeric coordinates");
});
