import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { clipboard, ClipboardItem, type BrowserWindow } from "electron";
import type { BrowserCore } from "./browser-core.js";
import type { Store } from "./storage.js";
import type { Runtime } from "./runtime.js";
import type { State, Result } from "../shared/contracts.js";

// DOM is read only as fixture/test-shell instrumentation, never to set text/caret.
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
  const ui = window.webContents;
  const evaluate = (code: string) => ui.executeJavaScript(code);
  const read = () =>
    browser.view.webContents.executeJavaScript("window.typingRead()");
  const until = async (check: () => Promise<unknown>, label: string) => {
    const end = Date.now() + 15000;
    while (!(await check())) {
      if (Date.now() > end) throw Error("Typing timeout " + label);
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
  window.show();
  window.focus();
  window.setAlwaysOnTop(true);
  await browser.navigate("http://127.0.0.1:47835/typing");
  await wait(300);
  await until(() => evaluate("!!window.creator"), "preload");
  const command = async <T>(value: unknown): Promise<T> =>
    evaluate(`window.creator.invoke(${JSON.stringify(value)})`);
  await command({ type: "newFlow", name: "Contenteditable input" });
  const capture = await browser.capture();
  const target = await command<{
    asset: string;
    roi: { x: number; y: number; width: number; height: number };
  }>({
    type: "crop",
    captureId: capture.id,
    roi: { x: 120, y: 100, width: 360, height: 64 },
  });
  let state = await command<State>({
    type: "saveStep",
    name: "Open composer",
    payload: {
      action: "CLICK_TARGET",
      target: { asset: target.asset, roi: target.roi },
      method: "image",
    },
  });
  const first = state.flow!.steps[0];
  const text =
    "Nháp tiếng Việt: Đặng Thị Ánh 👋🏽🚀\nDòng thứ hai — English text\n\nDòng cuối ✅";
  state = await command<State>({
    type: "saveStep",
    name: "Type draft",
    payload: { action: "TYPE_ONLY", text, inputMethod: "keyboard" },
  });
  const second = state.flow!.steps[1];
  ui.reload();
  await until(
    () => evaluate(`!!document.querySelector('.step')`),
    "flow loaded",
  );
  await click("Type draft");
  const originalCapture = browser.capture.bind(browser);
  let captures = 0;
  browser.capture = async () => {
    captures++;
    return originalCapture();
  };
  try {
    await click("Test 2 Step");
  } finally {
    browser.capture = originalCapture;
  }
  let probe = await read();
  assert.equal(probe.text, text);
  assert.equal(probe.clicks, 1);
  assert.equal(probe.active, "editor");
  assert.equal(
    captures,
    1,
    "no screenshots between click and typing or after typing",
  );
  assert.equal(browser.view.webContents.isFocused(), true);
  assert.ok(
    probe.events.some(
      (e: { type: string; trusted: boolean }) =>
        e.type === "input" && e.trusted,
    ),
  );
  assert.ok(probe.events.some((e: { type: string }) => e.type === "keydown"));
  assert.match(
    await evaluate(
      "document.querySelector('[aria-label=\"Kết quả Test\"]').textContent",
    ),
    /ACTION_SENT/,
  );
  assert.doesNotMatch(
    await evaluate(
      "document.querySelector('[aria-label=\"Kết quả Test\"]').textContent",
    ),
    /VERIFIED/,
  );
  pass(
    "UI-pair-click-opens-contenteditable-native-input-exact-Vietnamese-emoji-newlines-no-focus-transfer-or-screenshot",
  );
  const latest = JSON.parse(
    (
      store.db
        .prepare("SELECT payload FROM runs ORDER BY rowid DESC LIMIT 1")
        .get() as { payload: string }
    ).payload,
  ) as Result;
  await evaluate(
    "document.querySelector('[aria-label=\"Kết quả Test\"]').scrollIntoView({block:'start'})",
  );
  await sharp((await ui.capturePage()).toPNG())
    .composite([
      {
        input: browser.captureBuffer((await browser.capture()).id),
        left: browser.bounds.x,
        top: browser.bounds.y,
      },
    ])
    .png()
    .toFile(path.join(project, "artifacts", "typing-native-review.png"));
  assert.equal(latest.input!.focus.caret, "unknown");
  assert.equal((await runtime.review(latest.id, "correct")).status, "VERIFIED");
  pass(
    "TYPE_ONLY-is-ACTION_SENT-until-explicit-review-caret-is-not-claimed-ready",
  );
  await browser.navigate("http://127.0.0.1:47835/typing");
  await wait(300);
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
  const marker = "Creator fixture previous clipboard";
  try {
    await clipboard.write([
      new ClipboardItem({
        "text/plain": marker,
        "text/html": "<b>Creator fixture previous clipboard</b>",
        "web application/x-rpa-fixture": new Blob(["fixture-bytes"]),
        "image/png": new Blob(
          [
            new Uint8Array(
              await sharp({
                create: {
                  width: 2,
                  height: 2,
                  channels: 3,
                  background: "#123456",
                },
              })
                .png()
                .toBuffer(),
            ),
          ],
          { type: "image/png" },
        ),
      }),
    ]);
    store.saveStep(
      "Type draft",
      { action: "TYPE_ONLY", text, inputMethod: "clipboard" },
      second.id,
    );
    const results = await runtime.testPair(first.id, second.id, 400);
    assert.equal(results[1].status, "ACTION_SENT", results[1].message);
    assert.equal(
      results[1].input!.clipboard,
      "restored",
      results[1].input!.warning,
    );
    probe = await read();
    assert.equal(probe.text, text);
    assert.equal(probe.clicks, 1);
    assert.ok(
      probe.events.some(
        (e: { type: string; trusted: boolean }) =>
          e.type === "paste" && e.trusted,
      ),
    );
    assert.equal(await clipboard.readText(), marker);
    const restored = (await clipboard.read())[0];
    assert.match(
      await (await restored.getType("text/html")).text(),
      /Creator fixture previous clipboard/,
    );
    assert.equal(
      await (await restored.getType("web application/x-rpa-fixture")).text(),
      "fixture-bytes",
    );
    const restoredImage = Buffer.from(
      await (await restored.getType("image/png")).arrayBuffer(),
    );
    assert.equal((await sharp(restoredImage).metadata()).width, 2);
    assert.deepEqual(
      await sharp(restoredImage).removeAlpha().raw().toBuffer(),
      Buffer.from(Array(4).fill([0x12, 0x34, 0x56]).flat()),
    );
  } finally {
    if ((await clipboard.readText()) === marker) {
      if (previous.length) await clipboard.write(previous);
      else clipboard.clear();
    }
  }
  pass(
    "real-native-paste-contenteditable-exact-Vietnamese-emoji-newlines-restores-text-html-custom-clipboard",
  );
  // Native focus can report false while routing/caret remain in the browser.
  const originalFocused = browser.view.webContents.isFocused.bind(
    browser.view.webContents,
  );
  browser.view.webContents.isFocused = () => false;
  try {
    const result = await browser.typeOnly(" thêm");
    assert.equal(result.focus.browser, false);
    assert.equal(result.focus.caret, "unknown");
    assert.equal((await read()).text, text + " thêm");
  } finally {
    browser.view.webContents.isFocused = originalFocused;
  }
  pass(
    "browser-native-focus-false-is-not-sole-rejection-when-browser-route-remains-active",
  );
  ui.focus();
  await wait();
  await assert.rejects(browser.typeOnly("must not type"), /focus/);
  assert.equal((await read()).text, text + " thêm");
  pass("sidebar-focus-blocks-TYPE_ONLY-without-auto-focus-or-click");
  await browser.navigate("http://127.0.0.1:47835/typing?no-caret");
  await wait(300);
  const noCaret = await runtime.testPair(first.id, second.id, 400);
  assert.equal(noCaret[1].status, "ACTION_SENT");
  assert.equal((await read()).text, "");
  assert.equal((await read()).active, "open");
  assert.equal(noCaret[1].input!.focus.caret, "unknown");
  pass(
    "click-only-opens-composer-without-caret-does-not-auto-focus-editable-or-claim-VERIFIED",
  );
  // Fail click closed; TYPE must never be attempted.
  const broken = store.saveStep(
    "Missing composer",
    {
      ...store.step(first.id, 1).payload,
      method: "ocr",
      target: {
        ...target,
        ocr: {
          confirmed: true,
          language: "vie+eng",
          kind: "line",
          text: "Missing label",
          confidence: 99,
          bbox: { x: 1, y: 1, width: 10, height: 10 },
        },
      },
    },
    first.id,
  );
  const blocked = await runtime.testPair(broken.id, second.id, 0);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].status, "BLOCKED");
  await assert.rejects(runtime.testPair(second.id, first.id, 400), /liên tiếp/);
  pass("pair-stops-before-TYPE-on-blocked-click-and-rejects-invalid-order");
  await mkdir(path.join(project, "artifacts"), { recursive: true });
  await writeFile(
    path.join(project, "artifacts", "browser-typing.json"),
    JSON.stringify(
      {
        phase: "typing",
        timestamp: new Date().toISOString(),
        status: "passed",
        passedCount: entries.length,
        pendingCount: 0,
        entries,
        fixtureOnly: true,
        facebookTested: false,
      },
      null,
      2,
    ),
  );
}
