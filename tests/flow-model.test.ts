import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/main/storage.js";
import { resolvePayload, slugify } from "../src/shared/flow-model.js";
const target = {
  asset: "00000000-0000-0000-0000-000000000001.png",
  roi: { x: 10, y: 20, width: 50, height: 30 },
};
test("Default Pattern resolves Text and File/Files without a new Step version; used variables cannot be removed or retyped", () => {
  const s = new Store(":memory:");
  try {
    s.newFlow("test", 1);
    const vars = [
      { id: "t", key: "draft", type: "text" as const },
      { id: "f", key: "photo", type: "file" as const },
      { id: "fs", key: "photos", type: "files" as const },
    ];
    const values = {
      t: "first",
      f: path.resolve("image.png"),
      fs: [path.resolve("second.png")],
    };
    s.updateVariables(vars, values);
    const step = s.saveStep("type", { action: "TYPE_ONLY", variableId: "t" });
    assert.equal(step.payload.text, undefined);
    s.updateVariables(vars, { ...values, t: "edited" });
    assert.equal(s.steps().length, 1);
    assert.equal(s.step(step.id, 1).version, 1);
    assert.equal(resolvePayload(step.payload, s.flow()!).text, "edited");
    for (const id of ["f", "fs"])
      assert.equal(
        resolvePayload(
          { action: "UPLOAD_FILE", variableId: id, target },
          s.flow()!,
        ).files?.length,
        1,
      );
    assert.throws(
      () => s.updateVariables(vars.slice(1), { f: values.f, fs: values.fs }),
      /used/,
    );
    assert.throws(
      () =>
        s.updateVariables(
          [{ ...vars[0], type: "file" }, ...vars.slice(1)],
          values,
        ),
      /used/,
    );
    assert.throws(
      () =>
        resolvePayload(
          { action: "TYPE_ONLY", variableId: "missing" },
          s.flow()!,
        ),
      /Missing variable/,
    );
    assert.throws(
      () => resolvePayload({ action: "TYPE_ONLY", variableId: "f" }, s.flow()!),
      /type mismatch/,
    );
    s.updateVariables(vars, { f: values.f, fs: values.fs });
    assert.throws(
      () => resolvePayload(step.payload, s.flow()!),
      /missing Default Pattern/,
    );
  } finally {
    s.close();
  }
});
test("Vietnamese group slugs, uniqueness, complete execution order and immutable members", () => {
  const s = new Store(":memory:");
  try {
    s.newFlow("groups", 1);
    const a = s.saveStep("a", { action: "CLICK_TARGET", target }),
      b = s.saveStep("b", { action: "SCROLL", deltaY: -10 }),
      c = s.saveStep("c", { action: "SCROLL", deltaY: -20 });
    const o = s.saveOverride(a.id, 1, "override", [a.payload]);
    assert.equal(slugify("Đăng bài Tiếng Việt!"), "dang-bai-tieng-viet");
    const g = {
      id: "g",
      name: "Đăng bài",
      slug: slugify("Đăng bài"),
      collapsed: false,
      stepIds: [a.id, b.id],
    };
    s.organize([g], [a.id, b.id, c.id]);
    s.organize(
      [{ ...g, name: "Renamed", collapsed: true }],
      [c.id, a.id, b.id],
    );
    assert.equal(s.flow()!.groups![0].slug, "dang-bai");
    assert.deepEqual(
      s.flow()!.steps.map((x) => x.id),
      [c.id, a.id, b.id],
    );
    assert.deepEqual(s.step(a.id, 1), a);
    assert.deepEqual(s.overrides()[0], o);
    assert.throws(
      () =>
        s.organize([g, { ...g, id: "g2", stepIds: [] }], [a.id, b.id, c.id]),
      /duplicate/,
    );
    assert.throws(() => s.organize([g], [a.id, c.id, b.id]), /order/);
    assert.throws(() => s.organize([], [a.id, b.id]), /Incomplete/);
    s.organize([{ ...g, stepIds: [a.id] }], [c.id, b.id, a.id]);
    assert.deepEqual(s.step(b.id, 1), b);
  } finally {
    s.close();
  }
});
test("legacy SQLite migration preserves every version, override, ROI, flow selection; reopening is idempotent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "creator-migrate-")),
    file = path.join(dir, "creator.sqlite");
  try {
    let s = new Store(file);
    const f = s.newFlow("legacy", 0.9);
    s.close();
    const db = new DatabaseSync(file);
    const step = {
      id: "stable",
      version: 7,
      name: "old",
      createdAt: "2025",
      payload: { action: "CLICK_AND_TYPE", text: "Nháp", target },
    };
    const override = {
      id: "override",
      stepId: step.id,
      baseVersion: 7,
      name: "old override",
      segment: [
        { action: "UPLOAD_FILE", files: [path.resolve("photo.png")], target },
      ],
    };
    db.prepare("INSERT INTO steps VALUES(?,?,?)").run(
      step.id,
      7,
      JSON.stringify(step),
    );
    db.prepare("INSERT INTO overrides VALUES(?,?,?,?)").run(
      override.id,
      step.id,
      7,
      JSON.stringify(override),
    );
    db.prepare("UPDATE flows SET payload=? WHERE id=?").run(
      JSON.stringify({
        ...f,
        variables: undefined,
        defaultPattern: undefined,
        groups: undefined,
        steps: [{ id: step.id, version: 7 }],
      }),
      f.id,
    );
    db.close();
    s = new Store(file);
    const flow = s.flow()!,
      migrated = s.step(step.id, 7),
      o = s.overrides()[0];
    assert.equal(flow.id, f.id);
    assert.equal(migrated.id, step.id);
    assert.equal(migrated.version, 7);
    assert.deepEqual(migrated.payload.target, target);
    assert.equal(resolvePayload(migrated.payload, flow).text, "Nháp");
    assert.equal(migrated.payload.text, undefined);
    assert.deepEqual(
      resolvePayload(o.segment[0], flow).files,
      override.segment[0].files,
    );
    assert.equal(o.baseVersion, 7);
    const snapshot = JSON.stringify(flow);
    s.close();
    s = new Store(file);
    assert.equal(JSON.stringify(s.flow()), snapshot);
    s.close();
  } finally {
    try {
      try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* temp dir cleanup best-effort */
    }
    } catch {
      /* Windows may keep SQLite WAL handles briefly after close */
    }
  }
});

test("defective Step does not abort schema migration; good rows convert; bad payload preserved", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "creator-rollback-")),
    file = path.join(dir, "creator.sqlite");
  try {
    const s = new Store(file),
      f = s.newFlow("bad legacy", 1);
    s.close();
    const db = new DatabaseSync(file);
    const good = {
      id: "good",
      version: 1,
      name: "good",
      createdAt: "old",
      payload: { action: "TYPE_ONLY", text: "preserved" },
    };
    const bad = { ...good, id: "bad", payload: { action: "TYPE_ONLY" } };
    for (const step of [good, bad])
      db.prepare("INSERT INTO steps VALUES(?,?,?)").run(
        step.id,
        1,
        JSON.stringify(step),
      );
    db.prepare("UPDATE flows SET payload=? WHERE id=?").run(
      JSON.stringify({
        ...f,
        steps: [
          { id: "good", version: 1 },
          { id: "bad", version: 1 },
        ],
      }),
      f.id,
    );
    // Force schema migration path again.
    db.exec("PRAGMA user_version=0");
    db.close();
    const opened = new Store(file);
    const migratedGood = opened.step("good", 1);
    assert.equal(migratedGood.payload.text, undefined);
    assert.ok(migratedGood.payload.variableId);
    assert.deepEqual(opened.step("bad", 1).payload, bad.payload);
    assert.ok(
      opened.invalidSteps().some((r) => r.stepId === "bad" && r.version === 1),
    );
    assert.throws(() => opened.assertStepExecutable("bad", 1), /Ghim version/);
    assert.doesNotThrow(() => opened.assertStepExecutable("good", 1));
    opened.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* temp dir cleanup best-effort */
    }
  }
});
