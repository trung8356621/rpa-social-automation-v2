import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { dialog, type BrowserWindow } from "electron";
import type { BrowserCore } from "./browser-core.js";
import type { Store } from "./storage.js";
import type { Runtime } from "./runtime.js";
import type { Result } from "../shared/contracts.js";

// Fixture DOM reads only measure real file selection/network/decoded previews.
export async function runSelfTest({
  browser,
  store,
  runtime,
  window,
  project,
}: {
  browser: BrowserCore;
  store: Store;
  runtime: Runtime;
  window: BrowserWindow;
  project: string;
}) {
  const entries: string[] = [];
  const pass = (name: string) => {
    entries.push(name);
    console.log("PASS", name);
  };
  const wait = (ms = 100) => new Promise((r) => setTimeout(r, ms));
  const ui = window.webContents,
    page = browser.view.webContents;
  const evaluate = (code: string) => ui.executeJavaScript(code);
  const probe = () => page.executeJavaScript("window.uploadRead()");
  const until = async (check: () => Promise<unknown>, label: string) => {
    const end = Date.now() + 15000;
    while (!(await check())) {
      if (Date.now() > end) throw Error("Upload timeout " + label);
      await wait();
    }
  };
  const click = async (text: string) => {
    const p = await evaluate(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(text)}));if(!b)throw Error('Missing button '+${JSON.stringify(text)});b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),disabled:b.disabled}})()`,
    );
    assert.equal(p.disabled, false, text);
    ui.focus();
    for (const type of ["mouseDown", "mouseUp"] as const)
      ui.sendInputEvent({
        type,
        x: p.x,
        y: p.y,
        button: "left",
        clickCount: 1,
      });
    await wait(200);
    await until(
      () =>
        evaluate(
          `document.querySelector('[role=status]')?.textContent !== 'Đang xử lý…'`,
        ),
      text,
    );
  };
  const fresh = async (query = "") => {
    await browser.navigate(`http://127.0.0.1:47836/upload${query}`);
    await wait(250);
  };
  window.show();
  window.focus();
  window.setAlwaysOnTop(true);
  const dir = path.join(project, ".local", `upload-fixtures-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const png = await sharp({
    create: { width: 80, height: 60, channels: 3, background: "#d72262" },
  })
    .png()
    .toBuffer();
  const png2 = await sharp({
    create: { width: 72, height: 54, channels: 3, background: "#24a36b" },
  })
    .png()
    .toBuffer();
  const files = [path.join(dir, "ảnh một.png"), path.join(dir, "ảnh hai.png")];
  await writeFile(files[0], png);
  await writeFile(files[1], png2);
  await fresh();
  await until(() => evaluate("!!window.creator"), "preload");
  await click("Tạo flow");
  await evaluate(
    `(()=>{const s=document.querySelector('[aria-label="Action"]');s.value='UPLOAD_FILE';s.dispatchEvent(new Event('change',{bubbles:true}))})()`,
  );
  await wait();
  const originalDialog = dialog.showOpenDialog;
  Object.assign(dialog, {
    showOpenDialog: async (...args: unknown[]) => {
      assert.equal(args[0], window);
      const options = args[1] as { properties: string[] };
      assert.ok(options.properties.includes("multiSelections"));
      return { canceled: false, filePaths: [files[0]] };
    },
  });
  try {
    await click("Chọn ảnh local");
  } finally {
    dialog.showOpenDialog = originalDialog;
  }
  assert.match(
    await evaluate(
      "document.querySelector('[aria-label=\"Ảnh upload\"]').textContent",
    ),
    /ảnh một.png/,
  );
  await click("Chụp & crop ROI");
  await until(() => evaluate("!!document.querySelector('.snapshot')"), "crop");
  const r = await evaluate(
    "(()=>{const r=document.querySelector('.snapshot').getBoundingClientRect();return{x:r.x,y:r.y}})()",
  );
  ui.sendInputEvent({
    type: "mouseDown",
    x: r.x + 100,
    y: r.y + 300,
    button: "left",
    clickCount: 1,
  });
  ui.sendInputEvent({
    type: "mouseMove",
    x: r.x + 460,
    y: r.y + 360,
    button: "left",
  });
  ui.sendInputEvent({
    type: "mouseUp",
    x: r.x + 460,
    y: r.y + 360,
    button: "left",
    clickCount: 1,
  });
  await until(() => evaluate("!!document.querySelector('.roi')"), "ROI");
  await click("Dùng ROI");
  await click("Lưu Base v1");
  const id = store.flow()!.steps[0].id,
    base = store.step(id, 1);
  assert.equal(base.payload.action, "UPLOAD_FILE");
  assert.equal(base.payload.files!.length, 1);
  const debuggerApi = page.debugger,
    listenerCount = debuggerApi.listenerCount("message");
  await click("Test step đã lưu");
  await until(
    async () => (await probe()).loaded === 1,
    "one decoded thumbnail",
  );
  let current = await probe();
  assert.equal(current.clicks, 1);
  assert.equal(current.changes, 1);
  assert.equal(current.trusted, true);
  assert.equal(
    current.received[0].hash,
    createHash("sha256").update(png).digest("hex"),
  );
  assert.equal(current.images[0].width, 80);
  assert.equal(current.images[0].height, 60);
  assert.equal(debuggerApi.listenerCount("message"), listenerCount);
  let result = JSON.parse(
    (
      store.db
        .prepare("SELECT payload FROM runs ORDER BY rowid DESC LIMIT 1")
        .get() as { payload: string }
    ).payload,
  ) as Result;
  assert.equal(result.status, "ACTION_SENT");
  assert.equal(result.upload!.preview, "unverified");
  assert.equal(result.upload!.assignedCount, 1);
  await assert.rejects(runtime.review(result.id, "correct"), /preview/);
  await click("Đã thấy đủ preview");
  assert.match(
    await evaluate("document.querySelector('.result').textContent"),
    /VERIFIED/,
  );
  pass(
    "Action-first-upload-visual-click-real-chooser-real-image-POST-decoded-thumbnail-manual-review-required",
  );
  await fresh();
  const multiple = store.saveStep("Multiple", { ...base.payload, files }, id);
  const [many] = await runtime.test(id, multiple.version);
  await until(async () => (await probe()).loaded === 2, "multiple thumbnails");
  current = await probe();
  assert.equal(current.clicks, 1);
  assert.equal(current.changes, 1);
  assert.equal(current.received.length, 2);
  assert.deepEqual(
    current.images.map((i: { width: number; height: number }) => [
      i.width,
      i.height,
    ]),
    [
      [80, 60],
      [72, 54],
    ],
  );
  assert.equal(many.upload!.chooserMode, "selectMultiple");
  assert.equal(many.upload!.assignedCount, 2);
  assert.equal(many.status, "ACTION_SENT");
  assert.deepEqual(store.step(id, 1), base);
  pass(
    "multiple-files-one-chooser-one-click-real-server-bytes-and-two-decoded-previews-v1-retained",
  );
  ui.reload();
  await until(
    () =>
      evaluate(
        "document.querySelector('.step')?.textContent.includes('Multiple')",
      ),
    "reopen saved upload version",
  );
  await click("Multiple");
  assert.match(
    await evaluate(
      "document.querySelector('[aria-label=\"Ảnh upload\"]').textContent",
    ),
    /ảnh hai.png/,
  );
  await fresh();
  const longText = "Bản nháp tiếng Việt rất dài 👋 — không xuất bản.\n"
    .repeat(70)
    .trimEnd();
  browser.click(180, 110);
  await wait();
  await browser.typeOnly(longText, "keyboard");
  assert.equal((await probe()).text, longText);
  ui.focus();
  await wait();
  const [afterText] = await runtime.test(id, multiple.version);
  await until(
    async () => (await probe()).loaded === 2,
    "previews after long text",
  );
  assert.equal((await probe()).text, longText);
  assert.equal((await probe()).clicks, 1);
  assert.equal(afterText.status, "ACTION_SENT");
  ui.send("creator:shortcut-result", [afterText]);
  await wait(200);
  await sharp((await ui.capturePage()).toPNG())
    .composite([
      {
        input: browser.captureBuffer(afterText.after!.id),
        left: browser.bounds.x,
        top: browser.bounds.y,
      },
    ])
    .png()
    .toFile(path.join(project, "artifacts", "upload-after-long-text.png"));
  pass(
    "upload-two-images-after-real-long-keyboard-draft-preserves-text-and-toolbar-preview",
  );
  await fresh("?no-preview");
  store.selectVersion(id, 1);
  const [noPreview] = await runtime.test(id, 1);
  await until(
    async () => (await probe()).received.length === 1,
    "server received no-preview case",
  );
  assert.equal((await probe()).loaded, 0);
  assert.equal(noPreview.status, "ACTION_SENT");
  assert.equal(noPreview.upload!.preview, "unverified");
  await assert.rejects(runtime.review(noPreview.id, "correct"), /preview/);
  pass(
    "file-chooser-and-server-acceptance-without-thumbnail-never-auto-VERIFIED",
  );
  await fresh("?single");
  const [single] = await runtime.test(id, multiple.version);
  assert.equal(single.status, "FAILED");
  assert.equal(single.upload!.assignedCount, 0);
  assert.equal((await probe()).changes, 0);
  assert.ok(single.after);
  assert.equal(debuggerApi.listenerCount("message"), listenerCount);
  pass(
    "single-file-picker-rejects-multiple-files-without-truncation-and-records-screenshot",
  );
  await fresh("?modal");
  const [modal] = await runtime.test(id, 1);
  assert.equal(modal.status, "FAILED");
  assert.match(modal.message, /modal/);
  assert.ok(modal.after);
  assert.equal((await probe()).clicks, 1);
  assert.equal((await probe()).changes, 0);
  assert.equal(debuggerApi.listenerCount("message"), listenerCount);
  await writeFile(
    path.join(project, "artifacts", "upload-modal.png"),
    browser.captureBuffer(modal.after!.id),
  );
  pass(
    "extra-modal-times-out-with-one-click-screenshot-description-and-interception-cleanup-no-global-handler",
  );
  await fresh();
  const missing = store.saveStep(
    "Missing file",
    { ...base.payload, files: [path.join(dir, "missing.png")] },
    id,
  );
  const [blocked] = await runtime.test(id, missing.version);
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.clickSent, false);
  assert.equal((await probe()).clicks, 0);
  pass("missing-file-blocks-before-visual-click-or-chooser");
  const overlay = store.saveOverride(id, 1, "Two images", [multiple.payload]);
  const [overridden] = await runtime.test(id, 1, overlay.id);
  await until(async () => (await probe()).loaded === 2, "override previews");
  assert.equal(overridden.source, "override");
  assert.equal(overridden.upload!.assignedCount, 2);
  assert.deepEqual(store.step(id, 1), base);
  pass("upload-Override-uses-same-runtime-without-overwriting-Base");
  await writeFile(
    path.join(project, "artifacts", "browser-upload.json"),
    JSON.stringify(
      {
        phase: "upload",
        timestamp: new Date().toISOString(),
        status: "passed",
        passedCount: entries.length,
        pendingCount: 0,
        entries,
        fixtureOnly: true,
        facebookTested: false,
        creatorPickerDialog: "stubbed selection; real IPC and validation",
        browserChooser: "real CDP event and backendNodeId",
        preview: "real POST and decoded server image",
      },
      null,
      2,
    ),
  );
}
