import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import sharp from "sharp";
import { screen, type BrowserWindow, type WebContents } from "electron";
import type { BrowserCore } from "./browser-core.js";
import type { CreatorOverlays } from "./creator-overlays.js";
import type { Store } from "./storage.js";
import type { Runtime } from "./runtime.js";
const wait = (ms = 100) => new Promise((r) => setTimeout(r, ms));
export async function runSelfTest({
  window,
  browser,
  overlays,
  store,
  runtime,
  project,
  phase,
}: {
  window: BrowserWindow;
  browser: BrowserCore;
  overlays: CreatorOverlays;
  store: Store;
  runtime: Runtime;
  project: string;
  phase: string;
}) {
  const shell = window.webContents,
    page = browser.view.webContents,
    debug = overlays.debug.webContents;
  // Native overlay hit testing requires OS input; sendInputEvent bypasses it.
  const native = true,
    entries: string[] = [];
  const pass = (name: string) => {
    entries.push(name);
    console.log("PASS", name);
  };
  const until = async (check: () => Promise<unknown>, name: string) => {
    const end = Date.now() + 7000;
    while (!(await check())) {
      if (Date.now() > end) throw Error("Layout timeout: " + name);
      await wait();
    }
  };
  const click = async (wc: WebContents, selector: string) => {
    const p = await wc.executeJavaScript(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing/disabled '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
    );
    if (native || wc === page) {
      const offset =
        wc === page
          ? browser.bounds
          : wc === debug
            ? overlays.debug.getBounds()
            : { x: 0, y: 0 };
      const origin = window.getContentBounds();
      const point = screen.dipToScreenPoint({
        x: origin.x + offset.x + p.x,
        y: origin.y + offset.y + p.y,
      });
      await promisify(execFile)(
        "powershell.exe",
        [
          "-NoProfile",
          "-File",
          path.join(project, "scripts/native-click.ps1"),
          "-X",
          String(point.x),
          "-Y",
          String(point.y),
        ],
        { windowsHide: true },
      );
    } else {
      wc.focus();
      await wait(100);
      wc.sendInputEvent({ type: "mouseMove", ...p });
      for (const type of ["mouseDown", "mouseUp"] as const)
        wc.sendInputEvent({ type, ...p, button: "left", clickCount: 1 });
    }
    await wait(180);
  };
  const byText = async (wc: WebContents, text: string) => {
    console.log("UI_CLICK", text);
    await until(
      () =>
        wc.executeJavaScript(
          `[...document.querySelectorAll("button")].some(b=>b.textContent.includes(${JSON.stringify(text)}))`,
        ),
      `button ${text}`,
    );
    const selector = await wc.executeJavaScript(
      `(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(text)}));if(!e)throw Error('Button missing '+${JSON.stringify(text)});e.dataset.fixtureClick='yes';return '[data-fixture-click=yes]'})()`,
    );
    await click(wc, selector);
    await wc.executeJavaScript(
      "document.querySelector('[data-fixture-click=yes]')?.removeAttribute('data-fixture-click')",
    );
  };
  window.show();
  window.focus();
  window.setAlwaysOnTop(true);
  await until(
    () => shell.executeJavaScript('!!document.querySelector("aside")'),
    "shell",
  );
  assert.equal(overlays.editorOpen, false);
  assert.equal(
    await shell.executeJavaScript('!!document.querySelector(".editor-column")'),
    false,
  );
  assert.deepEqual(browser.view.getBounds(), {
    x: 320,
    y: 88,
    width: 1024,
    height: 560,
  });
  assert.equal(window.contentView.children.at(-1), overlays.debug);
  assert.equal(overlays.views.length, 1);
  pass("editor-hidden-by-default-no-native-editor-and-production-z-order");
  const url = page.getURL(),
    zoom = page.getZoomFactor();
  let navigations = 0;
  page.on("did-start-navigation", () => navigations++);
  await click(shell, '[aria-label="Mở/ẩn Step Editor"]');
  await until(
    () =>
      shell.executeJavaScript(
        '!!document.querySelector(".editor-column [aria-label=Action]")',
      ),
    "editor opened",
  );
  assert.deepEqual(browser.view.getBounds(), {
    x: 320,
    y: 88,
    width: 1024,
    height: 560,
  });
  const editorRect = await shell.executeJavaScript(
    '(()=>{const r=document.querySelector(".editor-column").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()',
  );
  assert.deepEqual(editorRect, { x: 0, y: 88, width: 320, height: 560 });
  pass("editor-column-beside-list-browser-reflows-width-only");
  const openBounds = { ...browser.bounds };
  await click(debug, ".panel-heading button");
  assert.equal(overlays.debug.getBounds().height, 36);
  assert.equal(overlays.debug.getBounds().y + 36, window.getContentSize()[1]);
  assert.deepEqual(browser.view.getBounds(), openBounds);
  assert.equal(page.getZoomFactor(), zoom);
  // Button lies in the former expanded Debug region, below the surviving 36px bar.
  await click(page, "#routing-target");
  assert.equal(await page.executeJavaScript("window.routingClicks"), 1);
  assert.equal(page.isFocused(), true);
  await click(debug, ".panel-heading button");
  assert.equal(overlays.debug.getBounds().height, 200);
  assert.equal(overlays.debug.getBounds().y + 200, window.getContentSize()[1]);
  assert.deepEqual(browser.view.getBounds(), openBounds);
  if (native) {
    await click(page, "#routing-target");
    assert.equal(
      await page.executeJavaScript("window.routingClicks"),
      1,
      "expanded native panel intercepts its own visible region",
    );
  }
  await click(page, "#composer");
  assert.equal(
    (await page.executeJavaScript("window.fixtureRead()")).clicks,
    1,
  );
  pass(
    native
      ? "physical-mouse-debug-bounds-release-underlying-browser-and-uncovered-input"
      : "renderer-debug-collapse-bounds-and-browser-focus-contract",
  );
  assert.equal(navigations, 0);
  assert.equal(page.getURL(), url);
  await click(shell, ".editor-column .panel-heading button");
  await byText(shell, "Tạo flow");
  await until(async () => !!store.flow(), "flow");
  await byText(shell, "+ Step mới");
  await until(
    () => shell.executeJavaScript('!!document.querySelector("#roi-flow-help")'),
    "new step editor",
  );
  await byText(shell, "Chụp & crop ROI");
  await until(
    () => shell.executeJavaScript('!!document.querySelector(".snapshot")'),
    "capture",
  );
  assert.equal(overlays.debug.getVisible(), false);
  const snapshot = await shell.executeJavaScript(
    '(()=>{const e=document.querySelector(".snapshot");const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()',
  );
  assert.deepEqual(snapshot, openBounds);
  for (const [type, x, y] of [
    ["mouseDown", 120, 120],
    ["mouseMove", 420, 184],
    ["mouseUp", 420, 184],
  ] as const)
    shell.sendInputEvent({
      type,
      x: openBounds.x + x,
      y: openBounds.y + y,
      button: "left",
      clickCount: 1,
    });
  await byText(shell, "Dùng ROI");
  await until(
    () =>
      shell.executeJavaScript(
        '!document.querySelector("header > .primary").disabled',
      ),
    "OCR",
  );
  await click(shell, "header > .primary");
  await until(async () => store.flow()!.steps.length === 1, "saved");
  const step = store.step(store.flow()!.steps[0].id, 1);
  assert.deepEqual(step.payload.target!.environment, {
    width: 1024,
    height: 560,
    zoom,
  });
  assert.deepEqual(step.payload.target!.roi, {
    x: 120,
    y: 120,
    width: 300,
    height: 64,
  });
  await byText(debug, "Test step đã lưu");
  await until(
    () =>
      debug.executeJavaScript(
        'document.querySelector(".result")?.textContent.includes("ACTION_SENT")',
      ),
    "test",
  );
  pass("narrow-viewport-ROI-is-not-rescaled-and-saved-with-environment");
  await click(shell, '[aria-label="Mở/ẩn Step Editor"]');
  assert.equal(browser.bounds.width, 1024);
  assert.equal(page.getZoomFactor(), zoom);
  await runtime.test(step.id, 1);
  assert.equal(
    (await page.executeJavaScript("window.fixtureRead()")).clicks,
    3,
  );
  pass("editor-toggle-preserves-viewport-and-target-coordinates");
  await byText(debug, "Test step đã lưu");
  await until(
    () =>
      debug.executeJavaScript(
        'document.querySelector(".result")?.textContent.includes("ACTION_SENT")',
      ),
    "retest after restore",
  );
  await click(debug, ".review-actions button");
  await until(
    () =>
      debug.executeJavaScript(
        'document.querySelector(".result")?.textContent.includes("VERIFIED")',
      ),
    "review",
  );
  await click(shell, "header > .primary");
  await until(async () => store.flow()!.steps[0].version === 2, "version");
  assert.equal(store.step(step.id, 1).payload.target!.environment!.width, 1024);
  const override = store.saveOverride(step.id, 2, "legacy target", [
    {
      ...step.payload,
      target: {
        ...step.payload.target!,
        environment: { width: 672, height: 560, zoom },
      },
    },
  ]);
  await assert.rejects(
    runtime.test(step.id, 2, override.id),
    /Viewport không khớp/,
  );
  pass("restore-retest-review-version-and-override-retain-environment-guard");
  if (overlays.editorOpen)
    await click(shell, ".editor-column .panel-heading button");
  const beforeSelection = (await page.executeJavaScript("window.fixtureRead()"))
    .clicks;
  await click(shell, ".step");
  assert.equal(
    (await page.executeJavaScript("window.fixtureRead()")).clicks,
    beforeSelection,
  );
  assert.equal(overlays.debugOpen, true);
  assert.equal(overlays.editorOpen, false);
  window.setFullScreen(true);
  await wait(300);
  assert.equal(browser.bounds.width, 1024);
  assert.equal(browser.bounds.height, 560);
  assert.equal(
    overlays.debug.getBounds().y + overlays.debug.getBounds().height,
    window.getContentSize()[1],
  );
  window.setFullScreen(false);
  await wait(300);
  assert.equal(browser.bounds.height, 560);
  assert.equal(page.getZoomFactor(), zoom);
  pass("fullscreen-bottom-anchor-and-step-selection-preserve-height-zoom");
  // Fixture-only modal proves panel changes retain the live document and modal.
  await page.executeJavaScript(
    `{const d=document.createElement('dialog');d.id='panel-modal';d.textContent='Fixture modal';document.body.append(d);d.showModal();}`,
  );
  await byText(shell, "Variables");
  await until(async () => !browser.visible, "variables open");
  await byText(shell, "+ Variable");
  await shell.executeJavaScript(
    `(()=>{const input=document.querySelector('[aria-label="Variable key"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'draft_text');input.dispatchEvent(new Event('input',{bubbles:true}));const value=document.querySelector('.variables-popover textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(value,'Default draft');value.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await wait(200);
  await click(shell, ".variables-popover button:nth-last-of-type(2)");
  await until(async () => browser.visible, "variables close");
  const variable = store
    .flow()!
    .variables!.find((v) => v.key === "draft_text")!;
  assert.equal(
    store.flow()!.defaultPattern!.values[variable.id],
    "Default draft",
  );
  assert.equal(
    await page.executeJavaScript(`document.querySelector('#panel-modal').open`),
    true,
  );
  assert.equal(navigations, 0);
  await page.executeJavaScript(
    `document.querySelector('#panel-modal').close()`,
  );
  pass(
    "variables-popover-saves-template-default-pattern-and-preserves-session-modal",
  );
  const variableStep = store.saveStep("Variable input", {
    action: "TYPE_ONLY",
    variableId: variable.id,
  });
  store.updateVariables(store.flow()!.variables!, {});
  const beforeMissing = (await page.executeJavaScript("window.fixtureRead()"))
    .clicks;
  await assert.rejects(
    runtime.testPair(step.id, variableStep.id, 0),
    /missing Default Pattern/,
  );
  assert.equal(
    (await page.executeJavaScript("window.fixtureRead()")).clicks,
    beforeMissing,
  );
  await assert.rejects(
    runtime.test(variableStep.id, 1),
    /missing Default Pattern/,
  );
  store.updateVariables(store.flow()!.variables!, {
    [variable.id]: "Changed default",
  });
  assert.equal(store.step(variableStep.id, 1).version, 1);
  pass(
    "missing-default-blocks-before-runtime-and-default-edit-keeps-Step-version",
  );
  window.setContentSize(1100, 648);
  await wait(300);
  await shell.executeJavaScript(`window.scrollTo(200,0)`);
  await until(async () => browser.bounds.x === 120, "workspace scroll");
  assert.equal(browser.bounds.width, 1024);
  assert.equal(browser.bounds.height, 560);
  assert.equal(page.getZoomFactor(), zoom);
  await shell.executeJavaScript(`window.scrollTo(0,0)`);
  window.setContentSize(1344, 648);
  await wait(300);
  pass("narrow-workspace-scroll-repositions-browser-without-resizing-viewport");
  const layers = [
    {
      input: (await page.capturePage()).toPNG(),
      left: browser.bounds.x,
      top: browser.bounds.y,
    },
    {
      input: (await debug.capturePage()).toPNG(),
      left: overlays.debug.getBounds().x,
      top: overlays.debug.getBounds().y,
    },
  ];
  await mkdir(path.join(project, "artifacts"), { recursive: true });
  await sharp((await window.capturePage()).toPNG())
    .composite(layers)
    .png()
    .toFile(path.join(project, "artifacts/creator-ui.png"));
  await writeFile(
    path.join(project, `artifacts/browser-${phase}.json`),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        status: "passed",
        passedCount: entries.length,
        pendingCount: 0,
        entries,
        fixtureOnly: true,
        facebookTested: false,
        nativeInput: native,
        pageInput: "physical Windows mouse",
      },
      null,
      2,
    ),
  );
}
