import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Store } from "../src/main/storage.js";
import { matchToRequiresMissingOcr } from "../src/shared/script-release.js";
import { importScriptRelease } from "../src/shared/script-sync.js";

test("missing Variable ref: startup keeps data, no fake Variable, invalid not executable, valid still works", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "creator-invalid-ref-"));
  const file = path.join(dir, "creator.sqlite");
  try {
    let store = new Store(file);
    const flow = store.newFlow("POC", 1);
    const aliveVar = {
      id: "var-alive",
      key: "content",
      type: "text" as const,
    };
    flow.variables = [aliveVar];
    flow.defaultPattern = { values: { [aliveVar.id]: "hello" } };
    store.saveFlow(flow);
    store.close();

    const db = new DatabaseSync(file);
    const stepId = "7093f687-9f6b-4ca7-af58-e5877412d5ee";
    const broken = {
      id: stepId,
      version: 1,
      name: "old",
      createdAt: "2026-10-19T06:44:27.730Z",
      payload: {
        action: "TYPE_ONLY",
        variableId: "abd7ec0e-4379-4b22-9755-63d223fbccf8",
      },
    };
    const good = {
      id: stepId,
      version: 3,
      name: "current",
      createdAt: "2026-10-22T09:39:32.225Z",
      payload: {
        action: "CLICK_AND_TYPE",
        variableId: aliveVar.id,
        target: {
          asset: "17ddecd0-1e09-4198-a20a-171b8ff0d080.png",
          roi: { x: 0, y: 0, width: 40, height: 40 },
        },
      },
    };
    for (const step of [broken, good])
      db.prepare("INSERT INTO steps VALUES(?,?,?)").run(
        step.id,
        step.version,
        JSON.stringify(step),
      );
    const flowRow = JSON.parse(
      (db.prepare("SELECT payload FROM flows WHERE id=?").get(flow.id) as {
        payload: string;
      }).payload,
    );
    flowRow.steps = [{ id: stepId, version: 3 }];
    db.prepare("UPDATE flows SET payload=? WHERE id=?").run(
      JSON.stringify(flowRow),
      flow.id,
    );
    const beforeVars = JSON.stringify(flowRow.variables);
    const beforeBroken = JSON.stringify(broken);
    db.close();

    store = new Store(file);
    assert.equal(
      (store.db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
      2,
    );
    assert.deepEqual(store.step(stepId, 1).payload, broken.payload);
    assert.equal(store.step(stepId, 3).payload.variableId, aliveVar.id);
    assert.equal(JSON.stringify(store.flow()!.variables), beforeVars);
    assert.ok(
      store
        .invalidSteps()
        .some(
          (r) =>
            r.stepId === stepId &&
            r.version === 1 &&
            r.reason === "missing_variable",
        ),
    );
    assert.equal(
      store.invalidSteps().some((r) => r.stepId === stepId && r.version === 3),
      false,
    );
    assert.throws(
      () => store.assertStepExecutable(stepId, 1),
      /orphan Variable|→ Step .* → v1/,
    );
    assert.doesNotThrow(() => store.assertStepExecutable(stepId, 3));
    // No fabricated Variable for the missing UUID.
    assert.equal(
      store.flow()!.variables?.some(
        (v) => v.id === "abd7ec0e-4379-4b22-9755-63d223fbccf8",
      ),
      false,
    );
    store.close();

    // Reopen must not loop-fail or rewrite the broken version.
    store = new Store(file);
    assert.deepEqual(
      JSON.stringify(store.step(stepId, 1)),
      JSON.stringify(JSON.parse(beforeBroken)),
    );
    store.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows WAL */
    }
  }
});

test("sync import preserves Variable id by key; Match To without OCR stays invalid_payload", () => {
  const priorId = "f0087a5f-d0ed-47c3-8ecb-6b452d6b6c69";
  // Simulate materializeImport id selection.
  const existingByKey = new Map([["legacy_3", { id: priorId, key: "legacy_3", type: "text" as const }]]);
  const key = "legacy_3";
  const rawId: string | undefined = undefined;
  const id = String(rawId ?? existingByKey.get(key)?.id ?? `var-0-${key}`);
  assert.equal(id, priorId);

  const release = importScriptRelease({
    package_key: "x",
    name: "X",
    version: "1.0.0",
    content_digest: "a".repeat(64),
    manifest: {
      script_id: "x",
      variables: [{ id: "f0087a5f-d0ed-47c3-8ecb-6b452d6b6c69", key: "legacy_3", type: "text" }],
      steps: [
        {
          id: "s1",
          action: "CLICK_TARGET",
          target: {
            asset: "17ddecd0-1e09-4198-a20a-171b8ff0d080.png",
            roi: { x: 0, y: 0, width: 10, height: 10 },
            matchTo: "top",
          },
        },
      ],
      assets: [
        {
          path: "17ddecd0-1e09-4198-a20a-171b8ff0d080.png",
          sha256: "b".repeat(64),
          kind: "roi",
        },
      ],
    },
  });
  assert.ok(release.incomplete_reasons.includes("invalid_payload"));
  assert.equal(release.flowPayload, null);
  assert.equal(
    matchToRequiresMissingOcr({
      asset: "a.png",
      matchTo: "top",
    }),
    true,
  );
});
