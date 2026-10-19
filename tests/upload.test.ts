import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { EventEmitter } from "node:events";
import type { Debugger } from "electron";
import {
  inspectUploadFiles,
  validateUploadFileList,
} from "../src/main/upload-files.js";
import { chooseUploadFiles } from "../src/main/file-chooser.js";
import { Store, validatePayload } from "../src/main/storage.js";

test("UPLOAD_FILE validates readable real images, count, paths, duplicates and invalid content", async () => {
  const dir = path.resolve(".local", `unit-upload-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const image = path.join(dir, "ảnh Việt.png"),
    bad = path.join(dir, "corrupt.png");
  await sharp({
    create: { width: 12, height: 10, channels: 3, background: "#a23d62" },
  })
    .png()
    .toFile(image);
  await writeFile(bad, "not an image");
  assert.equal((await inspectUploadFiles([image])).length, 1);
  for (const files of [
    [],
    ["relative.png"],
    Array(21).fill(image),
    [path.join(dir, "script.js")],
  ])
    assert.throws(() => validateUploadFileList(files));
  await assert.rejects(inspectUploadFiles([bad]), /Không dùng được/);
  await assert.rejects(
    inspectUploadFiles([path.join(dir, "missing.png")]),
    /Không dùng được/,
  );
  await assert.rejects(inspectUploadFiles([image, image]), /trùng/);
});
test("UPLOAD_FILE target/files survive version and Override without changing legacy steps", () => {
  const store = new Store(":memory:");
  store.newFlow("Upload", 1);
  const target = {
    asset: "00000000-0000-0000-0000-000000000001.png",
    roi: { x: 100, y: 300, width: 360, height: 60 },
  };
  const file = path.resolve(".local", "photo.png");
  assert.throws(
    () => validatePayload({ action: "UPLOAD_FILE", target }),
    /UPLOAD_FILE/,
  );
  assert.throws(
    () => validatePayload({ action: "UPLOAD_FILE", files: [file] }),
    /target|ảnh/,
  );
  try {
    const legacy = store.saveStep("Type", {
      action: "TYPE_ONLY",
      text: "draft",
    });
    const v1 = store.saveStep("Upload", {
      action: "UPLOAD_FILE",
      target,
      files: [file],
      method: "auto",
    });
    const v2 = store.saveStep(
      "Upload",
      { ...v1.payload, files: [file, path.resolve(".local", "second.png")] },
      v1.id,
    );
    const override = store.saveOverride(v1.id, 1, "Other image", [v2.payload]);
    assert.deepEqual(store.step(v1.id, 1), v1);
    assert.deepEqual(store.step(legacy.id, 1), legacy);
    assert.equal(v2.version, 2);
    assert.equal(override.segment[0].files!.length, 2);
  } finally {
    store.close();
  }
});
function fakeDebugger() {
  const api = new EventEmitter() as EventEmitter & {
    isAttached: () => boolean;
    attach: () => void;
    sendCommand: (method: string, params?: unknown) => Promise<unknown>;
  };
  const commands: { method: string; params: any }[] = [];
  api.isAttached = () => true;
  api.attach = () => {};
  api.sendCommand = async (method, params) => {
    commands.push({ method, params });
    return {};
  };
  return { api, commands, debuggerApi: api as unknown as Debugger };
}
test("chooser selects only the event backend id, clicks once, and disables interception", async () => {
  const { api, commands, debuggerApi } = fakeDebugger();
  let clicks = 0;
  const result = await chooseUploadFiles(
    debuggerApi,
    ["one.png", "two.png"],
    () => {
      clicks++;
      queueMicrotask(() =>
        api.emit(
          "message",
          {},
          "Page.fileChooserOpened",
          { mode: "selectMultiple", backendNodeId: 42 },
          "",
        ),
      );
    },
    100,
  );
  assert.equal(clicks, 1);
  assert.equal(result.assignedCount, 2);
  assert.equal(result.preview, "unverified");
  assert.deepEqual(
    commands.find((c) => c.method === "DOM.setFileInputFiles")!.params,
    { files: ["one.png", "two.png"], backendNodeId: 42 },
  );
  assert.deepEqual(commands.at(-1), {
    method: "Page.setInterceptFileChooserDialog",
    params: { enabled: false },
  });
  assert.equal(api.listenerCount("message"), 0);
  assert.equal(api.listenerCount("detach"), 0);
});
test("chooser refuses multi files on single picker and missing backend id; timeout cleans up", async () => {
  for (const params of [
    { mode: "selectSingle", backendNodeId: 1 },
    { mode: "selectMultiple" },
  ]) {
    const { api, commands, debuggerApi } = fakeDebugger();
    await assert.rejects(
      chooseUploadFiles(
        debuggerApi,
        ["one.png", "two.png"],
        () => {
          queueMicrotask(() =>
            api.emit("message", {}, "Page.fileChooserOpened", params, ""),
          );
        },
        100,
      ),
    );
    assert.equal(
      commands.some((c) => c.method === "DOM.setFileInputFiles"),
      false,
    );
    assert.equal(api.listenerCount("message"), 0);
    assert.equal(commands.at(-1)!.params.enabled, false);
  }
  const { api, commands, debuggerApi } = fakeDebugger();
  await assert.rejects(
    chooseUploadFiles(debuggerApi, ["one.png"], () => {}, 10),
    /Không nhận được file chooser/,
  );
  assert.equal(api.listenerCount("message"), 0);
  assert.equal(commands.at(-1)!.params.enabled, false);
});
