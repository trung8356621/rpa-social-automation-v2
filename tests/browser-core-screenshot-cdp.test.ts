import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  CdpDebuggerSession,
  type CdpDebuggerLike,
  type CdpWebContentsLike,
} from "../src/main/cdp-debugger-session.js";
import { captureScreenshotBufferViaCdp } from "../src/main/cdp-screenshot.js";

type MockDebugger = EventEmitter &
  CdpDebuggerLike & {
    attached: boolean;
    attachCalls: number;
    detachCalls: number;
    commands: string[];
    failCapture?: Error;
    emptyCapture?: boolean;
  };

/** Minimal valid 1x1 PNG. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

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
    if (method === "Page.captureScreenshot") {
      if (ee.failCapture) throw ee.failCapture;
      if (ee.emptyCapture) return { data: "" };
      return { data: TINY_PNG.toString("base64") };
    }
    return {};
  };
  return ee;
}

function createWc(dbg: MockDebugger, destroyed = false): CdpWebContentsLike {
  return { debugger: dbg, isDestroyed: () => destroyed };
}

function sessionFor(dbg: MockDebugger, destroyed = false): CdpDebuggerSession {
  const session = new CdpDebuggerSession({ detachWhenIdle: false });
  session.bindWebContents(createWc(dbg, destroyed));
  return session;
}

test("1. screenshot success without other consumers", async () => {
  const dbg = createMockDebugger(false);
  const cdp = sessionFor(dbg);
  const raw = await captureScreenshotBufferViaCdp({
    cdp,
    capturePagePng: async () => {
      throw new Error("fallback should not run");
    },
  });
  assert.equal(Buffer.compare(raw, TINY_PNG), 0);
  assert.ok(dbg.commands.includes("Page.captureScreenshot"));
  assert.equal(cdp.diagnostics().leaseCount, 0);
  assert.equal(dbg.detachCalls, 0); // detachWhenIdle:false
  assert.equal(dbg.attached, true);
});

test("2. screenshot failure uses capturePage fallback without detach", async () => {
  const dbg = createMockDebugger(false);
  dbg.failCapture = new Error("CDP screenshot failed");
  const cdp = sessionFor(dbg);
  let fallbackCalls = 0;
  const raw = await captureScreenshotBufferViaCdp({
    cdp,
    capturePagePng: async () => {
      fallbackCalls += 1;
      return Buffer.from(TINY_PNG);
    },
  });
  assert.equal(fallbackCalls, 1);
  assert.equal(Buffer.compare(raw, TINY_PNG), 0);
  assert.equal(dbg.detachCalls, 0);
  assert.equal(dbg.attached, true);
  assert.equal(cdp.diagnostics().leaseCount, 0);
});

test("3. screenshot while another debugger consumer lease is active", async () => {
  const dbg = createMockDebugger(false);
  const cdp = sessionFor(dbg);
  const peer = await cdp.acquire("screencast");
  const raw = await captureScreenshotBufferViaCdp({
    cdp,
    capturePagePng: async () => {
      throw new Error("fallback should not run");
    },
  });
  assert.equal(Buffer.compare(raw, TINY_PNG), 0);
  assert.equal(peer.alive, true);
  assert.equal(dbg.detachCalls, 0);
  assert.equal(dbg.attached, true);
  await peer.release();
  assert.equal(dbg.detachCalls, 0); // still transitional no-detach
});

test("4. screenshot failure while another consumer is active does not detach", async () => {
  const dbg = createMockDebugger(false);
  dbg.failCapture = new Error("timeout");
  const cdp = sessionFor(dbg);
  const peer = await cdp.acquire("fileChooser");
  const beforeListeners = dbg.listenerCount("message");
  const raw = await captureScreenshotBufferViaCdp({
    cdp,
    capturePagePng: async () => Buffer.from(TINY_PNG),
  });
  assert.equal(Buffer.compare(raw, TINY_PNG), 0);
  assert.equal(peer.alive, true);
  assert.equal(dbg.detachCalls, 0);
  assert.equal(dbg.listenerCount("message"), beforeListeners);
  await peer.release();
});

test("5. already-attached debugger must not be detached", async () => {
  const dbg = createMockDebugger(true);
  const cdp = sessionFor(dbg);
  await captureScreenshotBufferViaCdp({
    cdp,
    capturePagePng: async () => {
      throw new Error("no fallback");
    },
  });
  dbg.failCapture = new Error("fail");
  await captureScreenshotBufferViaCdp({
    cdp,
    capturePagePng: async () => Buffer.from(TINY_PNG),
  });
  assert.equal(dbg.attachCalls, 0);
  assert.equal(dbg.detachCalls, 0);
  assert.equal(dbg.attached, true);
  assert.equal(cdp.diagnostics().adapterOwnsAttach, false);
});

test("6. repeated screenshots must not leak leases", async () => {
  const dbg = createMockDebugger(false);
  const cdp = sessionFor(dbg);
  for (let i = 0; i < 8; i++) {
    await captureScreenshotBufferViaCdp({
      cdp,
      capturePagePng: async () => Buffer.from(TINY_PNG),
    });
  }
  dbg.failCapture = new Error("x");
  for (let i = 0; i < 4; i++) {
    await captureScreenshotBufferViaCdp({
      cdp,
      capturePagePng: async () => Buffer.from(TINY_PNG),
    });
  }
  assert.equal(cdp.diagnostics().leaseCount, 0);
  assert.equal(cdp.diagnostics().messageListenerCount, 0);
  assert.equal(dbg.detachCalls, 0);
});

test("7. CDP and fallback both fail → original CDP error (no silent success)", async () => {
  const dbg = createMockDebugger(false);
  dbg.failCapture = new Error("Screenshot timeout: không có frame sau 4 giây.");
  const cdp = sessionFor(dbg);
  await assert.rejects(
    () =>
      captureScreenshotBufferViaCdp({
        cdp,
        capturePagePng: async () => {
          throw new Error("capturePage also failed");
        },
      }),
    /Screenshot timeout/,
  );
  assert.equal(cdp.diagnostics().leaseCount, 0);
  assert.equal(dbg.detachCalls, 0);
});

test("7b. empty CDP frame tries fallback; empty fallback still errors", async () => {
  const dbg = createMockDebugger(false);
  dbg.emptyCapture = true;
  const cdp = sessionFor(dbg);
  await assert.rejects(
    () =>
      captureScreenshotBufferViaCdp({
        cdp,
        capturePagePng: async () => Buffer.alloc(0),
      }),
    /ảnh rỗng|Browser trả về/,
  );
  assert.equal(cdp.diagnostics().leaseCount, 0);
});

test("8. replaced WebContents fails safely without detach steal on old dbg", async () => {
  const dbg1 = createMockDebugger(false);
  const dbg2 = createMockDebugger(false);
  const cdp = new CdpDebuggerSession({ detachWhenIdle: false });
  cdp.bindWebContents(createWc(dbg1));
  cdp.onViewWillReplace("session-switch");
  await assert.rejects(
    () =>
      captureScreenshotBufferViaCdp({
        cdp,
        capturePagePng: async () => {
          throw new Error("fallback unavailable");
        },
      }),
    /not bound|replaced|destroyed|not alive|acquire/i,
  );
  assert.equal(dbg1.detachCalls, 0);
  cdp.bindWebContents(createWc(dbg2));
  const raw = await captureScreenshotBufferViaCdp({
    cdp,
    capturePagePng: async () => {
      throw new Error("no fallback");
    },
  });
  assert.equal(Buffer.compare(raw, TINY_PNG), 0);
});

test("9. Capture result shape fields remain compatible (helper buffer + contract constants)", async () => {
  // contracts.Capture.backend is literally "cdp-surface"; screenshot path must keep that.
  const shape = {
    id: "00000000-0000-0000-0000-000000000001",
    width: 1280,
    height: 720,
    zoom: 1,
    url: "https://example.com/",
    timestamp: new Date().toISOString(),
    backend: "cdp-surface" as const,
    dataUrl: `data:image/png;base64,${TINY_PNG.toString("base64")}`,
  };
  assert.equal(shape.backend, "cdp-surface");
  assert.match(shape.dataUrl, /^data:image\/png;base64,/);
  assert.equal(typeof shape.id, "string");
  assert.equal(typeof shape.timestamp, "string");
});

test("10. transitional policy: detachWhenIdle false never detaches after screenshot lease ends", async () => {
  const dbg = createMockDebugger(false);
  const cdp = sessionFor(dbg);
  assert.equal(cdp.diagnostics().adapterOwnsAttach, false);
  await captureScreenshotBufferViaCdp({
    cdp,
    capturePagePng: async () => Buffer.from(TINY_PNG),
  });
  // Adapter may own attach flag while idle, but must not detach under transitional policy.
  assert.equal(dbg.detachCalls, 0);
  assert.equal(dbg.attached, true);
});

test("timeout path uses fallback and releases lease", async () => {
  const dbg = createMockDebugger(false);
  // Hang captureScreenshot until timeout.
  dbg.sendCommand = async (method) => {
    dbg.commands.push(method);
    if (method === "Page.captureScreenshot") {
      await new Promise(() => {});
    }
    return {};
  };
  const cdp = sessionFor(dbg);
  const raw = await captureScreenshotBufferViaCdp({
    cdp,
    timeoutMs: 30,
    capturePagePng: async () => Buffer.from(TINY_PNG),
  });
  assert.equal(Buffer.compare(raw, TINY_PNG), 0);
  assert.equal(cdp.diagnostics().leaseCount, 0);
  assert.equal(dbg.detachCalls, 0);
});
