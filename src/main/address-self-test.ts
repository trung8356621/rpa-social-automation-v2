import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { screen } from "electron";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { clipboard, ClipboardItem, type BrowserWindow } from "electron";
import type { BrowserCore } from "./browser-core.js";
const wait = () => new Promise((r) => setTimeout(r, 80));
export async function runSelfTest({
  browser,
  window,
  project,
}: {
  browser: BrowserCore;
  window: BrowserWindow;
  project: string;
}) {
  const ui = window.webContents,
    page = browser.view.webContents;
  const entries: string[] = [];
  const until = async (check: () => Promise<boolean>) => {
    const end = Date.now() + 7000;
    while (!(await check())) {
      if (Date.now() > end) throw Error("Address test timeout");
      await wait();
    }
  };
  const read = () =>
    ui.executeJavaScript(`document.querySelector('[aria-label="URL"]')?.value`);
  const synced = async (label: string) => {
    await until(async () => (await read()) === page.getURL());
    entries.push(label);
  };
  const click = async (selector: string, contents = ui) => {
    const p = await contents.executeJavaScript(
      `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
    );
    await new Promise((r) => setTimeout(r, 300));
    const origin = window.getContentBounds(),
      offset = contents === page ? browser.bounds : { x: 0, y: 0 };
    const point = screen.dipToScreenPoint({
      x: origin.x + offset.x + p.x,
      y: origin.y + offset.y + p.y,
    });
    if (contents === page) {
      // Wait for a composited frame after cross-document navigation. DOM ready
      // alone can precede the native surface accepting pointer input.
      await browser.capture();
      browser.click(p.x, p.y);
    } else {
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
    }
    await wait();
  };
  window.show();
  window.focus();
  window.setAlwaysOnTop(true);
  await synced("initial URL matches browser");
  const bounds = browser.view.getBounds(),
    zoom = page.getZoomFactor();
  const base = new URL(page.getURL()).origin;
  await browser.navigate(base + "/address");
  await synced("normal navigation");
  await click("button", page);
  await until(async () => page.getURL() === base + "/address?pushed");
  await synced("pushState");
  assert.equal(page.getURL(), base + "/address?pushed");
  await click("button:nth-of-type(2)", page);
  await synced("replaceState");
  assert.equal(page.getURL(), base + "/address?replaced");
  page.navigationHistory.goBack();
  await until(async () => page.getURL() === base + "/address");
  await synced("back");
  page.navigationHistory.goForward();
  await until(async () => page.getURL().endsWith("?replaced"));
  await synced("forward");
  await click("a", page);
  await until(async () => page.getURL() === base + "/address?linked");
  await synced("native link navigation");
  assert.ok(page.getURL().endsWith("?linked"));
  await page.executeJavaScript(`location.hash='section'`);
  await synced("hash navigation");
  await page.executeJavaScript(
    `document.querySelector('iframe').contentWindow.history.pushState({},'', '/subframe')`,
  );
  await wait();
  assert.equal(await read(), page.getURL());
  entries.push("subframe navigation ignored");
  const draft = base + "/address?manual";
  await click('[aria-label="URL"]');
  ui.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
  ui.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
  ui.insertText(draft);
  await until(async () => (await read()) === draft);
  await click("button", page);
  await wait();
  assert.equal(await read(), draft);
  entries.push("unsent draft preserved after blur and SPA navigation");
  const previous = await Promise.all(
    (await clipboard.read()).map(
      async (item) =>
        new ClipboardItem(
          Object.fromEntries(
            await Promise.all(
              item.types.map(async (type) => [type, await item.getType(type)]),
            ),
          ),
        ),
    ),
  );
  try {
    await click("nav > button:nth-of-type(2)");
    await until(async () => (await clipboard.readText()) === page.getURL());
    assert.equal(await read(), draft);
    entries.push("Copy URL copies live URL without overwriting draft");
  } finally {
    if ((await clipboard.readText()) === page.getURL())
      await clipboard.write(previous);
  }
  await click("nav > button");
  await until(async () => page.getURL() === draft);
  await synced("manual open");
  await click("button:nth-of-type(2)", page);
  await synced("sync resumes after manual open");
  assert.deepEqual(browser.view.getBounds(), bounds);
  assert.equal(page.getZoomFactor(), zoom);
  entries.push("viewport and zoom unchanged");
  await mkdir(path.join(project, "artifacts"), { recursive: true });
  await writeFile(
    path.join(project, "artifacts/browser-address.json"),
    JSON.stringify(
      {
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
  console.log("ADDRESS_REPORT", entries);
}
