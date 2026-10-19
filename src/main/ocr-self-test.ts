import { fixtureUi } from "./fixture-ui.js";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { BrowserWindow } from "electron";
import type { BrowserCore } from "./browser-core.js";
import type { Store } from "./storage.js";
import type { Runtime } from "./runtime.js";
import { localOcr } from "./ocr.js";

// DOM instrumentation is confined to this test shell and local fixture.
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
  const ui = fixtureUi(window);
  const evaluate = (code: string) => ui.executeJavaScript(code);
  const wait = (ms = 100) => new Promise((r) => setTimeout(r, ms));
  const until = async (check: () => Promise<unknown>, label: string) => {
    const end = Date.now() + 40000;
    while (!(await check())) {
      if (Date.now() > end) throw Error("OCR UI timeout: " + label);
      await wait();
    }
  };
  const click = async (text: string) => {
    const p = await evaluate(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(text)}));if(!b)throw Error('Missing button: '+${JSON.stringify(text)});b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),disabled:b.disabled}})()`,
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
          `document.querySelector('[role=status]')?.textContent!=='Đang xử lý…'`,
        ),
      text,
    );
  };
  const crop = async (x: number, y: number, width: number, height: number) => {
    await click("Chụp & crop ROI");
    await until(
      () => evaluate(`!!document.querySelector('.snapshot')`),
      "snapshot",
    );
    const p = await evaluate(
      `(()=>{const r=document.querySelector('.snapshot').getBoundingClientRect();return{x:r.x,y:r.y}})()`,
    );
    ui.sendInputEvent({
      type: "mouseDown",
      x: p.x + x,
      y: p.y + y,
      button: "left",
      clickCount: 1,
    });
    ui.sendInputEvent({
      type: "mouseMove",
      x: p.x + x + width,
      y: p.y + y + height,
      button: "left",
    });
    ui.sendInputEvent({
      type: "mouseUp",
      x: p.x + x + width,
      y: p.y + y + height,
      button: "left",
      clickCount: 1,
    });
    await until(
      () => evaluate(`!!document.querySelector('.roi')`),
      "ROI drawn",
    );
    await click("Dùng ROI");
  };
  window.show();
  window.focus();
  window.setAlwaysOnTop(true);
  await browser.navigate("http://127.0.0.1:47834/ocr");
  await wait(300);
  await until(
    () => evaluate(`!!document.querySelector('#roi-flow-help')`),
    "mounted",
  );
  await click("Tạo flow");
  await crop(100, 110, 360, 64);
  assert.ok(
    await evaluate(
      `document.querySelector('.ocr-candidates')?.textContent.includes('Tạo bài viết')`,
    ),
  );
  assert.equal(
    await evaluate(
      `document.querySelectorAll('.ocr-candidate[aria-pressed=true]').length`,
    ),
    0,
  );
  await click("Lưu Base v1");
  const id = store.flow()!.steps[0].id;
  assert.equal(store.step(id, 1).payload.target!.ocr, undefined);
  pass("Vietnamese-ROI-real-local-OCR-no-automatic-selection-image-only-save");
  await click("Đọc lại OCR");
  await click("Tạo bài viết");
  await click("Lưu redesign");
  assert.equal(store.step(id, 2).payload.target!.ocr!.text, "Tạo bài viết");
  assert.equal(store.step(id, 1).payload.target!.ocr, undefined);
  const [clicked] = await runtime.test(id, 2);
  assert.equal(clicked.status, "ACTION_SENT", clicked.message);
  const probe =
    await browser.view.webContents.executeJavaScript("window.ocrProbe");
  assert.equal(probe.id, "vi");
  assert.equal(probe.clicks, 1);
  assert.ok(probe.x > 100 && probe.x < 460 && probe.y > 110 && probe.y < 174);
  pass(
    "confirmed-Vietnamese-version2-AUTO-image-click-ACTION_SENT-base-v1-retained",
  );
  const verify = store.saveStep("verify", {
    ...store.step(id, 2).payload,
    action: "WAIT_VERIFY",
    timeoutMs: 100,
  });
  assert.equal((await runtime.test(verify.id, 1))[0].status, "VERIFIED");
  pass("WAIT_VERIFY-uses-same-OCR-runtime-and-verifies-only-target-presence");
  const original = localOcr.recognize.bind(localOcr);
  await browser.view.webContents.executeJavaScript(
    "document.querySelector('#vi').style.background='#c2d2e8'",
  );
  try {
    for (const mode of ["low", "duplicate", "failure"]) {
      localOcr.recognize = async (image) => {
        if (mode === "failure") throw Error("fixture OCR failure");
        const result = await original(image);
        return {
          ...result,
          segments:
            mode === "low"
              ? result.segments.map((s) => ({ ...s, confidence: 20 }))
              : [...result.segments, ...result.segments],
        };
      };
      assert.equal((await runtime.test(id, 2))[0].status, "BLOCKED");
      assert.equal(
        (await browser.view.webContents.executeJavaScript("window.ocrProbe"))
          .clicks,
        1,
      );
    }
  } finally {
    localOcr.recognize = original;
  }
  pass(
    "runtime-blocks-weak-image-plus-low-confidence-duplicate-text-or-OCR-failure-before-click",
  );
  await click("Tạo flow");
  await crop(100, 260, 360, 64);
  await click("Create post");
  await click("Lưu Base v1");
  const english = store.flow()!.steps[0];
  assert.equal((await runtime.test(english.id, 1))[0].status, "ACTION_SENT");
  assert.equal(
    (await browser.view.webContents.executeJavaScript("window.ocrProbe")).id,
    "en",
  );
  pass("English-ROI-explicit-selection-save-and-real-AUTO-runtime-click");
  // Exercise the real Test button, result review IPC and live browser continuity.
  const page = browser.view.webContents;
  const originalCapture = browser.capture.bind(browser);
  let captures = 0;
  browser.capture = async () => {
    captures++;
    return originalCapture();
  };
  try {
    await click("Test step đã lưu");
  } finally {
    browser.capture = originalCapture;
  }
  assert.equal(
    captures,
    1,
    "only recognition screenshot, no post-click screenshot",
  );
  assert.equal(
    await page.executeJavaScript("document.activeElement.id"),
    "live-draft",
  );
  assert.equal(
    page.isFocused(),
    true,
    "live browser keeps native focus after click",
  );
  assert.equal(browser.visible, true);
  assert.equal(await evaluate("!!document.querySelector('.snapshot')"), false);
  assert.match(
    await evaluate("document.querySelector('.result').textContent"),
    /ACTION_SENT/,
  );
  assert.match(
    await evaluate("document.querySelector('.match-detail').textContent"),
    /Image Matching/s,
  );
  // Explicit test evidence only: compose shell + native view after focus assertions.
  await evaluate(
    "document.querySelector('.result').scrollIntoView({block:'start'})",
  );
  await wait();
  await sharp((await ui.capturePage()).toPNG())
    .composite([
      {
        input: browser.captureBuffer((await browser.capture()).id),
        left: browser.bounds.x,
        top: browser.bounds.y,
      },
    ])
    .png()
    .toFile(path.join(project, "artifacts", "debug-live-review.png"));
  const url = page.getURL();
  const clicks = (await page.executeJavaScript("window.ocrProbe")).clicks;
  await click("Đúng — Hoàn thành Step");
  assert.match(
    await evaluate("document.querySelector('.result').textContent"),
    /VERIFIED/,
  );
  const reviewed = JSON.parse(
    (
      store.db
        .prepare("SELECT payload FROM runs ORDER BY rowid DESC LIMIT 1")
        .get() as { payload: string }
    ).payload,
  );
  assert.equal(reviewed.review.by, "user");
  await click("Ảnh trước");
  assert.match(
    await evaluate("document.querySelector('.snapshot img').src"),
    /^data:image\/png;base64,/,
  );
  await click("Quay lại browser");
  await assert.rejects(
    runtime.review(reviewed.id, "incorrect"),
    /không còn chờ/,
  );
  await click("Tạo Step tiếp theo từ browser hiện tại");
  assert.equal(page.getURL(), url);
  assert.equal(
    (await page.executeJavaScript("window.ocrProbe")).clicks,
    clicks,
  );
  assert.ok(
    await page.executeJavaScript("!!document.querySelector('#live-draft')"),
  );
  assert.match(
    await evaluate(`document.querySelector('[aria-label="Step Editor"]').textContent`),
    /Lưu Base v1/,
  );
  pass(
    "live-click-focus-preserved-user-confirms-VERIFIED-and-next-step-without-reset-or-replay",
  );
  // New Step retains page state; image matching is explicitly identified even with OCR available.
  await crop(100, 260, 360, 64);
  await click("Lưu Base v1");
  const imageRef = store.flow()!.steps.at(-1)!;
  const base = store.step(imageRef.id, 1);
  await click("Test step đã lưu");
  assert.match(
    await evaluate("document.querySelector('.match-detail').textContent"),
    /Image Matching/s,
  );
  assert.ok(
    await evaluate(
      "!!document.querySelector('img[alt=\"Ảnh target đã dùng khi test\"]')",
    ),
  );
  const stale = JSON.parse(
    (
      store.db
        .prepare("SELECT payload FROM runs ORDER BY rowid DESC LIMIT 1")
        .get() as { payload: string }
    ).payload,
  );
  await click("Test step đã lưu");
  await assert.rejects(runtime.review(stale.id, "correct"), /mới nhất/);
  await click("Sai — Redesign Step");
  assert.match(
    await evaluate("document.querySelector('.result').textContent"),
    /REJECTED/,
  );
  assert.deepEqual(store.step(imageRef.id, 1), base);
  assert.equal(store.steps().filter((s) => s.id === imageRef.id).length, 1);
  await click("Lưu redesign");
  assert.equal(store.step(imageRef.id, 2).id, imageRef.id);
  assert.deepEqual(store.step(imageRef.id, 1), base);
  assert.equal(page.getURL(), url);
  assert.ok(
    await page.executeJavaScript("!!document.querySelector('#live-draft')"),
  );
  pass(
    "image-method-explicit-stale-review-blocked-reject-keeps-Base-redesign-appends-v2-live-page-retained",
  );
  await click("Tạo flow");
  try {
    localOcr.recognize = async () => {
      throw Error("fixture missing model");
    };
    await crop(550, 110, 80, 80);
  } finally {
    localOcr.recognize = original;
  }
  assert.match(
    await evaluate(`document.querySelector('.ocr-panel').textContent`),
    /fixture missing model/,
  );
  await click("Lưu Base v1");
  assert.equal(
    store.step(store.flow()!.steps[0].id, 1).payload.target!.ocr,
    undefined,
  );
  pass("OCR-service-error-displayed-and-icon-image-only-target-still-saves");
  await ui
    .capturePage()
    .then((i) =>
      writeFile(path.join(project, "artifacts", "ocr-editor.png"), i.toPNG()),
    );
  await mkdir(path.join(project, "artifacts"), { recursive: true });
  await writeFile(
    path.join(project, "artifacts", "browser-ocr.json"),
    JSON.stringify(
      {
        phase: "ocr",
        timestamp: new Date().toISOString(),
        status: "passed",
        passedCount: entries.length,
        pendingCount: 0,
        entries,
        facebookTested: false,
        fixtureOnly: true,
      },
      null,
      2,
    ),
  );
}
