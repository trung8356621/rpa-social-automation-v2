import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Store } from "../src/main/storage.js";
import {
  formatHumanStepError,
  humanReasonForIssue,
  scanScriptHealth,
  summarizeVersionDiff,
} from "../src/shared/script-health.js";

const target = {
  asset: "17ddecd0-1e09-4198-a20a-171b8ff0d080.png",
  roi: { x: 0, y: 0, width: 80, height: 40 },
};
const ocr = {
  confirmed: true as const,
  language: "vie+eng" as const,
  kind: "line" as const,
  text: "Composer",
  confidence: 90,
  bbox: { x: 1, y: 1, width: 40, height: 16 },
};

function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows WAL */
  }
}

test("health scan is read-only and finds missing OCR + orphan variable + missing ROI", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "script-health-"));
  const file = path.join(dir, "creator.sqlite");
  try {
    const store = new Store(file);
    const flow = store.newFlow("Facebook draft POC", 1);
    const good = store.saveStep("Open composer", {
      action: "CLICK_TARGET",
      method: "auto",
      threshold: 0.96,
      timeoutMs: 3000,
      target: { ...target, matchTo: "top", ocr },
    });
    store.db
      .prepare("INSERT INTO steps VALUES(?,?,?)")
      .run(
        good.id,
        12,
        JSON.stringify({
          id: good.id,
          version: 12,
          name: "Open composer",
          createdAt: new Date().toISOString(),
          payload: {
            action: "CLICK_TARGET",
            target: { ...target, matchTo: "top" },
          },
        }),
      );
    const typed = store.saveStep("Type body", {
      action: "TYPE_ONLY",
      text: "hello",
    });
    // Orphan variable version.
    store.db
      .prepare("INSERT INTO steps VALUES(?,?,?)")
      .run(
        typed.id,
        9,
        JSON.stringify({
          id: typed.id,
          version: 9,
          name: "Type body",
          createdAt: new Date().toISOString(),
          payload: {
            action: "TYPE_ONLY",
            variableId: "00000000-0000-0000-0000-000000000099",
          },
        }),
      );
    const noRoi = {
      id: "08947dd7-1436-4210-9279-130f2d00d4ad",
      version: 2,
      name: "Broken ROI",
      createdAt: new Date().toISOString(),
      payload: { action: "CLICK_TARGET", target: { asset: "not-a-uuid.png", roi: target.roi, matchTo: "top" } },
    };
    // Keep flow refs on valid pins for ROI step separately — probe all versions via scan.
    store.db
      .prepare("INSERT INTO steps VALUES(?,?,?)")
      .run(noRoi.id, noRoi.version, JSON.stringify(noRoi));
    const f = store.flow()!;
    f.steps.push({ id: noRoi.id, version: 2 });
    store.saveFlow(f);
    store.reindexInvalidSteps();

    const before = JSON.stringify({
      flows: store.flows(),
      steps: store.steps(),
    });
    const report = store.scanScriptHealth();
    const after = JSON.stringify({
      flows: store.flows(),
      steps: store.steps(),
    });
    assert.equal(before, after, "scan must not mutate SQLite payloads");

    const scenario = report.scenarios.find((s) => s.flowId === flow.id)!;
    const click = scenario.steps.find((s) => s.stepId === good.id)!;
    assert.equal(click.pinnedVersion, good.version);
    assert.equal(click.pinnedValid, true);
    assert.ok(click.versions.some((v) => v.version === 12 && v.status === "invalid"));
    assert.match(
      click.versions.find((v) => v.version === 12)!.humanReason!,
      /Match To Top yêu cầu OCR confirmed/,
    );

    store.selectVersion(good.id, 12);
    const pinnedBroken = store.scanScriptHealth().scenarios[0].steps.find(
      (s) => s.stepId === good.id,
    )!;
    assert.equal(pinnedBroken.pinnedValid, false);
    assert.equal(pinnedBroken.suggestedValidVersion, good.version);

    const orphan = store
      .scanScriptHealth()
      .scenarios[0].steps.find((s) => s.stepId === typed.id)!;
    assert.ok(
      orphan.versions.some(
        (v) =>
          v.version === 9 &&
          v.status === "invalid" &&
          /orphan Variable/i.test(v.humanReason || ""),
      ),
    );

    const roiStep = store
      .scanScriptHealth()
      .scenarios[0].steps.find((s) => s.stepId === noRoi.id)!;
    assert.equal(roiStep.pinnedValid, false);
    assert.match(roiStep.pinnedHumanError || "", /ROI|ảnh target/i);

    assert.throws(
      () => store.assertFlowExecutable(store.flow()!),
      /Facebook draft POC → Step /,
    );
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("pin suggested version only changes reference; human error mapping", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "script-health-pin-"));
  const file = path.join(dir, "creator.sqlite");
  try {
    const store = new Store(file);
    store.newFlow("Demo", 1);
    const v1 = store.saveStep("Click", {
      action: "CLICK_TARGET",
      target: { ...target, matchTo: "top", ocr },
    });
    store.db
      .prepare("INSERT INTO steps VALUES(?,?,?)")
      .run(
        v1.id,
        2,
        JSON.stringify({
          id: v1.id,
          version: 2,
          name: "Click",
          createdAt: new Date().toISOString(),
          payload: {
            action: "CLICK_TARGET",
            target: { ...target, matchTo: "top" },
          },
        }),
      );
    store.selectVersion(v1.id, 2);
    const beforeV2 = JSON.stringify(store.step(v1.id, 2).payload);
    const beforeV1 = JSON.stringify(store.step(v1.id, 1).payload);
    store.selectVersion(v1.id, 1);
    assert.equal(store.flow()!.steps[0].version, 1);
    assert.equal(JSON.stringify(store.step(v1.id, 2).payload), beforeV2);
    assert.equal(JSON.stringify(store.step(v1.id, 1).payload), beforeV1);
    assert.doesNotThrow(() => store.assertFlowExecutable(store.flow()!));

    const mapped = humanReasonForIssue(
      { reasonCode: "invalid_payload", detail: "Match To cần OCR đã xác nhận." },
      { action: "CLICK_TARGET", target: { ...target, matchTo: "middle" } },
    );
    assert.match(mapped, /Match To Middle yêu cầu OCR confirmed/);
    const formatted = formatHumanStepError({
      scenarioName: "Demo",
      flowId: "flow-1",
      stepId: v1.id,
      order: 3,
      stepName: "Click",
      version: 12,
      issue: {
        reasonCode: "invalid_payload",
        detail: "Match To cần OCR đã xác nhận.",
      },
      payload: { action: "CLICK_TARGET", target: { ...target, matchTo: "top" } },
    });
    assert.equal(formatted.headline, "Demo → Step 3: Click → v12");
    assert.match(formatted.technical, new RegExp(v1.id));
    assert.ok(
      summarizeVersionDiff(
        { action: "CLICK_TARGET", target: { ...target, matchTo: "top" } },
        {
          action: "CLICK_TARGET",
          target: { ...target, matchTo: "top", ocr },
        },
      ).some((line) => /OCR confirmed/.test(line)),
    );

    // Pure scan helper with stub probe.
    const pure = scanScriptHealth({
      flows: store.flows(),
      steps: store.steps(),
      probe: () => null,
    });
    assert.equal(pure.totals.pinnedInvalid, 0);
    store.close();
  } finally {
    cleanup(dir);
  }
});
