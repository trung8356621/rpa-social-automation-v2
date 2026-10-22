import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Store } from "../src/main/storage.js";
import { matchToLogLabel } from "../src/shared/match-to.js";

const target = {
  asset: "17ddecd0-1e09-4198-a20a-171b8ff0d080.png",
  roi: { x: 0, y: 0, width: 80, height: 40 },
};

test("pinned invalid Match To version blocks Play; valid pin still executable", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "play-version-gate-"));
  const file = path.join(dir, "creator.sqlite");
  try {
    const store = new Store(file);
    const flow = store.newFlow("gate", 1);
    const ocr = {
      confirmed: true as const,
      language: "vie+eng" as const,
      kind: "line" as const,
      text: "Composer",
      confidence: 90,
      bbox: { x: 1, y: 1, width: 40, height: 16 },
    };
    const good = store.saveStep("click", {
      action: "CLICK_TARGET",
      method: "auto",
      threshold: 0.96,
      timeoutMs: 3000,
      target: { ...target, matchTo: "top", ocr },
    });
    // Append a broken v2 by direct insert (same shape as bad SEO-OPS sync).
    const broken = {
      id: good.id,
      version: 2,
      name: "click",
      createdAt: new Date().toISOString(),
      payload: {
        action: "CLICK_TARGET" as const,
        target: { ...target, matchTo: "top" as const },
      },
    };
    store.db
      .prepare("INSERT INTO steps VALUES(?,?,?)")
      .run(broken.id, broken.version, JSON.stringify(broken));
    store.reindexInvalidSteps();

    assert.ok(
      store
        .invalidSteps()
        .some(
          (r) =>
            r.stepId === good.id &&
            r.version === 2 &&
            r.reason === "invalid_payload",
        ),
    );
    assert.doesNotThrow(() => store.assertStepExecutable(good.id, 1, flow));
    assert.throws(
      () => store.assertStepExecutable(good.id, 2, flow),
      /Match To Top yêu cầu OCR confirmed|Match To cần OCR/,
    );

    // Pin broken version → flow-level Play All / Test Lab blocked.
    store.selectVersion(good.id, 2);
    const pinned = store.flow()!;
    assert.equal(pinned.steps.find((r) => r.id === good.id)?.version, 2);
    assert.throws(
      () => store.assertFlowExecutable(pinned),
      /→ Step .* → v2|OCR confirmed/,
    );

    // Pin valid version → flow executable again.
    store.selectVersion(good.id, 1);
    assert.doesNotThrow(() => store.assertFlowExecutable(store.flow()!));

    assert.match(
      matchToLogLabel(broken.payload),
      /None \(stored top; thiếu OCR confirmed\)/,
    );
    assert.equal(matchToLogLabel(good.payload), "Top");
    store.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows WAL */
    }
  }
});

test("selectVersion changes pinned Play version without rewriting payloads", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "select-version-"));
  const file = path.join(dir, "creator.sqlite");
  try {
    const store = new Store(file);
    store.newFlow("pins", 1);
    const v1 = store.saveStep("a", {
      action: "CLICK_TARGET",
      target: {
        ...target,
        matchTo: "top",
        ocr: {
          confirmed: true,
          language: "vie+eng",
          kind: "line",
          text: "Hi",
          confidence: 91,
          bbox: { x: 2, y: 2, width: 30, height: 14 },
        },
      },
    });
    const v2 = store.saveStep(
      "a",
      {
        action: "CLICK_TARGET",
        target: {
          ...target,
          matchTo: "none",
        },
      },
      v1.id,
    );
    assert.equal(store.flow()!.steps[0].version, v2.version);
    const before = JSON.stringify(store.step(v1.id, 1).payload);
    store.selectVersion(v1.id, 1);
    assert.equal(store.flow()!.steps[0].version, 1);
    assert.equal(JSON.stringify(store.step(v1.id, 1).payload), before);
    store.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows WAL */
    }
  }
});
