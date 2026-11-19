import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  CdpDebuggerSession,
  getCdpSessionForDebugger,
  requireCdpSessionForDebugger,
  type CdpDebuggerLike,
  type CdpWebContentsLike,
} from "../src/main/cdp-debugger-session.js";
import { captureScreenshotBufferViaCdp } from "../src/main/cdp-screenshot.js";
import { chooseUploadFiles } from "../src/main/file-chooser.js";

type MockDebugger = EventEmitter &
  CdpDebuggerLike & {
    attached: boolean;
    attachCalls: number;
    detachCalls: number;
    commands: string[];
    id: string;
  };

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function createMockDebugger(id: string, preAttached = false): MockDebugger {
  const ee = new EventEmitter() as MockDebugger;
  ee.id = id;
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
      return { data: TINY_PNG.toString("base64") };
    }
    return {};
  };
  return ee;
}

function wc(dbg: MockDebugger, destroyed = false): CdpWebContentsLike {
  return { debugger: dbg, isDestroyed: () => destroyed };
}

/** Mirrors BrowserCore.switchPartition CDP ordering after C2B.4. */
function switchSessionLike(
  session: CdpDebuggerSession,
  nextDbg: MockDebugger,
): void {
  session.onViewWillReplace("session-switch");
  session.bindWebContents(wc(nextDbg));
}

test("1. same-session navigation retains valid leases (URL change is not view replace)", async () => {
  const dbg = createMockDebugger("A");
  const session = new CdpDebuggerSession({ detachWhenIdle: false });
  session.bindWebContents(wc(dbg));
  const lease = await session.acquire("collectorNetwork");
  const gen = lease.generation;
  const seen: string[] = [];
  session.onMessage(lease, (_e, method) => seen.push(method));

  // navigate() only loadURL — must not call onViewWillReplace.
  assert.equal(lease.alive, true);
  assert.equal(lease.generation, gen);
  dbg.emit("message", {}, "Network.requestWillBeSent", { url: "https://a/1" }, "");
  dbg.emit("message", {}, "Network.requestWillBeSent", { url: "https://a/2" }, "");
  assert.deepEqual(seen, ["Network.requestWillBeSent", "Network.requestWillBeSent"]);
  assert.equal(session.diagnostics().generation, gen);
  await lease.release();
});

test("2. Browser Session A → B invalidates A ownership", async () => {
  const a = createMockDebugger("A");
  const b = createMockDebugger("B");
  const session = new CdpDebuggerSession({ detachWhenIdle: false });
  session.bindWebContents(wc(a));
  const leaseA = await session.acquire("screenshot");
  const notices: string[] = [];
  session.onUnexpectedDetach((info) => notices.push(String(info.reason)));

  switchSessionLike(session, b);
  assert.equal(leaseA.alive, false);
  assert.equal(leaseA.failReason, "view-replaced");
  assert.equal(getCdpSessionForDebugger(a), undefined);
  assert.equal(requireCdpSessionForDebugger(b), session);
  assert.ok(notices.some((r) => /session-switch|view-session-switch/i.test(r)));
});

test("3. old A events are not delivered after bind to B", async () => {
  const a = createMockDebugger("A");
  const b = createMockDebugger("B");
  const session = new CdpDebuggerSession({ detachWhenIdle: false });
  session.bindWebContents(wc(a));
  const leaseA = await session.acquire("screencast");
  const fromA: string[] = [];
  session.onMessage(leaseA, (_e, method) => fromA.push(method));

  switchSessionLike(session, b);
  const leaseB = await session.acquire("screencast");
  const fromB: string[] = [];
  session.onMessage(leaseB, (_e, method) => fromB.push(method));

  a.emit("message", {}, "Page.screencastFrame", { data: "old" }, "");
  b.emit("message", {}, "Page.screencastFrame", { data: "new" }, "");
  assert.deepEqual(fromA, []);
  assert.deepEqual(fromB, ["Page.screencastFrame"]);
  await leaseB.release();
});

test("4. old pending acquire cannot revive a stale session", async () => {
  const a = createMockDebugger("A");
  const session = new CdpDebuggerSession({ detachWhenIdle: false });
  session.bindWebContents(wc(a));
  const pending = session.acquire("collectorNetwork");
  await Promise.resolve();
  session.onViewWillReplace("session-switch");
  const settled = await pending.then(
    (lease) => ({ ok: true as const, lease }),
    (error: Error) => ({ ok: false as const, error }),
  );
  if (settled.ok) assert.equal(settled.lease.alive, false);
  assert.equal(session.diagnostics().leaseCount, 0);
  assert.equal(getCdpSessionForDebugger(a), undefined);
});

test("5. destroyed WebContents invalidates outstanding leases", async () => {
  const dbg = createMockDebugger("X");
  const session = new CdpDebuggerSession({ detachWhenIdle: false });
  session.bindWebContents(wc(dbg));
  const lease = await session.acquire("fileChooser");
  session.onViewWillReplace("destroy");
  assert.equal(lease.alive, false);
  assert.equal(lease.failReason, "destroyed");
  assert.equal(session.diagnostics().leaseCount, 0);
  assert.equal(getCdpSessionForDebugger(dbg), undefined);
});

test("6. unexpected debugger detach notifies consumers and does not reattach", async () => {
  const dbg = createMockDebugger("D");
  const session = new CdpDebuggerSession({ detachWhenIdle: false });
  session.bindWebContents(wc(dbg));
  const notices: Array<{ reason?: string }> = [];
  session.onUnexpectedDetach((info) => notices.push(info));
  const lease = await session.acquire("screenshot");
  const attachBefore = dbg.attachCalls;
  dbg.attached = false;
  dbg.emit("detach", "replaced_with_devtools");
  assert.equal(lease.alive, false);
  assert.equal(lease.failReason, "unexpected-detach");
  assert.equal(notices.length, 1);
  assert.equal(dbg.attachCalls, attachBefore);
});

test("7. rebinding creates a fresh generation", async () => {
  const a = createMockDebugger("A");
  const b = createMockDebugger("B");
  const session = new CdpDebuggerSession({ detachWhenIdle: false });
  session.bindWebContents(wc(a));
  const genA = session.diagnostics().generation;
  const lease = await session.acquire("typeOnly");
  assert.equal(lease.generation, genA);
  switchSessionLike(session, b);
  const genB = session.diagnostics().generation;
  assert.ok(genB > genA);
  const leaseB = await session.acquire("typeOnly");
  assert.equal(leaseB.generation, genB);
  assert.notEqual(leaseB.token, lease.token);
  await leaseB.release();
});

test("8. repeated session switches do not leak listeners", async () => {
  const session = new CdpDebuggerSession({ detachWhenIdle: false });
  let prev: MockDebugger | undefined;
  for (let i = 0; i < 6; i++) {
    const dbg = createMockDebugger(`S${i}`);
    if (i === 0) session.bindWebContents(wc(dbg));
    else switchSessionLike(session, dbg);
    const lease = await session.acquire("screenshot");
    session.onMessage(lease, () => {});
    await lease.release();
    if (prev) {
      assert.equal(prev.listenerCount("message"), 0);
      assert.equal(getCdpSessionForDebugger(prev), undefined);
    }
    prev = dbg;
  }
  assert.equal(session.diagnostics().leaseCount, 0);
  assert.equal(session.diagnostics().messageListenerCount, 0);
  assert.equal(prev!.listenerCount("message"), 0);
  // Only the active generation keeps the session detach watchdog.
  assert.equal(prev!.listenerCount("detach"), 1);
});

test("9. screenshot still works after session switch", async () => {
  const a = createMockDebugger("A");
  const b = createMockDebugger("B");
  const session = new CdpDebuggerSession({ detachWhenIdle: false });
  session.bindWebContents(wc(a));
  await captureScreenshotBufferViaCdp({
    cdp: session,
    capturePagePng: async () => Buffer.from(TINY_PNG),
  });
  switchSessionLike(session, b);
  const raw = await captureScreenshotBufferViaCdp({
    cdp: session,
    capturePagePng: async () => {
      throw new Error("fallback unused");
    },
  });
  assert.equal(Buffer.compare(raw, TINY_PNG), 0);
  assert.ok(b.commands.includes("Page.captureScreenshot"));
  assert.equal(session.diagnostics().leaseCount, 0);
  assert.equal(b.detachCalls, 0);
});

test("10. FileChooser compatibility after session switch", async () => {
  const a = createMockDebugger("A", true);
  const b = createMockDebugger("B", true);
  const session = new CdpDebuggerSession({ detachWhenIdle: false });
  session.bindWebContents(wc(a));
  await chooseUploadFiles(
    session,
    ["one.png"],
    () => {
      queueMicrotask(() =>
        a.emit(
          "message",
          {},
          "Page.fileChooserOpened",
          { mode: "selectSingle", backendNodeId: 1 },
          "",
        ),
      );
    },
    100,
  );
  switchSessionLike(session, b);
  const result = await chooseUploadFiles(
    session,
    ["two.png"],
    () => {
      queueMicrotask(() =>
        b.emit(
          "message",
          {},
          "Page.fileChooserOpened",
          { mode: "selectSingle", backendNodeId: 2 },
          "",
        ),
      );
    },
    100,
  );
  assert.equal(result.assignedCount, 1);
  assert.equal(session.diagnostics().leaseCount, 0);
  assert.equal(a.detachCalls, 0);
  assert.equal(b.detachCalls, 0);
});

test("switch ordering: after onViewWillReplace and before bind, registry has no live debugger", () => {
  const a = createMockDebugger("A");
  const b = createMockDebugger("B");
  const session = new CdpDebuggerSession({ detachWhenIdle: false });
  session.bindWebContents(wc(a));
  session.onViewWillReplace("session-switch");
  assert.equal(getCdpSessionForDebugger(a), undefined);
  assert.equal(getCdpSessionForDebugger(b), undefined);
  assert.equal(session.diagnostics().bound, false);
  session.bindWebContents(wc(b));
  assert.equal(requireCdpSessionForDebugger(b), session);
});
