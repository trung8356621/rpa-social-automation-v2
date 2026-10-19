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
  const click = async (
    wc: WebContents,
    selector: string,
    point?: { x: number; y: number },
  ) => {
    const p =
      point ??
      (await wc.executeJavaScript(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing/disabled '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
      ));
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
  await byText(shell, "+ Step");
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
  await byText(shell, "+ Step");
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
  await click(shell, ".editor-column .panel-heading button");
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
    `(()=>{const input=document.querySelector('[aria-label="Variable key"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'draft_text');input.dispatchEvent(new Event('input',{bubbles:true}));const value=document.querySelector('.variables-drawer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(value,'Default draft');value.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await wait(200);
  await click(shell, ".variables-drawer .popover-footer button:nth-child(2)");
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
  // Cleanup regression coverage: real Creator UI against the isolated local fixture.
  const evidence = async (name: string) => {
    const layers = [];
    if (browser.visible) {
      layers.push({
        input: (await page.capturePage()).toPNG(),
        left: browser.bounds.x,
        top: browser.bounds.y,
      });
      layers.push({
        input: (await debug.capturePage()).toPNG(),
        left: overlays.debug.getBounds().x,
        top: overlays.debug.getBounds().y,
      });
    }
    await sharp((await window.capturePage()).toPNG())
      .composite(layers)
      .png()
      .toFile(path.join(project, "artifacts", name));
  };
  const fill = async (selector: string, value: string) => {
    await shell.executeJavaScript(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await wait(100);
  };
  const savedStep = store.step(step.id, 2),
    savedOverrides = store.overrides(),
    debugBounds = { ...overlays.debug.getBounds() };
  assert.equal(
    await shell.executeJavaScript(
      `!!document.querySelector('[aria-label="New group name"]')`,
    ),
    false,
  );
  await byText(shell, "+ Group");
  assert.equal(
    await shell.executeJavaScript(
      `document.activeElement.getAttribute("aria-label")`,
    ),
    "New group name",
  );
  await fill('[aria-label="New group name"]', "Review draft");
  await evidence("ui-cleanup-group-form.png");
  await click(shell, ".group-form button[type=submit]");
  await until(
    async () => browser.visible && store.flow()!.groups!.length === 1,
    "group created",
  );
  const group = store.flow()!.groups![0];
  assert.equal(group.slug, "review-draft");
  await click(shell, `[aria-label="Menu ${step.name}"]`);
  assert.equal(browser.visible, false);
  assert.equal(overlays.debug.getVisible(), false);
  await evidence("ui-cleanup-step-menu.png");
  const beforeDismiss = (await page.executeJavaScript("window.fixtureRead()"))
    .clicks;
  await click(shell, ".ui-backdrop", {
    x: browser.bounds.x + 270,
    y: browser.bounds.y + 152,
  });
  await until(async () => browser.visible, "outside menu close");
  assert.equal(
    (await page.executeJavaScript("window.fixtureRead()")).clicks,
    beforeDismiss,
  );
  assert.equal(
    await shell.executeJavaScript(
      `!!document.querySelector('.actions-popover')`,
    ),
    false,
  );
  await click(shell, `[aria-label="Menu ${step.name}"]`);
  pass(
    "outside-menu-dismiss-restores-native-views-without-clicking-through-to-browser",
  );
  await click(shell, ".actions-popover .menu-item:last-child");
  await until(
    async () =>
      browser.visible && store.flow()!.groups![0].stepIds.includes(step.id),
    "move into group",
  );
  assert.deepEqual(store.step(step.id, 2), savedStep);
  assert.deepEqual(store.overrides(), savedOverrides);
  await click(shell, ".folder-toggle");
  assert.equal(
    await shell.executeJavaScript(
      `document.querySelectorAll('.group-steps .step-row').length`,
    ),
    0,
  );
  await click(shell, ".folder-toggle");
  const beforeNameClick = (await page.executeJavaScript("window.fixtureRead()"))
    .clicks;
  await click(shell, ".group-steps .step");
  assert.equal(
    (await page.executeJavaScript("window.fixtureRead()")).clicks,
    beforeNameClick,
  );
  assert.equal(overlays.debugOpen, true);
  await click(shell, `[aria-label="Edit ${step.name}"]`);
  assert.equal(overlays.editorOpen, true);
  await click(shell, ".editor-column .panel-heading button");
  await click(shell, `[aria-label="Menu ${step.name}"]`);
  await click(shell, ".actions-popover .menu-item");
  await until(
    async () => browser.visible && !store.flow()!.groups![0].stepIds.length,
    "move standalone",
  );
  await click(shell, `[aria-label="Menu ${step.name}"]`);
  await click(shell, ".actions-popover .menu-item:last-child");
  await until(
    async () =>
      browser.visible && store.flow()!.groups![0].stepIds.includes(step.id),
    "restore group",
  );
  pass(
    "compact-name-select-edit-and-context-menu-group-moves-preserve-step-and-overrides",
  );
  for (let i = 0; i < 24; i++)
    store.saveStep(
      `Review draft content ${i + 1} and media before continuing`,
      step.payload,
    );
  const vars = store.flow()!.variables!;
  const sampleVars = Array.from({ length: 12 }, (_, i) => ({
    id: `ui-sample-${i}`,
    key: `draft_section_${i + 1}`,
    type: "text" as const,
  }));
  store.updateVariables([...vars, ...sampleVars], {
    ...store.flow()!.defaultPattern!.values,
    ...Object.fromEntries(
      sampleVars.map((v) => [
        v.id,
        "Long Vietnamese draft — nội dung kiểm thử, không xuất bản. ".repeat(
          12,
        ),
      ]),
    ),
  });
  shell.reload();
  await wait(500);
  await until(
    () =>
      shell.executeJavaScript(
        `document.querySelectorAll('.step-row').length===26`,
      ),
    "sample rows loaded",
  );
  const metrics = await shell.executeJavaScript(
    `(()=>{const rows=[...document.querySelectorAll('.step-row')],list=document.querySelector('.steps');return{heights:rows.map(e=>e.getBoundingClientRect().height),selects:document.querySelectorAll('.step-row select').length,overflow:list.scrollHeight>list.clientHeight}})()`,
  );
  assert.ok(metrics.heights.every((h: number) => h === 38));
  assert.equal(metrics.selects, 0);
  assert.equal(metrics.overflow, true);
  const scrollBefore = await page.executeJavaScript("scrollY");
  await shell.executeJavaScript(
    `document.querySelector('.steps').scrollTop=200`,
  );
  assert.equal(await page.executeJavaScript("scrollY"), scrollBefore);
  await shell.executeJavaScript(`document.querySelector('.steps').scrollTop=0`);
  assert.deepEqual(overlays.debug.getBounds(), debugBounds);
  await evidence("ui-cleanup-compact.png");
  pass(
    "uniform-compact-rows-no-permanent-select-independent-step-scrolling-debug-unchanged",
  );
  await page.executeJavaScript(
    `document.querySelector('#panel-modal').showModal()`,
  );
  await byText(shell, "Variables");
  const popoverMetrics = await shell.executeJavaScript(
    `(()=>{const p=document.querySelector('.variables-drawer'),r=p.getBoundingClientRect(),t=document.querySelector('.variable-table-body');return{left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,internalScroll:t.scrollHeight>t.clientHeight,hit:document.elementFromPoint(r.left+20,r.top+20)?.closest('.variables-drawer')===p}})()`,
  );
  assert.ok(
    popoverMetrics.left >= 0 &&
      popoverMetrics.right <= popoverMetrics.width &&
      popoverMetrics.bottom <= popoverMetrics.height,
  );
  assert.equal(popoverMetrics.internalScroll, true);
  assert.equal(popoverMetrics.hit, true);
  await evidence("ui-cleanup-variables.png");
  await fill(".variable-row input", "caption");
  await fill(".variable-row textarea", "UI saved default draft");
  await click(shell, ".variable-row:last-child button");
  await click(shell, ".variables-drawer .popover-footer button:nth-child(2)");
  await until(async () => browser.visible, "variables saved");
  assert.equal(
    store.flow()!.variables!.length,
    vars.length + sampleVars.length - 1,
  );
  assert.equal(store.flow()!.variables![0].key, "caption");
  assert.equal(
    store.flow()!.defaultPattern!.values[variable.id],
    "UI saved default draft",
  );
  assert.equal(store.step(variableStep.id, 1).version, 1);
  assert.equal(
    await page.executeJavaScript(`document.querySelector('#panel-modal').open`),
    true,
  );
  await page.executeJavaScript(
    `document.querySelector('#panel-modal').close()`,
  );
  assert.deepEqual(overlays.debug.getBounds(), debugBounds);
  pass(
    "variables-table-scroll-edit-delete-save-native-stacking-and-live-modal-preserved",
  );
  window.setFullScreen(true);
  await wait(400);
  const wideWidth = window.getContentSize()[0];
  assert.equal(
    browser.bounds.x,
    320 + Math.max(0, Math.floor((wideWidth - 320 - 1024) / 2)),
  );
  assert.equal(browser.bounds.width, 1024);
  assert.equal(browser.bounds.height, 560);
  assert.equal(overlays.debug.getBounds().x, 320);
  await evidence("ui-cleanup-wide.png");
  await click(shell, `[aria-label="Edit ${step.name}"]`);
  await wait(250);
  assert.equal(browser.bounds.width, 1024);
  assert.equal(
    browser.bounds.x,
    672 + Math.max(0, Math.floor((wideWidth - 672 - 1024) / 2)),
  );
  assert.equal(overlays.debug.getBounds().x, 672);
  await evidence("ui-cleanup-wide-editor.png");
  await click(shell, ".editor-column .panel-heading button");
  window.setFullScreen(false);
  await wait(300);
  assert.equal(page.getZoomFactor(), zoom);
  assert.equal(navigations, 0);
  pass(
    "wide-browser-centered-fixed-viewport-with-editor-and-original-debug-geometry",
  );
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
