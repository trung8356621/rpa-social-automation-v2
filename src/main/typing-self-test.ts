import { fixtureUi } from "./fixture-ui.js";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { clipboard, ClipboardItem, type BrowserWindow } from "electron";
import type { BrowserCore } from "./browser-core.js";
import type { Store } from "./storage.js";
import type { Runtime } from "./runtime.js";
import type { State, Result } from "../shared/contracts.js";
import { localOcr } from "./ocr.js";

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
  const ui = fixtureUi(window);
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
  await browser.view.webContents.executeJavaScript(
    "document.querySelector('#open').style.background='#c2d2e8'",
  );
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
  // Composer is opened by its own CLICK; author/test the new action from sidebar.
  await browser.navigate("http://127.0.0.1:47835/typing?no-caret");
  await wait(200);
  browser.click(300, 132);
  await wait(400);
  assert.equal((await read()).active, "open");
  await click("Tạo flow");
  const select = async (label: string, value: string) => {
    await evaluate(
      `(()=>{const s=document.querySelector('[aria-label="${label}"]');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`,
    );
    await wait();
  };
  await select("Action", "CLICK_AND_TYPE");
  await select("Phương thức nhập", "keyboard");
  await click("Chụp & crop ROI");
  await until(
    () => evaluate("!!document.querySelector('.snapshot')"),
    "new action crop",
  );
  const r = await evaluate(
    "(()=>{const r=document.querySelector('.snapshot').getBoundingClientRect();return{x:r.x,y:r.y}})()",
  );
  ui.sendInputEvent({
    type: "mouseDown",
    x: r.x + 120,
    y: r.y + 220,
    button: "left",
    clickCount: 1,
  });
  ui.sendInputEvent({
    type: "mouseMove",
    x: r.x + 770,
    y: r.y + 320,
    button: "left",
  });
  ui.sendInputEvent({
    type: "mouseUp",
    x: r.x + 770,
    y: r.y + 320,
    button: "left",
    clickCount: 1,
  });
  await until(
    () => evaluate("!!document.querySelector('.roi')"),
    "new action ROI",
  );
  await click("Dùng ROI");
  assert.ok(
    await evaluate(
      "document.querySelector('.ocr-candidates').textContent.includes('Viết bản nháp ở đây')",
    ),
  );
  await click("Viết bản nháp ở đây");
  await click("Lưu Base v1");
  const combinedRef = store.flow()!.steps[0];
  const combinedBase = store.step(combinedRef.id, 1);
  assert.equal(combinedBase.payload.action, "CLICK_AND_TYPE");
  assert.equal(combinedBase.payload.text, text);
  captures = 0;
  browser.capture = async () => {
    captures++;
    return originalCapture();
  };
  try {
    await click("Test step đã lưu");
  } finally {
    browser.capture = originalCapture;
  }
  probe = await read();
  assert.equal(probe.text, text);
  assert.equal(probe.editorClicks, 1);
  assert.deepEqual(probe.clickDetails, [1]);
  assert.equal(probe.doubleClicks, 0);
  assert.equal(
    probe.clicks,
    1,
    "opening composer is a separate click, never replayed by CLICK_AND_TYPE",
  );
  assert.equal(probe.active, "editor");
  assert.equal(browser.view.webContents.isFocused(), true);
  assert.equal(
    captures,
    1,
    "only recognition screenshot, none between focus click and typing",
  );
  assert.match(
    await evaluate("document.querySelector('.result').textContent"),
    /ACTION_SENT.*Image Matching/s,
  );
  await click("Đúng — Hoàn thành Step");
  assert.match(
    await evaluate("document.querySelector('.result').textContent"),
    /VERIFIED/,
  );
  pass(
    "CLICK_AND_TYPE-authored-Action-first-crop-OCR-single-click-keyboard-from-sidebar-composer-open-no-manual-caret",
  );
  // AUTO changes resolver at runtime, without saving/redesigning the Step.
  await browser.navigate("http://127.0.0.1:47835/typing?no-caret");
  await wait(200);
  browser.click(300, 132);
  await wait(400);
  await browser.view.webContents.executeJavaScript(
    "document.querySelector('#editor').style.background='#c2d2e8'",
  );
  assert.equal(
    await evaluate(
      "!!document.querySelector('[aria-label=\"Phương thức nhận diện\"]')",
    ),
    false,
  );
  await click("Test step đã lưu");
  const fallbackRun = JSON.parse(
    (
      store.db
        .prepare("SELECT payload FROM runs ORDER BY rowid DESC LIMIT 1")
        .get() as { payload: string }
    ).payload,
  ) as Result;
  assert.equal(fallbackRun.match!.method, "ocr");
  assert.ok(fallbackRun.resolution!.fallbackReason);
  assert.equal((await read()).text, text);
  assert.equal((await read()).editorClicks, 1);
  assert.equal((await read()).doubleClicks, 0);
  assert.deepEqual(store.step(combinedRef.id, 1), combinedBase);
  assert.equal(store.steps().filter((s) => s.id === combinedRef.id).length, 1);
  assert.equal(
    await evaluate("document.querySelector('.debug-details').open"),
    false,
  );
  await evaluate("document.querySelector('.debug-details summary').click()");
  assert.equal(
    await evaluate("document.querySelector('.debug-details').open"),
    true,
  );
  assert.match(
    await evaluate("document.querySelector('.resolver-trace').textContent"),
    /Lý do fallback:.*Image score/s,
  );
  pass(
    "AUTO-image-to-OCR-fallback-same-Step-version-single-click-and-technical-trace-only-in-Debug",
  );
  // Reset only as fixture setup; runtime never navigates or clears the page.
  await browser.navigate("http://127.0.0.1:47835/typing?no-caret");
  await wait(200);
  browser.click(300, 132);
  await wait(400);
  const oldClipboard = await Promise.all(
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
  const combinedMarker = "CLICK_AND_TYPE old clipboard";
  try {
    await clipboard.writeText(combinedMarker);
    await select("Phương thức nhập", "clipboard");
    await click("Lưu redesign");
    await click("Test step đã lưu");
    probe = await read();
    assert.equal(probe.text, text);
    assert.equal(probe.editorClicks, 1);
    assert.equal(probe.doubleClicks, 0);
    assert.equal(await clipboard.readText(), combinedMarker);
    assert.match(
      await evaluate("document.querySelector('.result').textContent"),
      /Clipboard paste.*restored/s,
    );
    assert.deepEqual(store.step(combinedRef.id, 1), combinedBase);
  } finally {
    if ((await clipboard.readText()) === combinedMarker) {
      if (oldClipboard.length) await clipboard.write(oldClipboard);
      else clipboard.clear();
    }
  }
  pass(
    "CLICK_AND_TYPE-clipboard-native-paste-restores-clipboard-redesign-v2-keeps-v1",
  );
  // Recognition must block both the focus click and typing, not just the latter.
  const recognize = localOcr.recognize.bind(localOcr);
  try {
    for (const mode of ["low", "duplicate", "failure"]) {
      await browser.navigate("http://127.0.0.1:47835/typing?no-caret");
      await wait(200);
      browser.click(300, 132);
      await wait(400);
      await browser.view.webContents.executeJavaScript(
        "document.querySelector('#editor').style.background='#c2d2e8'",
      );
      const clicksBefore = (await read()).editorClicks,
        textBefore = (await read()).text;
      localOcr.recognize = async (image) => {
        if (mode === "failure") throw Error("fixture OCR failure");
        const result = await recognize(image);
        assert.ok(
          result.segments.some((s) => s.text === "Viết bản nháp ở đây"),
          "fixture has the selected text before confidence/ambiguity injection",
        );
        return {
          ...result,
          segments:
            mode === "low"
              ? result.segments.map((s) => ({ ...s, confidence: 20 }))
              : [...result.segments, ...result.segments],
        };
      };
      await click("Test step đã lưu");
      assert.match(
        await evaluate("document.querySelector('.result').textContent"),
        /BLOCKED/,
      );
      const last = JSON.parse(
        (
          store.db
            .prepare("SELECT payload FROM runs ORDER BY rowid DESC LIMIT 1")
            .get() as { payload: string }
        ).payload,
      ) as Result;
      assert.equal(last.clickSent, false);
      assert.equal(last.input, undefined);
      assert.match(
        last.resolution!.attempts.at(-1)!.reason!,
        mode === "low"
          ? /confidence/
          : mode === "duplicate"
            ? /nhiều/
            : /fixture OCR failure/,
      );
      await until(
        () =>
          evaluate(
            "document.querySelector('[role=status]').textContent.includes('Redesign')",
          ),
        "auto-open redesign for uncertain OCR",
      );
      assert.equal((await read()).editorClicks, clicksBefore);
      assert.equal((await read()).text, textBefore);
    }
  } finally {
    localOcr.recognize = recognize;
  }
  await click("Redesign Step bị chặn");
  assert.equal(
    await evaluate("document.querySelector('[aria-label=\"Action\"]').value"),
    "CLICK_AND_TYPE",
  );
  assert.deepEqual(store.step(combinedRef.id, 1), combinedBase);
  assert.equal(
    store.steps().filter((s) => s.id === combinedRef.id).length,
    2,
    "opening redesign never auto-saves",
  );
  pass(
    "CLICK_AND_TYPE-OCR-low-duplicate-error-block-before-click-and-type-open-Redesign-without-mutating-Base",
  );
  const base2 = store.step(combinedRef.id, 2);
  await browser.view.webContents.executeJavaScript(
    "document.querySelector('#editor').style.background=''",
  );
  await click("Lưu form thành Override riêng");
  await click("Test step đã lưu");
  probe = await read();
  assert.equal(probe.text, text);
  assert.equal(probe.editorClicks, 1);
  assert.equal(probe.doubleClicks, 0);
  assert.match(
    await evaluate("document.querySelector('.result').textContent"),
    /ACTION_SENT.*Override.*Image Matching/s,
  );
  assert.deepEqual(store.step(combinedRef.id, 2), base2);
  await click("Sai — Redesign Step");
  assert.match(
    await evaluate("document.querySelector('.result').textContent"),
    /REJECTED/,
  );
  assert.deepEqual(store.step(combinedRef.id, 2), base2);
  pass(
    "CLICK_AND_TYPE-image-Override-single-click-paste-and-manual-rejection-preserve-Base",
  );
  await browser.navigate("http://127.0.0.1:47835/typing?no-caret");
  await wait(200);
  browser.click(300, 132);
  await wait(400);
  try {
    localOcr.recognize = async (image) => {
      const result = await recognize(image);
      return {
        ...result,
        segments: result.segments.map((s) => ({
          ...s,
          bbox: { ...s.bbox, x: s.bbox.x + 100 },
        })),
      };
    };
    await click("Test step đã lưu");
    const conflict = JSON.parse(
      (
        store.db
          .prepare("SELECT payload FROM runs ORDER BY rowid DESC LIMIT 1")
          .get() as { payload: string }
      ).payload,
    ) as Result;
    assert.equal(conflict.status, "BLOCKED");
    assert.equal(conflict.clickSent, false);
    assert.match(conflict.resolution!.blockedReason!, /mâu thuẫn/);
    assert.equal((await read()).editorClicks, 0);
    assert.equal((await read()).text, "");
  } finally {
    localOcr.recognize = recognize;
  }
  pass("AUTO-conflicting-image-and-OCR-block-before-any-click-or-input");
  await evaluate(
    "document.querySelector('.result').scrollIntoView({block:'start'})",
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
    .toFile(path.join(project, "artifacts", "click-and-type-review.png"));
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
