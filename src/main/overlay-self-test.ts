import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserCore } from "./browser-core.js";
import type { CreatorOverlays } from "./creator-overlays.js";
import type { BrowserWindow } from "electron";
export async function runSelfTest({browser, overlays, window, project}: {
  browser: BrowserCore; overlays: CreatorOverlays; window: BrowserWindow; project: string;
}) {
  const bounds = browser.view.getBounds();
  const wc = browser.view.webContents;
  const zoom = wc.getZoomFactor();
  let navigations = 0;
  wc.on("did-start-navigation", () => navigations++);
  window.show(); window.focus();
  for (const [i, view] of overlays.views.entries()) {
    await view.webContents.loadURL(`data:text/html,<body style="margin:0;background:%23172940;color:white"><button style="height:36px">${i ? "Test %26 Debug" : "Step Editor"}</button><p>Native overlay proof</p></body>`);
  }
  browser.click(270,152);
  await new Promise(r => setTimeout(r,150));
  const before = await wc.executeJavaScript("window.fixtureRead()");
  assert.ok(before.clicks > 0);
  const focused = wc.isFocused();
  for (let i = 0; i < 4; i++) for (const panel of ["editor", "debug"] as const) {
    overlays.toggle(panel);
    assert.deepEqual(browser.view.getBounds(), bounds);
    assert.equal(wc.getZoomFactor(), zoom);
    assert.equal(wc.isFocused(), focused);
  }
  assert.equal(navigations, 0);
  assert.deepEqual(window.contentView.children.slice(-2), overlays.views);
  // The composed screenshot, unlike capturePage on the browser alone, includes native panels.
  await mkdir(path.join(project,"artifacts"),{recursive:true});
  await writeFile(path.join(project,"artifacts/overlay-proof.png"),(await window.capturePage()).toPNG());
  const report = { timestamp:new Date().toISOString(),status:"passed",passedCount:5,pendingCount:0,
    fixtureOnly:true,facebookTested:false,bounds,zoom,
    checks:["native stacking","uncovered browser input","stable viewport","no navigation","toggle preserves browser focus"] };
  await writeFile(path.join(project,"artifacts/browser-overlay.json"),JSON.stringify(report,null,2));
}
