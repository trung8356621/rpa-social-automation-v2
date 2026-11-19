import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CdpDebuggerSession,
  requireCdpSessionForDebugger,
  type CdpDebuggerLike,
  type CdpWebContentsLike,
} from "../src/main/cdp-debugger-session.js";
import { captureScreenshotBufferViaCdp } from "../src/main/cdp-screenshot.js";
import { chooseUploadFiles } from "../src/main/file-chooser.js";
import { BrowserRecording } from "../src/main/browser-recording.js";

type MockDebugger = EventEmitter &
  CdpDebuggerLike & {
    attached: boolean;
    attachCalls: number;
    detachCalls: number;
    commands: string[];
    failStartScreencast?: Error;
  };

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const CASE_ID = "11111111-1111-1111-1111-111111111111";
const RUN_ID = "22222222-2222-2222-2222-222222222222";

function createMockDebugger(preAttached = false): MockDebugger {
  const ee = new EventEmitter() as MockDebugger;
  ee.attached = preAttached;
  ee.attachCalls = 0;
  ee.detachCalls = 0;
  ee.commands = [];
  ee.isAttached = () => ee.attached;
  ee.attach = () => {
    ee.attachCalls += 1;
    ee.attached = true;
  };
  ee.detach = () => {
    ee.detachCalls += 1;
    ee.attached = false;
    ee.emit("detach", "simulated");
  };
  ee.sendCommand = async (method) => {
    ee.commands.push(method);
    if (method === "Page.startScreencast" && ee.failStartScreencast) {
      throw ee.failStartScreencast;
    }
    if (method === "Page.captureScreenshot") {
      return { data: TINY_PNG.toString("base64") };
    }
    return {};
  };
  return ee;
}

function bindSession(dbg: MockDebugger): CdpDebuggerSession {
  const session = new CdpDebuggerSession({ detachWhenIdle: false });
  const wc: CdpWebContentsLike = { debugger: dbg, isDestroyed: () => false };
  session.bindWebContents(wc);
  return session;
}

function fakeBrowser(dbg: MockDebugger) {
  return { debugger: dbg } as import("electron").WebContents;
}

function fakeShell() {
  const events: Array<{ type: string; token?: string }> = [];
  const shell = {
    send(_channel: string, payload: { type: string; token?: string }) {
      events.push({ type: payload.type, token: payload.token });
    },
    events,
  };
  return shell as unknown as import("electron").WebContents & {
    events: typeof events;
  };
}

async function withTempRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rpa-rec-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function startRecordingReady(
  recorder: BrowserRecording,
  browser: import("electron").WebContents,
  runId: string = RUN_ID,
) {
  const startPromise = recorder.start(browser, CASE_ID, runId);
  // start() awaits mkdir/open before publishing active — poll for the encoder handshake token.
  let token: string | undefined;
  for (let i = 0; i < 100; i++) {
    token = (recorder as unknown as { active?: { token: string } }).active?.token;
    if (token) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(token, "recording active token never published");
  await recorder.receive(token!, "ready");
  await startPromise;
  return token!;
}

test("1. recording alone start/stop without detach", async () => {
  await withTempRoot(async (root) => {
    const dbg = createMockDebugger(false);
    bindSession(dbg);
    const shell = fakeShell();
    const recorder = new BrowserRecording(shell, root);
    const token = await startRecordingReady(recorder, fakeBrowser(dbg));
    assert.ok(dbg.commands.includes("Page.startScreencast"));
    assert.equal(requireCdpSessionForDebugger(dbg).diagnostics().leaseCount, 1);
    dbg.emit("message", {}, "Page.screencastFrame", { data: "abc", sessionId: 1 }, "");
    await recorder.receive(token, "chunk", Buffer.from("webm").toString("base64"));
    await recorder.receive(token, "done");
    const stopped = await recorder.stop();
    assert.ok(stopped?.videoPath);
    assert.equal(requireCdpSessionForDebugger(dbg).diagnostics().leaseCount, 0);
    assert.equal(dbg.detachCalls, 0);
    assert.ok(dbg.commands.includes("Page.stopScreencast"));
  });
});

test("2. file chooser alone", async () => {
  const dbg = createMockDebugger(true);
  const cdp = bindSession(dbg);
  const result = await chooseUploadFiles(
    cdp,
    ["a.png"],
    () => {
      queueMicrotask(() =>
        dbg.emit(
          "message",
          {},
          "Page.fileChooserOpened",
          { mode: "selectSingle", backendNodeId: 7 },
          "",
        ),
      );
    },
    100,
  );
  assert.equal(result.assignedCount, 1);
  assert.equal(cdp.diagnostics().leaseCount, 0);
  assert.equal(dbg.detachCalls, 0);
});

test("3. recording + screenshot coexistence", async () => {
  await withTempRoot(async (root) => {
    const dbg = createMockDebugger(false);
    const cdp = bindSession(dbg);
    const shell = fakeShell();
    const recorder = new BrowserRecording(shell, root);
    const token = await startRecordingReady(recorder, fakeBrowser(dbg));
    const shot = await captureScreenshotBufferViaCdp({
      cdp,
      capturePagePng: async () => {
        throw new Error("fallback unused");
      },
    });
    assert.equal(Buffer.compare(shot, TINY_PNG), 0);
    assert.equal(cdp.diagnostics().leaseCount, 1); // recording still holds
    await recorder.receive(token, "chunk", Buffer.from("x").toString("base64"));
    await recorder.receive(token, "done");
    await recorder.stop();
    assert.equal(dbg.detachCalls, 0);
    assert.equal(cdp.diagnostics().leaseCount, 0);
  });
});

test("4. file chooser + screenshot coexistence", async () => {
  const dbg = createMockDebugger(false);
  const cdp = bindSession(dbg);
  const chooserPromise = chooseUploadFiles(
    cdp,
    ["a.png"],
    () => {
      queueMicrotask(() =>
        dbg.emit(
          "message",
          {},
          "Page.fileChooserOpened",
          { mode: "selectSingle", backendNodeId: 3 },
          "",
        ),
      );
    },
    200,
  );
  await Promise.resolve();
  const shot = await captureScreenshotBufferViaCdp({
    cdp,
    capturePagePng: async () => Buffer.from(TINY_PNG),
  });
  assert.equal(Buffer.compare(shot, TINY_PNG), 0);
  const result = await chooserPromise;
  assert.equal(result.assignedCount, 1);
  assert.equal(dbg.detachCalls, 0);
  assert.equal(cdp.diagnostics().leaseCount, 0);
});

test("5. recording + file chooser lifecycle overlap", async () => {
  await withTempRoot(async (root) => {
    const dbg = createMockDebugger(false);
    const cdp = bindSession(dbg);
    const recorder = new BrowserRecording(fakeShell(), root);
    const token = await startRecordingReady(recorder, fakeBrowser(dbg));
    const result = await chooseUploadFiles(
      cdp,
      ["a.png"],
      () => {
        queueMicrotask(() =>
          dbg.emit(
            "message",
            {},
            "Page.fileChooserOpened",
            { mode: "selectSingle", backendNodeId: 9 },
            "",
          ),
        );
      },
      100,
    );
    assert.equal(result.assignedCount, 1);
    assert.ok(cdp.diagnostics().leaseCount >= 1);
    await recorder.receive(token, "chunk", Buffer.from("y").toString("base64"));
    await recorder.receive(token, "done");
    await recorder.stop();
    assert.equal(dbg.detachCalls, 0);
    assert.equal(cdp.diagnostics().leaseCount, 0);
  });
});

test("6. recording startup failure releases lease and does not detach", async () => {
  await withTempRoot(async (root) => {
    const dbg = createMockDebugger(false);
    dbg.failStartScreencast = new Error("screencast denied");
    const cdp = bindSession(dbg);
    const recorder = new BrowserRecording(fakeShell(), root);
    await assert.rejects(
      () => startRecordingReady(recorder, fakeBrowser(dbg)),
      /screencast denied/,
    );
    assert.equal(cdp.diagnostics().leaseCount, 0);
    assert.equal(dbg.detachCalls, 0);
  });
});

test("7. file chooser timeout cleans up without detach", async () => {
  const dbg = createMockDebugger(true);
  const cdp = bindSession(dbg);
  await assert.rejects(
    () => chooseUploadFiles(cdp, ["a.png"], () => {}, 15),
    /Không nhận được file chooser/,
  );
  assert.equal(cdp.diagnostics().leaseCount, 0);
  assert.equal(dbg.detachCalls, 0);
  assert.ok(
    dbg.commands.includes("Page.setInterceptFileChooserDialog"),
  );
});

test("8. unexpected debugger detach fails chooser and recording safely", async () => {
  const dbg = createMockDebugger(false);
  const cdp = bindSession(dbg);
  await assert.rejects(
    () =>
      chooseUploadFiles(
        cdp,
        ["a.png"],
        () => {
          queueMicrotask(() => {
            dbg.attached = false;
            dbg.emit("detach", "devtools");
          });
        },
        200,
      ),
    /Debugger bị ngắt/,
  );
  assert.equal(cdp.diagnostics().leaseCount, 0);

  await withTempRoot(async (root) => {
    const dbg2 = createMockDebugger(false);
    const cdp2 = bindSession(dbg2);
    const recorder = new BrowserRecording(fakeShell(), root);
    const token = await startRecordingReady(recorder, fakeBrowser(dbg2));
    dbg2.attached = false;
    dbg2.emit("detach", "devtools");
    await recorder.receive(token, "done").catch(() => undefined);
    await assert.rejects(() => recorder.stop(), /Debugger bị ngắt|No recording/);
    assert.equal(cdp2.diagnostics().leaseCount, 0);
  });
});

test("9. browser session switch invalidates recording/chooser leases", async () => {
  await withTempRoot(async (root) => {
    const dbg = createMockDebugger(false);
    const cdp = bindSession(dbg);
    const recorder = new BrowserRecording(fakeShell(), root);
    await startRecordingReady(recorder, fakeBrowser(dbg));
    cdp.onViewWillReplace("session-switch");
    await assert.rejects(() => recorder.stop(), /Debugger bị ngắt|No recording|not alive/i);
    assert.equal(cdp.diagnostics().leaseCount, 0);

    const dbg2 = createMockDebugger(false);
    const cdp2 = bindSession(dbg2);
    const pending = chooseUploadFiles(
      cdp2,
      ["a.png"],
      () => {
        // Invalidate mid-chooser after intercept is armed.
        queueMicrotask(() => cdp2.onViewWillReplace("session-switch"));
      },
      200,
    );
    await assert.rejects(
      () => pending,
      /Debugger bị ngắt|not alive|replaced|not bound/i,
    );
  });
});

test("10. repeated recording start/stop without listener leaks", async () => {
  await withTempRoot(async (root) => {
    const dbg = createMockDebugger(false);
    const cdp = bindSession(dbg);
    const recorder = new BrowserRecording(fakeShell(), root);
    for (let i = 0; i < 3; i++) {
      const runId = `22222222-2222-2222-2222-22222222222${i}`;
      const token = await startRecordingReady(recorder, fakeBrowser(dbg), runId);
      await recorder.receive(token, "chunk", Buffer.from("z").toString("base64"));
      await recorder.receive(token, "done");
      await recorder.stop();
    }
    assert.equal(cdp.diagnostics().leaseCount, 0);
    assert.equal(cdp.diagnostics().messageListenerCount, 0);
    assert.equal(dbg.listenerCount("message"), 0);
    assert.equal(dbg.detachCalls, 0);
  });
});

test("11. screenshot failure while recording does not detach or kill screencast lease", async () => {
  await withTempRoot(async (root) => {
    const dbg = createMockDebugger(false);
    const cdp = bindSession(dbg);
    const recorder = new BrowserRecording(fakeShell(), root);
    const token = await startRecordingReady(recorder, fakeBrowser(dbg));
    const originalSend = dbg.sendCommand.bind(dbg);
    dbg.sendCommand = async (method, params, sessionId) => {
      if (method === "Page.captureScreenshot") throw new Error("shot failed");
      return originalSend(method, params, sessionId);
    };
    const shot = await captureScreenshotBufferViaCdp({
      cdp,
      capturePagePng: async () => Buffer.from(TINY_PNG),
    });
    assert.equal(Buffer.compare(shot, TINY_PNG), 0);
    assert.equal(cdp.diagnostics().leaseCount, 1);
    assert.equal(dbg.detachCalls, 0);
    dbg.emit("message", {}, "Page.screencastFrame", { data: "f", sessionId: 2 }, "");
    await recorder.receive(token, "chunk", Buffer.from("ok").toString("base64"));
    await recorder.receive(token, "done");
    await recorder.stop();
    assert.equal(dbg.detachCalls, 0);
  });
});

test("shared adapter registry resolves the same BrowserCore-bound session", () => {
  const dbg = createMockDebugger(false);
  const cdp = bindSession(dbg);
  assert.equal(requireCdpSessionForDebugger(dbg), cdp);
});
