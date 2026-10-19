import { fixtureUi } from "./fixture-ui.js";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { screen, type BrowserWindow } from "electron";
import type { BrowserCore } from "./browser-core.js";
import type { Store } from "./storage.js";
import type { Runtime } from "./runtime.js";
import { WEB_WIDTH, WEB_HEIGHT } from "../shared/geometry.js";

const wait = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
export async function runSelfTest({
  browser,
  store,
  runtime,
  project,
  window,
}: {
  browser: BrowserCore;
  store: Store;
  runtime: Runtime;
  project: string;
  window: BrowserWindow;
}) {
  const entries: { name: string; passed: boolean; detail?: unknown }[] = [];
  const passed = (name: string, detail?: unknown) => {
    entries.push({ name, passed: true, detail });
    console.log("PASS", name);
  };
  const ui = fixtureUi(window);
  // All DOM reads/selectors here are test instrumentation for the shell/fixture.
  const evaluate = (code: string) => ui.executeJavaScript(code);
  const until = async (
    check: () => Promise<unknown> | unknown,
    label: string,
  ) => {
    const end = Date.now() + 7000;
    while (!(await check())) {
      if (Date.now() > end) throw new Error(`UX timeout: ${label}`);
      await wait();
    }
  };
  window.show();
  window.focus();
  window.setAlwaysOnTop(true);
  await window.webContents.executeJavaScript(
    'window.creator.invoke({type:"panel",panel:"editor",expanded:true})',
  );
  await until(
    () => evaluate('!!document.querySelector("#roi-flow-help")'),
    "editor mounted",
  );
  const click = async (text: string) => {
    const p = await evaluate(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(text)}));if(!b)throw Error('Missing button');b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),disabled:b.disabled}})()`,
    );
    assert.equal(p.disabled, false, `${text} enabled`);
    ui.focus();
    ui.sendInputEvent({
      type: "mouseDown",
      x: p.x,
      y: p.y,
      button: "left",
      clickCount: 1,
    });
    ui.sendInputEvent({
      type: "mouseUp",
      x: p.x,
      y: p.y,
      button: "left",
      clickCount: 1,
    });
    await wait(150);
    await until(
      () =>
        evaluate(
          'document.querySelector("[role=status]")?.textContent !== "Đang xử lý…"',
        ),
      text,
    );
  };
  const snapshotBounds = () =>
    evaluate(
      `(()=>{const r=document.querySelector('.snapshot').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`,
    );
  const draw = async (zoom = 1) => {
    const r = await snapshotBounds();
    assert.deepEqual(r, browser.bounds);
    const x = Math.round(120 * zoom),
      y = Math.round(120 * zoom),
      width = Math.round(300 * zoom),
      height = Math.round(64 * zoom);
    ui.sendInputEvent({
      type: "mouseDown",
      x: r.x + x,
      y: r.y + y,
      button: "left",
      clickCount: 1,
    });
    ui.sendInputEvent({
      type: "mouseMove",
      x: r.x + x + width,
      y: r.y + y + height,
      button: "left",
    });
    ui.sendInputEvent({
      type: "mouseUp",
      x: r.x + x + width,
      y: r.y + y + height,
      button: "left",
      clickCount: 1,
    });
    await until(() => evaluate('!!document.querySelector(".roi")'), "ROI drag");
    return { x, y, width, height };
  };
  const capture = async () => {
    await click("Chụp & crop ROI");
    await until(
      () => evaluate('!!document.querySelector(".snapshot")'),
      "crop overlay",
    );
    assert.equal(browser.visible, false);
  };
  const escape = async () => {
    ui.focus();
    ui.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    ui.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await until(
      () => evaluate('!document.querySelector(".snapshot")'),
      "escape crop",
    );
    assert.equal(browser.visible, true);
  };
  assert.equal(store.flow(), null);
  assert.equal(
    await evaluate(
      `document.querySelector('[aria-describedby="roi-flow-help"]').disabled`,
    ),
    true,
  );
  assert.match(
    await evaluate('document.querySelector("#roi-flow-help").textContent'),
    /Chưa có flow/,
  );
  await click("Đi tới bước 1");
  assert.equal(
    await evaluate('document.activeElement.getAttribute("aria-label")'),
    "Tên flow mới",
  );
  passed("empty-flow-explains-disabled-crop-and-links-to-creation");
  await click("Tạo flow");
  assert.ok(store.flow());
  assert.equal(
    await evaluate(
      `document.querySelector('[aria-describedby="roi-flow-help"]').disabled`,
    ),
    false,
  );
  passed("create-flow-enables-capture");
  await capture();
  await evaluate("document.querySelector('aside').scrollTop=10000");
  const exit = await evaluate(
    `(()=>{const b=[...document.querySelectorAll('nav button')].find(b=>b.textContent.includes('Quay lại'));const r=b.getBoundingClientRect();return{top:r.top,bottom:r.bottom,disabled:b.disabled}})()`,
  );
  assert.ok(exit.top >= 36 && exit.bottom <= 88);
  assert.equal(exit.disabled, false);
  await escape();
  passed("crop-exit-always-visible-and-escape-works-with-no-roi");
  await capture();
  ui.focus();
  ui.sendInputEvent({
    type: "mouseDown",
    x: browser.bounds.x + 120,
    y: 208,
    button: "left",
    clickCount: 1,
  });
  ui.sendInputEvent({
    type: "mouseMove",
    x: browser.bounds.x + 180,
    y: 240,
    button: "left",
  });
  await escape();
  ui.sendInputEvent({
    type: "mouseUp",
    x: browser.bounds.x + 180,
    y: 240,
    button: "left",
    clickCount: 1,
  });
  await capture();
  await evaluate(
    "document.querySelector('.snapshot').dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:1}))",
  );
  assert.equal(await evaluate('!!document.querySelector(".roi")'), false);
  await click("Quay lại browser");
  assert.equal(browser.visible, true);
  passed("escape-mid-drag-and-pointer-cancel-do-not-trap-crop");
  await capture();
  await draw();
  const originalCaptureBuffer = browser.captureBuffer.bind(browser);
  browser.captureBuffer = () => {
    throw new Error("Simulated expired capture");
  };
  try {
    await click("Dùng ROI");
    assert.match(
      await evaluate('document.querySelector("[role=status]").textContent'),
      /Simulated expired capture/,
    );
    assert.equal(await evaluate('!!document.querySelector(".snapshot")'), true);
    await escape();
  } finally {
    browser.captureBuffer = originalCaptureBuffer;
  }
  passed("failed-crop-can-still-exit-and-browser-returns");

  const baseBounds = { ...browser.bounds };
  for (const zoom of [1, 0.9]) {
    if (zoom !== 1) {
      await click("Tạo flow");
      await evaluate(
        `(()=>{const s=document.querySelector('[aria-label="Zoom"]');s.value='${zoom}';s.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
      await until(() => browser.zoom === zoom, "zoom applied before authoring");
    }
    let stepId = "";
    const modes = [
      "normal",
      "maximized",
      "fullscreen",
      "maximized-again",
      "restored",
    ] as const;
    for (const mode of modes) {
      if (mode === "maximized") {
        window.maximize();
        await until(() => window.isMaximized(), "maximize");
      }
      if (mode === "fullscreen") {
        await click("Toàn màn hình");
        await until(() => window.isFullScreen(), "fullscreen");
      }
      if (mode === "maximized-again") {
        await click("Toàn màn hình");
        await until(() => !window.isFullScreen(), "leave fullscreen");
        window.maximize();
        await until(() => window.isMaximized(), "return maximized");
      }
      if (mode === "restored") {
        window.unmaximize();
        await until(() => !window.isMaximized(), "restore");
      }
      await wait(250);
      const windowBounds = window.getBounds();
      const display = screen.getDisplayMatching(windowBounds);
      if (mode === "maximized" || mode === "maximized-again") {
        assert.ok(
          windowBounds.width >= display.workArea.width,
          "maximized window fills work area width",
        );
        assert.ok(
          windowBounds.height >= display.workArea.height,
          "maximized window fills work area height",
        );
      }
      if (mode === "fullscreen") {
        assert.ok(
          Math.abs(windowBounds.width - display.bounds.width) <= 1,
          "fullscreen fills display width",
        );
        assert.ok(
          Math.abs(windowBounds.height - display.bounds.height) <= 1,
          "fullscreen fills display height",
        );
      }
      assert.equal(window.isResizable(), true);
      assert.equal(window.isMaximizable(), true);
      assert.equal(window.isFullScreenable(), true);
      assert.deepEqual(browser.view.getBounds(), {
        ...baseBounds,
        x: window.getContentSize()[0] >= 1696 ? 672 : 320,
      });
      assert.equal(browser.view.webContents.getZoomFactor(), zoom);
      assert.equal(store.flow()!.zoom, zoom);
      const metrics = await browser.view.webContents.executeJavaScript(
        "window.fixtureRead()",
      );
      assert.ok(metrics.width >= browser.bounds.width);
      assert.ok(Math.abs(metrics.width - browser.bounds.width / zoom) < 2);
      await capture();
      const roi = await draw(zoom);
      await click("Dùng ROI");
      assert.equal(browser.visible, true);
      if (!stepId) {
        await click("Lưu Base v1");
        stepId = store.flow()!.steps[0].id;
      }
      // Reuse the same saved target across modes, not a freshly calibrated click.
      const expected = store.step(stepId, 1).payload.target!.roi;
      assert.deepEqual(expected, roi);
      const clicks = (
        await browser.view.webContents.executeJavaScript("window.fixtureRead()")
      ).clicks;
      const [result] = await runtime.test(stepId, 1);
      assert.equal(result.ok, true, result.message);
      assert.equal(result.status, "ACTION_SENT");
      const probe = await browser.view.webContents.executeJavaScript(
        "window.fixtureRead()",
      );
      assert.equal(probe.clicks, clicks + 1);
      assert.ok(Math.abs(probe.x - 270) < 2);
      assert.ok(Math.abs(probe.y - 152) < 2);
      const png = await sharp(
        browser.captureBuffer((await browser.capture()).id),
      ).metadata();
      assert.equal(png.width, browser.bounds.width);
      assert.equal(png.height, WEB_HEIGHT);
      passed(`roi-crop-and-saved-target-click-${mode}-zoom-${zoom}`, {
        bounds: browser.view.getBounds(),
        windowBounds,
        contentSize: window.getContentSize(),
        cssWidth: probe.width,
        zoom,
        click: { x: probe.x, y: probe.y },
      });
    }
  }
  // A window-mode transition during an unfinished crop must not move its canvas.
  await capture();
  window.maximize();
  await until(() => window.isMaximized(), "maximize mid-crop");
  assert.deepEqual(await snapshotBounds(), baseBounds);
  await escape();
  window.unmaximize();
  await until(() => !window.isMaximized(), "final restore");
  passed("maximize-during-crop-keeps-mapping-and-escape-exit");
  const report = {
    phase: "ux",
    timestamp: new Date().toISOString(),
    status: "passed",
    passedCount: entries.length,
    pendingCount: 0,
    entries,
    facebookTested: false,
    fixtureOnly: true,
  };
  await mkdir(path.join(project, "artifacts"), { recursive: true });
  await writeFile(
    path.join(project, "artifacts", "browser-ux.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `POC_REPORT ux: ${entries.length} passed (fixture; Facebook not tested)`,
  );
}
