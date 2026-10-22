import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { Flow, Step } from "../src/shared/contracts.js";
import {
  canonicalExecutionFromLocal,
  executionEqual,
} from "../src/shared/script-execution-canon.js";
import { materializeScriptRelease } from "../src/shared/script-materialize.js";
import { buildScriptPublishBody } from "../src/shared/script-release.js";
import { importScriptRelease } from "../src/shared/script-sync.js";
import { attachVideoDemo, toScriptVideoDemo } from "../src/shared/video-demo.js";
import { Store, validatePayload } from "../src/main/storage.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows WAL */
    }
  }
});

function demo(scriptId: string) {
  const caseId = "11111111-1111-1111-1111-111111111111";
  const runId = "22222222-2222-2222-2222-222222222222";
  return toScriptVideoDemo(
    attachVideoDemo({
      scriptId,
      scriptVersion: "1.0.0",
      caseId,
      testRunId: runId,
      executionDigest: "a".repeat(64),
      sha256: "b".repeat(64),
      thumbnailRef: `${caseId}/${runId}/recording-thumb.jpg`,
      thumbnailSha256: "c".repeat(64),
      reviewed: true,
    }),
  );
}

/** Minimal fixture modeled on desktop Facebook draft POC execution fields. */
function desktopLikeFixture(): { flow: Flow; steps: Step[]; asset: string } {
  const asset = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png";
  const contentId = "4a33024b-f24c-4b98-a1fc-7ea8c7001089";
  const imgsId = "bf949f00-2d94-4151-9318-a103a4eaf290";
  const ocr = {
    confirmed: true as const,
    language: "vie+eng" as const,
    kind: "line" as const,
    text: "@ Bạn viết gì đi...",
    confidence: 88,
    bbox: { x: 16, y: 13, width: 168, height: 41 },
  };
  const flow: Flow = {
    id: "fixture-facebook-draft",
    name: "Fixture Facebook draft",
    zoom: 1,
    steps: [
      { id: "step-click", version: 2 },
      { id: "step-type", version: 1 },
    ],
    variables: [
      { id: contentId, key: "content", type: "text" },
      { id: imgsId, key: "imgs", type: "files" },
    ],
    defaultPattern: {
      values: {
        [contentId]: "Alo có ai không",
        [imgsId]: ["C:\\fixture\\a.png"],
      },
    },
    groups: [
      {
        id: "g1",
        name: "tag",
        slug: "tag",
        collapsed: false,
        stepIds: ["step-type"],
      },
    ],
  };
  const steps: Step[] = [
    {
      id: "step-click",
      version: 2,
      name: "CLICK_TARGET",
      createdAt: "2026-10-20T05:18:58.540Z",
      payload: {
        action: "CLICK_TARGET",
        method: "auto",
        threshold: 0.96,
        timeoutMs: 3000,
        target: {
          asset,
          roi: { x: 166, y: 313, width: 684, height: 131 },
          matchTo: "top",
          environment: { width: 1024, height: 560, zoom: 1 },
          ocr,
        },
      },
    },
    {
      id: "step-type",
      version: 1,
      name: "CLICK_AND_TYPE",
      createdAt: "2026-10-20T05:19:00.000Z",
      payload: {
        action: "CLICK_AND_TYPE",
        method: "auto",
        threshold: 0.96,
        timeoutMs: 3000,
        inputMethod: "keyboard",
        variableId: contentId,
        target: {
          asset,
          roi: { x: 263, y: 242, width: 484, height: 137 },
          matchTo: "none",
          environment: { width: 1024, height: 560, zoom: 1 },
          ocr: {
            confirmed: true,
            language: "vie+eng",
            kind: "line",
            text: "Bạn viết gì đi...",
            confidence: 95,
            bbox: { x: 10, y: 21, width: 150, height: 24 },
          },
        },
      },
    },
  ];
  return { flow, steps, asset };
}

test("SQLite → Export → Import → SQLite preserves OCR/MatchTo/Variables/DefaultPattern/ROI/pins", () => {
  const { flow, steps, asset } = desktopLikeFixture();
  const before = canonicalExecutionFromLocal(flow, steps);

  const body = buildScriptPublishBody({
    flow,
    steps,
    version: "1.0.0",
    packageKey: "fixture.facebook.draft",
    assets: [{ path: asset, sha256: "c".repeat(64), kind: "roi" }],
    videoDemo: demo(flow.id),
  });

  assert.equal(body.manifest.variables[0].id, flow.variables![0].id);
  assert.equal(body.manifest.steps[0].variableId, undefined);
  assert.equal(body.manifest.steps[1].variableId, flow.variables![0].id);
  assert.deepEqual(
    (body.manifest.steps[0].target as { ocr: unknown }).ocr,
    steps[0].payload.target!.ocr,
  );
  assert.equal((body.manifest.steps[0].target as { matchTo: string }).matchTo, "top");
  assert.deepEqual(body.manifest.default_pattern?.values, flow.defaultPattern?.values);

  const imported = importScriptRelease({
    ...body,
    content_digest: "d".repeat(64),
  } as unknown as Record<string, unknown>);
  assert.equal(imported.incomplete, false);
  assert.ok(imported.flowPayload);

  const materialized = materializeScriptRelease({
    release: {
      ...body,
      content_digest: "d".repeat(64),
    } as unknown as Record<string, unknown>,
    existing: null,
    existingSteps: [],
    validatePayload,
  });
  assert.equal(materialized.ok, true);
  if (!materialized.ok) return;

  const after = canonicalExecutionFromLocal(materialized.flow, materialized.steps);
  assert.equal(executionEqual(before, after), true);

  // Persist into a real temp SQLite and re-read.
  const dir = mkdtempSync(path.join(tmpdir(), "rpa-sync-rt-"));
  dirs.push(dir);
  const file = path.join(dir, "creator.sqlite");
  const store = new Store(file);
  writeFileSync(path.join(dir, asset), Buffer.from("png"));
  store.db.exec("BEGIN");
  try {
    for (const step of materialized.inserts) {
      store.db
        .prepare("INSERT INTO steps VALUES(?,?,?)")
        .run(step.id, step.version, JSON.stringify(step));
    }
    store.saveFlow(materialized.flow);
    store.db.exec("COMMIT");
  } catch (e) {
    store.db.exec("ROLLBACK");
    throw e;
  }
  const reloadedFlow = store.flows().find((f) => f.id === flow.id)!;
  const reloadedSteps = store
    .steps()
    .filter((s) => reloadedFlow.steps.some((r) => r.id === s.id && r.version === s.version));
  const fromDb = canonicalExecutionFromLocal(reloadedFlow, reloadedSteps);
  assert.equal(executionEqual(before, fromDb), true);
  store.close();
});

test("import refuses to overwrite a divergent local step version", () => {
  const { flow, steps, asset } = desktopLikeFixture();
  const body = buildScriptPublishBody({
    flow,
    steps,
    version: "1.0.0",
    packageKey: "fixture.facebook.draft",
    assets: [{ path: asset, sha256: "c".repeat(64), kind: "roi" }],
    videoDemo: demo(flow.id),
  });
  const localSteps: Step[] = [
    {
      ...steps[0],
      payload: {
        ...steps[0].payload,
        target: {
          ...steps[0].payload.target!,
          // Divergent: Match To kept but OCR stripped (the historical sync bug).
          ocr: undefined,
          matchTo: "top",
        },
      },
    },
    steps[1],
  ];
  // Local broken version would fail validatePayload — compare still conflicts on OCR.
  const result = materializeScriptRelease({
    release: body as unknown as Record<string, unknown>,
    existing: flow,
    existingSteps: localSteps,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "version_conflict");
});

test("import rejects packages that omit Variable id (no invented var-N-key)", () => {
  const release = importScriptRelease({
    package_key: "legacy",
    name: "Legacy",
    version: "1.0.0",
    content_digest: "e".repeat(64),
    manifest: {
      script_id: "legacy",
      variables: [{ key: "content", type: "text" }],
      steps: [{ id: "s1", version: 1, action: "SLEEP" }],
      assets: [],
    },
  });
  assert.equal(release.incomplete, true);
  assert.ok(release.incomplete_reasons.includes("missing_variable_id"));
  assert.equal(release.flowPayload, null);
});
