import type { BrowserWindow, WebContents } from "electron";
import type { BrowserCore } from "./browser-core.js";
import type { CreatorOverlays } from "./creator-overlays.js";
import type { Store } from "./storage.js";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import sharp from "sharp";
import { screen } from "electron";
import { fixtureUi } from "./fixture-ui.js";
const wait = (ms = 100) => new Promise((r) => setTimeout(r, ms));
export async function runSelfTest({
  window,
  browser,
  overlays,
  store,
  project,
  phase,
}: {
  window: BrowserWindow;
  browser: BrowserCore;
  overlays: CreatorOverlays;
  store: Store;
  project: string;
  phase: string;
}) {
  const ui = fixtureUi(window);
  const editor = overlays.editor.webContents,
    debug = overlays.debug.webContents;
  const shell = window.webContents,
    page = browser.view.webContents;
  const entries: string[] = [];
  const pass = (name: string) => {
    entries.push(name);
    console.log("PASS", name);
  };
  const until = async (check: () => Promise<unknown>, label: string) => {
    const end = Date.now() + 7000;
    while (!(await check())) {
      if (Date.now() > end) throw Error(`Creator UI timeout: ${label}`);
      await wait();
    }
  };
  const click = async (wc: WebContents, selector: string) => {
    const p = await wc.executeJavaScript(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Control unavailable');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
    );
    if (phase === "creator-native") {
      const view = overlays.views.find((v) => v.webContents === wc);
      const offset = view?.getBounds() ?? { x: 0, y: 0 };
      const origin = window.getContentBounds(),
        scale = screen.getDisplayMatching(origin).scaleFactor;
      await promisify(execFile)("powershell.exe", [
        "-NoProfile",
        "-File",
        path.join(project, "scripts/native-click.ps1"),
        "-X",
        String(Math.round((origin.x + offset.x + p.x) * scale)),
        "-Y",
        String(Math.round((origin.y + offset.y + p.y) * scale)),
      ]);
    } else {
      wc.focus();
      wc.sendInputEvent({
        type: "mouseDown",
        ...p,
        button: "left",
        clickCount: 1,
      });
      wc.sendInputEvent({
        type: "mouseUp",
        ...p,
        button: "left",
        clickCount: 1,
      });
    }
    await wait(150);
  };
  window.show();
  window.focus();
  window.setAlwaysOnTop(true);
  await until(
    () =>
      editor.executeJavaScript('!!document.querySelector("#roi-flow-help")'),
    "mounted",
  );
  assert.equal(
    await shell.executeJavaScript(
      '!!document.querySelector("aside [aria-label=Action]")',
    ),
    false,
  );
  assert.equal(
    await shell.executeJavaScript('!!document.querySelector("aside .result")'),
    false,
  );
  assert.equal(
    await editor.executeJavaScript(
      '!!document.querySelector("[aria-label=Action]")',
    ),
    true,
  );
  assert.equal(
    await debug.executeJavaScript(
      'document.querySelector(".panel-heading b").textContent',
    ),
    "Test & Debug",
  );
  pass("sidebar-only-steps-and-controls-owned-by-native-panels");
  const bounds = browser.view.getBounds(),
    zoom = page.getZoomFactor(),
    url = page.getURL();
  let navigations = 0;
  page.on("did-start-navigation", () => navigations++);
  for (const wc of [editor, debug]) {
    await click(wc, ".panel-heading button");
    assert.equal(
      overlays.views.find((v) => v.webContents === wc)!.getBounds().height,
      36,
    );
    await until(async () => page.isFocused(), "collapse returns browser focus");
    assert.deepEqual(browser.view.getBounds(), bounds);
    assert.equal(page.getZoomFactor(), zoom);
    await click(wc, ".panel-heading button");
    assert.deepEqual(browser.view.getBounds(), bounds);
  }
  assert.equal(navigations, 0);
  assert.equal(page.getURL(), url);
  pass(
    "real-collapse-controls-keep-viewport-zoom-navigation-and-return-browser-focus",
  );
  // Native mode uses OS routing into an uncovered fixture target; regular mode
  // verifies the same browser input/focus contract without claiming OS hit-testing.
  if (phase === "creator-native") {
    const origin = window.getContentBounds(),
      scale = screen.getDisplayMatching(origin).scaleFactor;
    await promisify(execFile)("powershell.exe", [
      "-NoProfile",
      "-File",
      path.join(project, "scripts/native-click.ps1"),
      "-X",
      String(Math.round((origin.x + bounds.x + 270) * scale)),
      "-Y",
      String(Math.round((origin.y + bounds.y + 152) * scale)),
    ]);
  } else browser.click(270, 152);
  await wait();
  assert.equal(
    (await page.executeJavaScript("window.fixtureRead()")).clicks,
    1,
  );
  assert.equal(page.isFocused(), true);
  pass(
    phase === "creator-native"
      ? "OS-uncovered-browser-click-and-focus"
      : "uncovered-browser-renderer-input-and-focus",
  );
  await click(shell, ".flow-controls button");
  await until(async () => !!store.flow(), "flow created");
  // Change Action using native React events, then save through the actual topbar.
  await editor.executeJavaScript(
    `(()=>{const e=document.querySelector('[aria-label=Action]');e.value='TYPE_ONLY';e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await until(
    () =>
      shell.executeJavaScript(
        '!document.querySelector("header > .primary").disabled',
      ),
    "shared draft enables Save",
  );
  await click(shell, "header > .primary");
  await until(async () => store.flow()!.steps.length === 1, "topbar saved");
  await until(
    () =>
      debug.executeJavaScript(
        '!!document.querySelector(".panel-body > button")',
      ),
    "test ready",
  );
  assert.equal(
    await editor.executeJavaScript('document.querySelector(".advanced").open'),
    false,
  );
  pass("topbar-save-shares-editor-draft-and-advanced-defaults-collapsed");
  // Test is directly visible even if the list would have been long.
  const testRect = await debug.executeJavaScript(
    '(()=>{const r=document.querySelector(".panel-body > button").getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:innerHeight}})()',
  );
  assert.ok(testRect.top >= 35 && testRect.bottom <= testRect.height);
  await click(debug, ".panel-body > button");
  await until(
    () =>
      debug.executeJavaScript(
        'document.querySelector(".result")?.textContent.includes("BLOCKED")',
      ),
    "editor focus blocks TYPE_ONLY",
  );
  assert.equal((await page.executeJavaScript("window.fixtureRead()")).text, "");
  pass(
    "test-visible-without-sidebar-scroll-and-overlay-focus-blocks-type-only",
  );
  // Append redesign through the same shared form; old Base remains immutable.
  await click(shell, "header > .primary");
  await until(
    async () => store.flow()!.steps[0].version === 2,
    "redesign saved",
  );
  const id = store.flow()!.steps[0].id;
  assert.equal(store.step(id, 1).payload.action, "TYPE_ONLY");
  assert.equal(store.step(id, 2).payload.action, "TYPE_ONLY");
  pass("topbar-redesign-appends-version-without-overwriting-base");
  const clickText = async (text: string) => {
    const p = await ui.executeJavaScript(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(text)}));if(!b)throw Error('Missing control');b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
    );
    ui.focus();
    ui.sendInputEvent({
      type: "mouseDown",
      ...p,
      button: "left",
      clickCount: 1,
    });
    ui.sendInputEvent({ type: "mouseUp", ...p, button: "left", clickCount: 1 });
    await wait(150);
  };
  await clickText("+ Step mới");
  await clickText("Chụp & crop ROI");
  await until(
    () => shell.executeJavaScript('!!document.querySelector(".snapshot")'),
    "crop canvas",
  );
  assert.equal(browser.visible, false);
  assert.equal(overlays.editor.getVisible(), false);
  assert.equal(overlays.debug.getVisible(), false);
  shell.sendInputEvent({
    type: "mouseDown",
    x: bounds.x + 120,
    y: bounds.y + 120,
    button: "left",
    clickCount: 1,
  });
  shell.sendInputEvent({
    type: "mouseMove",
    x: bounds.x + 420,
    y: bounds.y + 184,
    button: "left",
  });
  shell.sendInputEvent({
    type: "mouseUp",
    x: bounds.x + 420,
    y: bounds.y + 184,
    button: "left",
    clickCount: 1,
  });
  await clickText("Dùng ROI");
  await until(
    () =>
      shell.executeJavaScript(
        '!document.querySelector("header > .primary").disabled',
      ),
    "OCR finished and Save ready",
  );
  assert.equal(browser.visible, true);
  assert.equal(overlays.editor.getVisible(), true);
  await click(shell, "header > .primary");
  await until(async () => store.flow()!.steps.length === 2, "click step saved");
  await until(
    () =>
      debug.executeJavaScript(
        'document.querySelector(".panel-heading span").textContent.includes("CLICK_TARGET")',
      ),
    "selected step synced",
  );
  await click(debug, ".panel-body > button");
  await until(
    () =>
      debug.executeJavaScript(
        'document.querySelector(".result")?.textContent.includes("ACTION_SENT")',
      ),
    "live click result",
  );
  assert.equal(
    await debug.executeJavaScript(
      'document.querySelector(".debug-details").open',
    ),
    false,
  );
  assert.deepEqual(browser.view.getBounds(), bounds);
  assert.equal(page.getZoomFactor(), zoom);
  pass("ROI-hides-panels-and-restores-live-browser-before-saved-target-test");
  const reviewRect = await debug.executeJavaScript(
    '(()=>{const e=document.querySelector(".review-actions button");const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:innerHeight}})()',
  );
  assert.ok(
    reviewRect.top >= 35 && reviewRect.bottom <= reviewRect.height,
    "review controls visible without technical logs",
  );
  pass("review-controls-visible-and-technical-debug-collapsed");
  await wait(250);
  const layers = [
    {
      input: (await page.capturePage()).toPNG(),
      left: bounds.x,
      top: bounds.y,
    },
  ];
  for (const view of overlays.views) {
    const b = view.getBounds();
    layers.push({
      input: (await view.webContents.capturePage()).toPNG(),
      left: b.x,
      top: b.y,
    });
  }
  await mkdir(path.join(project, "artifacts"), { recursive: true });
  await sharp((await window.capturePage()).toPNG())
    .composite(layers)
    .png()
    .toFile(path.join(project, "artifacts/creator-ui.png"));
  await click(debug, ".review-actions button");
  await until(
    () =>
      debug.executeJavaScript(
        'document.querySelector(".result")?.textContent.includes("VERIFIED")',
      ),
    "explicit review",
  );
  pass("only-explicit-review-marks-step-verified");
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
        nativeInput: phase === "creator-native",
        screenshot: "creator-ui.png (composed from real native view captures)",
      },
      null,
      2,
    ),
  );
}
