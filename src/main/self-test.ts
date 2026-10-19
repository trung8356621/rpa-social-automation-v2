import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { BrowserWindow } from "electron";
import { BrowserCore } from "./browser-core.js";
import { Store } from "./storage.js";
import { Runtime } from "./runtime.js";
import type { Rect } from "../shared/contracts.js";
import { WEB_HEIGHT } from "../shared/geometry.js";
const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));
export async function runSelfTest(ctx: {
  browser: BrowserCore;
  store: Store;
  runtime: Runtime;
  assetDir: string;
  project: string;
  phase: string;
  window: BrowserWindow;
}) {
  const { browser, store, runtime, assetDir, project, phase, window } = ctx;
  // Windows STARTUPINFO from windowsHide can suppress the first ShowWindow call.
  window.show();
  window.focus();
  await wait(300);
  if (!window.isVisible()) {
    window.show();
    await wait(300);
  }
  window.contentView.addChildView(browser.view);
  browser.setVisible(true);
  browser.view.webContents.focus();
  await wait(500);
  console.log(
    "TEST_WINDOW",
    JSON.stringify({
      visible: window.isVisible(),
      minimized: window.isMinimized(),
      bounds: window.getBounds(),
      view: browser.view.getBounds(),
      url: browser.view.webContents.getURL(),
      focused: browser.view.webContents.isFocused(),
    }),
  );
  console.log(
    "TEST_RENDER",
    await browser.view.webContents.executeJavaScript(
      "JSON.stringify({visible:document.visibilityState, width:innerWidth,height:innerHeight,ready:document.readyState})",
    ),
  );
  const entries: { name: string; passed: boolean; [key: string]: unknown }[] =
    [];
  const passed = (name: string, detail?: unknown) => {
    entries.push({ name, passed: true, detail });
    console.log("PASS", name);
  };
  // Fixture-only DOM instrumentation for assertions; no production resolver reads DOM.
  const probe = () =>
    browser.view.webContents.executeJavaScript("window.fixtureRead()");
  await mkdir(path.join(project, "artifacts"), { recursive: true });
  assert.equal(window.isResizable(), false);
  assert.equal(window.isMaximizable(), true);
  assert.equal(window.isFullScreenable(), true);
  passed("fixed-window", window.getContentSize());
  if (phase === "second") {
    const p = await probe();
    assert.equal(p.local, "persist-across-process");
    assert.match(p.cookie, /poc-session=persistent/);
    assert.ok(store.flow()?.steps.length);
    assert.ok(store.steps().some((s) => s.version === 2));
    assert.ok(store.overrides().length);
    passed("session-and-sqlite-survive-process-restart", p);
    const all = store.steps();
    assert.notDeepEqual(
      all.find((s) => s.version === 1)?.payload,
      all.find((s) => s.version === 2)?.payload,
    );
    passed("immutable-step-versions-reopened");
  } else {
    store.newFlow("Browser integration POC", 1);
    for (const zoom of [1, 0.9, 0.8]) {
      browser.setZoom(zoom);
      await wait();
      const p = await probe();
      assert.ok(p.width >= 1024);
      assert.ok(Math.abs(p.width - 1024 / zoom) < 2);
      const shot = await browser.capture();
      const metadata = await sharp(browser.captureBuffer(shot.id)).metadata();
      assert.equal(metadata.width, 1024);
      assert.equal(metadata.height, WEB_HEIGHT);
      browser.click(270 * zoom, 152 * zoom);
      await wait();
      const clicked = await probe();
      assert.ok(Math.abs(clicked.x - 270) < 2);
      assert.ok(Math.abs(clicked.y - 152) < 2);
      passed(`capture-click-zoom-${zoom}`, clicked);
      const focusless = await browser.typeOnly("blocked?").then(
        () => true,
        () => false,
      ); // Browser has focus, but button is active: no input focus is manufactured.
      assert.equal(focusless, true);
      assert.equal((await probe()).text, "");
      passed(`type-does-not-focus-textarea-${zoom}`);
      browser.click(200 * zoom, 270 * zoom);
      await wait();
      await browser.typeOnly("Nháp tiếng Việt 👋");
      await wait();
      assert.equal((await probe()).text, "Nháp tiếng Việt 👋");
      passed(`keyboard-existing-focus-${zoom}`);
      await browser.view.webContents.executeJavaScript(
        "document.querySelector('#draft').value=''",
      );
    }
    browser.setZoom(1);
    await wait();
    window.webContents.focus();
    await wait();
    await assert.rejects(browser.typeOnly("must not refocus"), /focus/);
    passed("type-refuses-editor-focus");
    window.setAlwaysOnTop(true);
    window.show();
    window.focus();
    browser.view.webContents.focus();
    await wait();
    await browser.capture();
    entries.push({
      name: "capture-preserves-browser-focus",
      passed: browser.view.webContents.isFocused(),
      limitation: !browser.view.webContents.isFocused(),
    });
    const before = await browser.capture();
    const roi: Rect = { x: 120, y: 120, width: 300, height: 64 };
    const asset = "00000000-0000-0000-0000-000000000001.png";
    await writeFile(
      path.join(assetDir, asset),
      await sharp(browser.captureBuffer(before.id))
        .extract({
          left: roi.x,
          top: roi.y,
          width: roi.width,
          height: roi.height,
        })
        .png()
        .toBuffer(),
    );
    const target = { asset, roi };
    const step = store.saveStep("Composer", { action: "CLICK_TARGET", target });
    const result = await runtime.test(step.id, 1);
    assert.equal(result[0].ok, true);
    assert.equal(result[0].status, "ACTION_SENT");
    assert.equal(result[0].before!.width, 1024);
    passed(
      "same-runtime-crop-match-click",
      result.map((r) => ({ ok: r.ok, match: r.match })),
    );
    const v2 = store.saveStep(
      "Composer redesigned",
      { action: "WAIT_VERIFY", target, timeoutMs: 1000 },
      step.id,
    );
    assert.equal(v2.id, step.id);
    assert.equal(v2.version, 2);
    assert.equal(store.step(step.id, 1).payload.action, "CLICK_TARGET");
    passed("append-only-v2-keeps-v1");
    const override = store.saveOverride(step.id, 1, "fixture context", [
      { action: "WAIT_VERIFY", target, timeoutMs: 1000 },
    ]);
    assert.equal(
      (await runtime.test(step.id, 1, override.id))[0].source,
      "override",
    );
    assert.equal(store.step(step.id, 1).payload.action, "CLICK_TARGET");
    await assert.rejects(runtime.test(step.id, 2, override.id), /Base version/);
    passed("override-does-not-overwrite-base-and-rejects-stale");
    const clicksBeforeMismatch = (await probe()).clicks;
    await browser.view.webContents.executeJavaScript(
      "document.querySelector('#composer').style.left='600px'",
    );
    await wait();
    const mismatch = await runtime.test(step.id, 1);
    assert.equal(mismatch[0].ok, false);
    assert.equal((await probe()).clicks, clicksBeforeMismatch);
    passed("target-mismatch-does-not-click");
    await browser.view.webContents.executeJavaScript(
      "document.querySelector('#composer').style.left='120px'",
    );
    await wait();
    browser.setVisible(false);
    try {
      const hidden = await browser.capture();
      await writeFile(
        path.join(project, "artifacts", "hidden-capture.png"),
        browser.captureBuffer(hidden.id),
      );
      assert.ok(
        (await sharp(browser.captureBuffer(hidden.id)).stats()).channels[0]
          .stdev > 5,
      );
      passed("view-hidden-capture-nonblank");
    } catch (e) {
      entries.push({
        name: "view-hidden-capture",
        passed: false,
        limitation: true,
        error: String(e),
      });
      console.log("LIMITATION hidden view capture", String(e));
    } finally {
      browser.setVisible(true);
    }
    window.hide();
    try {
      const hiddenWindow = await browser.capture();
      assert.equal(hiddenWindow.width, 1024);
      assert.ok(
        (await sharp(browser.captureBuffer(hiddenWindow.id)).stats())
          .channels[0].stdev > 5,
      );
      await writeFile(
        path.join(project, "artifacts", "hidden-window-capture.png"),
        browser.captureBuffer(hiddenWindow.id),
      );
      passed("window-hidden-capture");
    } catch (e) {
      entries.push({
        name: "window-hidden-capture",
        passed: false,
        limitation: true,
        error: String(e),
      });
      console.log("LIMITATION hidden window capture", String(e));
    } finally {
      window.show();
      window.focus();
    }
    browser.view.webContents.focus();
    const scrollBefore = (await probe()).scrollY;
    browser.scroll(-400);
    await wait(400);
    assert.ok((await probe()).scrollY > scrollBefore);
    passed("wheel-scroll");
    await browser.view.webContents.executeJavaScript(
      "localStorage.setItem('poc-session','persist-across-process');document.cookie='poc-session=persistent; Max-Age=86400; SameSite=Lax; path=/'",
    );
    await browser.flush();
    await readFile(path.join(assetDir, asset));
    passed("target-asset-persisted");
    await browser.view.webContents.executeJavaScript("window.scrollTo(0,0)");
    await wait();
    const ui = window.webContents;
    const uiEval = (code: string) => ui.executeJavaScript(code);
    const uiWait = async (code: string) => {
      const deadline = Date.now() + 6000;
      while (!(await uiEval(code))) {
        if (Date.now() > deadline)
          throw new Error(
            `UI wait timed out: ${code}; status=${await uiEval('document.querySelector("[role=status]")?.textContent')}`,
          );
        await wait(100);
      }
    };
    const buttonPoint = async (text: string) =>
      uiEval(
        `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(text)}));if(!b)throw Error('Button missing');b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,disabled:b.disabled}})()`,
      );
    const uiClick = async (text: string) => {
      const p = await buttonPoint(text);
      assert.equal(p.disabled, false, `Button disabled: ${text}`);
      ui.focus();
      ui.sendInputEvent({
        type: "mouseDown",
        x: Math.round(p.x),
        y: Math.round(p.y),
        button: "left",
        clickCount: 1,
      });
      ui.sendInputEvent({
        type: "mouseUp",
        x: Math.round(p.x),
        y: Math.round(p.y),
        button: "left",
        clickCount: 1,
      });
      await wait(300);
      await uiWait(
        'document.querySelector("[role=status]")?.textContent !== "Đang xử lý…"',
      );
    };
    const uiSelect = async (label: string, value: string) => {
      await uiEval(
        `(()=>{const s=document.querySelector('[aria-label="${label}"]');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
      await wait();
    };
    assert.equal(await uiEval("typeof window.creator.invoke"), "function");
    passed("sandbox-preload-and-ipc-ready");
    await uiClick("Tạo");
    await uiSelect("Action", "CLICK_TARGET");
    await uiClick("Chụp & crop ROI");
    assert.equal(await uiEval('!!document.querySelector(".snapshot")'), true);
    ui.sendInputEvent({
      type: "mouseDown",
      x: 440,
      y: 208,
      button: "left",
      clickCount: 1,
    });
    ui.sendInputEvent({ type: "mouseMove", x: 740, y: 272, button: "left" });
    ui.sendInputEvent({
      type: "mouseUp",
      x: 740,
      y: 272,
      button: "left",
      clickCount: 1,
    });
    await wait();
    await uiClick("Dùng ROI");
    await uiClick("Lưu Base v1");
    assert.equal(store.flow()?.steps.length, 1);
    assert.equal(
      store.step(store.flow()!.steps[0].id, 1).payload.target?.roi.width,
      300,
    );
    passed("ui-action-first-drag-crop-save-base");
    await uiClick("Test step đã lưu");
    await uiWait('!!document.querySelector(".result")');
    assert.match(
      await uiEval('document.querySelector(".result")?.textContent || ""'),
      /ACTION_SENT/,
    );
    passed("ui-test-uses-shared-runtime");
    await uiClick("Lưu form thành Override");
    assert.ok(
      store.overrides().some((o) => o.stepId === store.flow()!.steps[0].id),
    );
    passed("ui-explicit-override");
    await uiClick("Lưu redesign");
    assert.equal(store.flow()?.steps[0].version, 2);
    passed("ui-redesign-to-v2");
    await uiSelect("Action", "TYPE_ONLY");
    await uiEval(
      `(()=>{const t=document.querySelector('[aria-label="Nội dung TYPE_ONLY"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'Bản nháp UI 👋');t.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await wait();
    await uiClick("Lưu redesign");
    assert.equal(store.flow()?.steps[0].version, 3);
    await uiClick("Test step đã lưu");
    await uiWait(
      '(document.querySelector(".result")?.textContent || "").includes("TYPE_ONLY")',
    );
    assert.match(
      await uiEval('document.querySelector(".result")?.textContent || ""'),
      /FAILED/,
    );
    passed("ui-type-only-refuses-stolen-focus");
    window.focus();
    browser.click(200, 270);
    await wait();
    assert.equal(browser.view.webContents.isFocused(), true);
    // Exercise the actual IPC/runtime while leaving browser focus intact.
    // sendInputEvent bypasses before-input-event; OS SendKeys also did not reach
    // this desktop reliably. Physical Ctrl+Shift+T remains a manual acceptance.
    const activeRef = store.flow()!.steps[0];
    const typed = await uiEval(
      `window.creator.invoke(${JSON.stringify({ type: "test", stepId: activeRef.id, version: 3 })})`,
    );
    assert.equal(typed[0].ok, true);
    assert.equal((await probe()).text, "Bản nháp UI 👋");
    passed("ui-ipc-type-only-existing-focus");
    window.webContents.send("creator:shortcut-result", typed);
    await wait();
    assert.match(
      await uiEval('document.querySelector(".result")?.textContent || ""'),
      /ACTION_SENT/,
    );
    passed("ui-receives-browser-test-result");
    entries.push({
      name: "physical-Ctrl-Shift-T",
      passed: false,
      manualRequired: true,
      reason:
        "Synthetic sendInputEvent bypasses before-input-event; Windows SendKeys did not reach app in this automation desktop.",
    });
    await uiEval("document.querySelector('aside').scrollTop=0");
    await wait();
    // BrowserWindow.capturePage captures only the shell, not native child views.
    // This review image is explicitly composed from shell + real browser capture.
    const preview = await sharp((await window.capturePage()).toPNG())
      .composite([
        {
          input: Buffer.from(typed[0].after!.dataUrl.split(",")[1], "base64"),
          left: browser.bounds.x,
          top: browser.bounds.y,
        },
      ])
      .png()
      .toBuffer();
    await writeFile(
      path.join(project, "artifacts", "creator-ui-composed.png"),
      preview,
    );
  }
  const passedCount = entries.filter((e) => e.passed).length;
  const pendingCount = entries.length - passedCount;
  const report = {
    phase,
    timestamp: new Date().toISOString(),
    status: pendingCount ? "partial" : "passed",
    passedCount,
    pendingCount,
    versions: process.versions,
    zoom: browser.zoom,
    bounds: browser.bounds,
    entries,
    facebookTested: false,
  };
  await writeFile(
    path.join(project, "artifacts", `browser-${phase}.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `POC_REPORT ${phase}: ${passedCount} passed; ${pendingCount} limitations/manual checks`,
  );
}
