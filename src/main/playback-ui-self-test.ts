import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { screen, type BrowserWindow } from "electron";
import type { BrowserCore } from "./browser-core.js";
import type { CreatorOverlays } from "./creator-overlays.js";
import type { Store } from "./storage.js";
import type { Capture, VisualTarget } from "../shared/contracts.js";
export async function runSelfTest({
  window,
  browser,
  overlays,
  store,
  assetDir,
  project,
  phase,
}: {
  window: BrowserWindow;
  browser: BrowserCore;
  overlays: CreatorOverlays;
  store: Store;
  assetDir: string;
  project: string;
  phase: string;
}) {
  const shell = window.webContents,
    page = browser.view.webContents,
    entries: string[] = [];
  const wait = (ms = 100) => new Promise((r) => setTimeout(r, ms));
  const until = async (check: () => Promise<unknown>, label: string) => {
    const end = Date.now() + 15000;
    while (!(await check())) {
      if (Date.now() > end) throw Error("Playback UI timeout: " + label);
      await wait();
    }
  };
  const pass = (label: string) => {
    entries.push(label);
    console.log("PASS", label);
  };
  const click = async (selector: string) => {
    const p = await shell.executeJavaScript(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing/disabled '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
    const origin = window.getContentBounds(),
      point = screen.dipToScreenPoint({ x: origin.x + p.x, y: origin.y + p.y });
    await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        path.join(project, "scripts/native-click.ps1"),
        "-X",
        String(Math.round(point.x)),
        "-Y",
        String(Math.round(point.y)),
      ],
      { windowsHide: true },
    );
    await wait(120);
  };
  const invoke = async <T>(command: unknown): Promise<T> =>
    shell.executeJavaScript(
      `window.creator.invoke(${JSON.stringify(command)})`,
    );
  const evidence = async (name: string) => {
    const layers = [];
    if (browser.visible) {
      layers.push({
        input: (await page.capturePage()).toPNG(),
        left: browser.bounds.x,
        top: browser.bounds.y,
      });
      layers.push({
        input: (await overlays.debug.webContents.capturePage()).toPNG(),
        left: overlays.debug.getBounds().x,
        top: overlays.debug.getBounds().y,
      });
    }
    await sharp((await window.capturePage()).toPNG())
      .composite(layers)
      .png()
      .toFile(path.join(project, "artifacts", name));
  };
  const reload = async () => {
    shell.reload();
    await wait(500);
    await until(
      () =>
        shell.executeJavaScript(
          `!!document.querySelector('[aria-label="Play All"]')&&!document.querySelector('[aria-label="Play All"]').disabled`,
        ),
      "flow loaded",
    );
  };
  const status = (id: string, value: string) =>
    shell.executeJavaScript(
      `document.querySelector('[data-step-id="${id}"]')?.dataset.playStatus===${JSON.stringify(value)}`,
    );
  window.show();
  window.focus();
  window.setAlwaysOnTop(true);
  window.setFullScreen(true);
  await wait(400);
  let navigations = 0;
  page.on("did-start-navigation", () => navigations++);
  store.newFlow("Playback UI fixture", 1);
  const capture = await invoke<Capture>({ type: "capture" });
  const crop = await invoke<{
    asset: string;
    roi: VisualTarget["roi"];
    environment: VisualTarget["environment"];
  }>({
    type: "crop",
    captureId: capture.id,
    roi: { x: 120, y: 120, width: 300, height: 64 },
  });
  const target: VisualTarget = {
    asset: crop.asset,
    roi: crop.roi,
    environment: crop.environment,
  };
  const payload = {
    action: "CLICK_TARGET" as const,
    target,
    method: "auto" as const,
    threshold: 0.96,
  };
  const first = store.saveStep("Open draft", payload),
    second = store.saveStep("Review composer", payload);
  const grouped = Array.from({ length: 30 }, (_, i) =>
    store.saveStep(`Review draft section ${i + 1}`, payload),
  );
  const absentAsset = randomUUID() + ".png";
  await sharp(
    Buffer.from(
      '<svg width="300" height="64" xmlns="http://www.w3.org/2000/svg"><rect width="300" height="64" fill="#25e853"/><path d="M0 0L300 64M0 64L300 0" stroke="#431277" stroke-width="15"/><text x="55" y="40" font-size="30">Absent target</text></svg>',
    ),
  )
    .png()
    .toFile(path.join(assetDir, absentAsset));
  const blocked = store.saveStep("Wait for absent target", {
    action: "WAIT_VERIFY",
    target: { ...target, asset: absentAsset },
    timeoutMs: 2600,
    threshold: 0.96,
  });
  const never = store.saveStep("Must not run after blocked", payload);
  const fail = store.saveStep("Unavailable target asset", {
    ...payload,
    target: { ...target, asset: randomUUID() + ".png" },
  });
  store.organize(
    [
      {
        id: "review-group",
        name: "Review draft",
        slug: "review-draft",
        collapsed: true,
        stepIds: [...grouped.map((s) => s.id), blocked.id, never.id],
      },
    ],
    store.flow()!.steps.map((s) => s.id),
  );
  const variables = Array.from({ length: 18 }, (_, i) => ({
    id: `drawer-${i}`,
    key: i === 0 ? "caption" : `draft_section_${i + 1}`,
    type: "text" as const,
  }));
  store.updateVariables(
    variables,
    Object.fromEntries(
      variables.map((v) => [
        v.id,
        "Nội dung bản nháp kiểm thử — không xuất bản. ".repeat(8),
      ]),
    ),
  );
  await reload();
  assert.equal(
    await shell.executeJavaScript(
      `document.querySelector('[data-step-id="${first.id}"] > .step-number').textContent`,
    ),
    "01",
  );
  assert.equal(
    await shell.executeJavaScript(
      `document.querySelector('[data-step-id="${second.id}"] > .step-number').textContent`,
    ),
    "02",
  );
  await click(".folder-toggle");
  assert.equal(
    await shell.executeJavaScript(
      `document.querySelector('[data-step-id="${grouped[0].id}"] > .step-number').textContent`,
    ),
    "03.1",
  );
  await click(".folder-toggle");
  await evidence("ui-controls-steps-play-all.png");
  const before = (await page.executeJavaScript("window.fixtureRead()")).clicks;
  await click(`[data-step-id="${first.id}"] .step`);
  assert.equal(
    (await page.executeJavaScript("window.fixtureRead()")).clicks,
    before,
  );
  await click(`[aria-label="Play ${first.name}"]`);
  await until(() => status(first.id, "pass"), "single Play completed");
  assert.equal(
    (await page.executeJavaScript("window.fixtureRead()")).clicks,
    before + 1,
  );
  assert.equal(
    await shell.executeJavaScript(
      `document.querySelector('[data-step-id="${first.id}"] .step-status').textContent`,
    ),
    "pass · sent",
  );
  pass(
    "per-step-Play-uses-existing-Test-name-click-does-not-execute-number-column-and-group-ordinals",
  );
  await click(`[aria-label="Edit ${first.name}"]`);
  await wait(200);
  const editor = await shell.executeJavaScript(
    `(()=>{const r=document.querySelector('.editor-column').getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:r.height,viewport:innerHeight}})()`,
  );
  assert.equal(editor.top, 88);
  assert.equal(editor.bottom, editor.viewport);
  assert.equal(editor.height, editor.viewport - 88);
  assert.equal(browser.bounds.height, 560);
  await evidence("ui-controls-editor-full-height.png");
  await click(".editor-column .panel-heading button");
  pass("Editor-fills-height-below-topbar-without-changing-browser-viewport");
  await page.executeJavaScript(
    `{const d=document.createElement('dialog');d.id='drawer-modal';d.textContent='Draft modal retained';document.body.append(d);d.showModal();}`,
  );
  const beforeDrawer = { ...browser.bounds },
    debugBefore = { ...overlays.debug.getBounds() };
  await click(".variables > button");
  await until(async () => !browser.visible, "drawer open");
  const drawer = await shell.executeJavaScript(
    `(()=>{const d=document.querySelector('.variables-drawer'),r=d.getBoundingClientRect(),footer=d.querySelector('.popover-footer').getBoundingClientRect(),body=d.querySelector('.variable-table-body');return{top:r.top,right:r.right,bottom:r.bottom,viewport:innerHeight,width:innerWidth,footerBottom:footer.bottom,scroll:body.scrollHeight>body.clientHeight}})()`,
  );
  assert.equal(drawer.top, 88);
  assert.equal(drawer.right, drawer.width);
  assert.equal(drawer.bottom, drawer.viewport);
  assert.ok(drawer.footerBottom <= drawer.viewport);
  assert.equal(drawer.scroll, true);
  await evidence("ui-controls-variables-drawer.png");
  await shell.executeJavaScript(
    `(()=>{const e=document.querySelector('.variable-row textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Saved drawer draft');e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await wait();
  await click(".variables-drawer .popover-footer button:nth-child(2)");
  await until(async () => browser.visible, "drawer save closed");
  assert.equal(
    store.flow()!.defaultPattern!.values["drawer-0"],
    "Saved drawer draft",
  );
  assert.deepEqual(browser.bounds, beforeDrawer);
  assert.deepEqual(overlays.debug.getBounds(), debugBefore);
  assert.equal(
    await page.executeJavaScript(
      `document.querySelector('#drawer-modal').open`,
    ),
    true,
  );
  await page.executeJavaScript(
    `document.querySelector('#drawer-modal').close()`,
  );
  await click(".variables > button");
  await click('[aria-label="Close Variables"]');
  await until(async () => browser.visible, "drawer close restored");
  assert.deepEqual(browser.bounds, beforeDrawer);
  pass(
    "Variables-right-drawer-full-height-footer-visible-internal-scroll-save-close-modal-and-native-bounds-preserved",
  );
  await click('[aria-label="Play All"]');
  await until(() => status(blocked.id, "running"), "active step reached");
  const active = await shell.executeJavaScript(
    `(()=>{const e=document.querySelector('[data-step-id="${blocked.id}"]'),r=e.getBoundingClientRect(),list=document.querySelector('.steps'),b=list.getBoundingClientRect();return{visible:r.top>=b.top&&r.bottom<=b.bottom,scroll:list.scrollTop,highlight:e.classList.contains('is-running'),number:e.querySelector('.step-number').textContent}})()`,
  );
  assert.equal(active.visible, true);
  assert.ok(active.scroll > 0);
  assert.equal(active.highlight, true);
  assert.equal(active.number, "03.31");
  await evidence("ui-controls-active-step.png");
  await until(() => status(blocked.id, "blocked"), "Play All blocked");
  assert.equal(
    (await page.executeJavaScript("window.fixtureRead()")).clicks,
    before + 1 + 32,
  );
  assert.equal(await status(never.id, "idle"), true);
  assert.equal(await status(fail.id, "idle"), true);
  assert.equal(await status(first.id, "pass"), true);
  assert.equal(store.flow()!.groups![0].collapsed, true);
  pass(
    "Play-All-canonical-order-active-highlight-auto-scroll-collapsed-group-reveal-and-stop-on-blocked",
  );
  await click(`[aria-label="Play ${fail.name}"]`);
  await until(() => status(fail.id, "fail"), "failed Play");
  assert.equal(
    (await page.executeJavaScript("window.fixtureRead()")).clicks,
    before + 1 + 32,
  );
  await click(".folder-toggle");
  await shell.executeJavaScript(
    `document.querySelector('.steps').scrollTop=100000`,
  );
  await evidence("ui-controls-step-statuses.png");
  assert.equal(browser.bounds.width, 1024);
  assert.equal(browser.bounds.height, 560);
  assert.equal(page.getZoomFactor(), 1);
  assert.equal(navigations, 0);
  pass(
    "failed-Play-reports-fail-without-sending-click-browser-session-viewport-and-zoom-unchanged",
  );
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
        nativeInput: true,
      },
      null,
      2,
    ),
  );
}
