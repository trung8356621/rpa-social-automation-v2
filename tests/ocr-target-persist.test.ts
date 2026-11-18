import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import {
  confirmedOcrFromSegment,
  ocrKindFromTarget,
} from "../src/shared/ocr-target-draft.js";
import { effectiveMatchTo } from "../src/shared/match-to.js";
import type { Payload, Step } from "../src/shared/contracts.js";

/** Mimic renderer payload() for CLICK_AND_TYPE after OCR confirm. */
function editorPayload(target: NonNullable<Payload["target"]>, variableId: string): Payload {
  return {
    action: "CLICK_AND_TYPE",
    variableId,
    inputMethod: "keyboard",
    target: { ...target, matchTo: effectiveMatchTo({ target }) },
    method: "auto",
    threshold: 0.96,
    timeoutMs: 3000,
  };
}

test("OCR confirm → saveStep → flow pin → reopen keeps kind/confirmed (v6→v7→v8)", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ocr-persist-"));
  const file = path.join(root, "creator.sqlite");
  let store = new Store(file);
  const report: {
    savedVersion?: number;
    flowReferencedVersion?: number;
    reopenedVersion?: number;
    ocrKind?: string;
    ocrConfirmed?: boolean;
  } = {};
  try {
    store.newFlow("mayhopphat.login fixture", 1);
    store.updateVariables(
      [{ id: "u", key: "username", type: "text" }],
      { u: "fixture_user" },
    );
    const imageOnly: Payload = {
      action: "CLICK_AND_TYPE",
      variableId: "u",
      inputMethod: "keyboard",
      method: "auto",
      threshold: 0.96,
      timeoutMs: 3000,
      target: {
        asset: "00000000-0000-0000-0000-000000000066.png",
        roi: { x: 10, y: 10, width: 320, height: 90 },
        environment: { width: 1024, height: 560, zoom: 1 },
      },
    };
    let step = store.saveStep("user name", imageOnly);
    for (let v = 2; v <= 6; v++) step = store.saveStep("user name", imageOnly, step.id);
    assert.equal(step.version, 6);
    assert.equal(store.flow()!.steps.find((s) => s.id === step.id)!.version, 6);
    assert.equal(step.payload.target?.ocr, undefined);
    assert.equal(ocrKindFromTarget(step.payload.target), "none");

    // UI: select Full Line + segment → Xong commits draft → Save redesign
    const draftTarget = {
      ...imageOnly.target!,
      ocr: confirmedOcrFromSegment(
        {
          id: "0",
          text: "Username or Email Address",
          kind: "line",
          confidence: 91,
          bbox: { x: 8, y: 4, width: 280, height: 22 },
        },
        imageOnly.target!.roi,
        "line",
      ),
      clickOffset: { x: 0, y: 0 },
    };
    assert.equal(draftTarget.ocr.confirmed, true);
    assert.equal(draftTarget.ocr.kind, "line");
    assert.equal(ocrKindFromTarget(draftTarget), "line");

    const v7Payload = editorPayload(draftTarget, "u");
    const v7 = store.saveStep("user name", v7Payload, step.id);
    report.savedVersion = v7.version;
    report.flowReferencedVersion = store.flow()!.steps.find((s) => s.id === step.id)!.version;
    assert.equal(report.savedVersion, 7);
    assert.equal(report.flowReferencedVersion, 7);
    assert.equal(v7.payload.target?.ocr?.kind, "line");
    assert.equal(v7.payload.target?.ocr?.confirmed, true);
    assert.equal(store.step(step.id, 6).payload.target?.ocr, undefined);

    // Reopen via flow pin (same as loadStep after Save / restart)
    store.close();
    store = new Store(file);
    const ref = store.flow()!.steps.find((s) => s.id === step.id)!;
    const reopened = store.step(ref.id, ref.version);
    report.reopenedVersion = reopened.version;
    report.ocrKind = ocrKindFromTarget(reopened.payload.target);
    report.ocrConfirmed = reopened.payload.target?.ocr?.confirmed === true;
    assert.equal(report.reopenedVersion, 7);
    assert.equal(report.ocrKind, "line");
    assert.equal(report.ocrConfirmed, true);

    // Further edit → v8; v6/v7 immutable
    const v8Target = {
      ...draftTarget,
      ocr: confirmedOcrFromSegment(
        {
          id: "1",
          text: "Username or Email Address",
          kind: "word",
          confidence: 88,
          bbox: { x: 8, y: 4, width: 90, height: 22 },
        },
        draftTarget.roi,
        "word",
      ),
    };
    const v8 = store.saveStep("user name", editorPayload(v8Target, "u"), step.id);
    assert.equal(v8.version, 8);
    assert.equal(store.flow()!.steps.find((s) => s.id === step.id)!.version, 8);
    assert.equal(store.step(step.id, 6).payload.target?.ocr, undefined);
    assert.equal(store.step(step.id, 7).payload.target?.ocr?.kind, "line");
    assert.equal(store.step(step.id, 8).payload.target?.ocr?.kind, "word");

    // Runtime-facing: pinned version carries confirmed OCR
    const pinned: Step = store.step(step.id, store.flow()!.steps.find((s) => s.id === step.id)!.version);
    assert.equal(pinned.payload.target?.ocr?.confirmed, true);
    assert.equal(pinned.payload.target?.ocr?.kind, "word");
  } finally {
    console.log(
      JSON.stringify({
        savedVersion: report.savedVersion,
        flowReferencedVersion: report.flowReferencedVersion,
        reopenedVersion: report.reopenedVersion,
        ocrKind: report.ocrKind,
        ocrConfirmed: report.ocrConfirmed,
      }),
    );
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("clamp keeps oversized OCR bbox inside ROI so save validation passes", () => {
  const roi = { x: 0, y: 0, width: 100, height: 40 };
  const ocr = confirmedOcrFromSegment(
    {
      id: "0",
      text: "Username",
      confidence: 90,
      bbox: { x: 90, y: 30, width: 50, height: 30 },
    },
    roi,
    "line",
  );
  assert.equal(ocr.bbox.x + ocr.bbox.width <= roi.width, true);
  assert.equal(ocr.bbox.y + ocr.bbox.height <= roi.height, true);
  assert.equal(ocr.kind, "line");
  assert.equal(ocr.confirmed, true);
});
