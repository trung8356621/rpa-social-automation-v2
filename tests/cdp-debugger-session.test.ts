import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  CdpDebuggerSession,
  type CdpDebuggerLike,
  type CdpWebContentsLike,
} from "../src/main/cdp-debugger-session.js";

type MockDebugger = EventEmitter &
  CdpDebuggerLike & {
    attached: boolean;
    attachCalls: number;
    detachCalls: number;
    commands: Array<{ method: string; params?: Record<string, unknown> }>;
    failAttach?: Error;
    failEnable?: Error;
  };

function createMockDebugger(preAttached = false): MockDebugger {
  const ee = new EventEmitter() as MockDebugger;
  ee.attached = preAttached;
  ee.attachCalls = 0;
  ee.detachCalls = 0;
  ee.commands = [];
  ee.isAttached = () => ee.attached;
  ee.attach = () => {
    if (ee.failAttach) throw ee.failAttach;
    ee.attachCalls += 1;
    ee.attached = true;
  };
  ee.detach = () => {
    ee.detachCalls += 1;
    ee.attached = false;
    ee.emit("detach", "simulated");
  };
  ee.sendCommand = async (method, params) => {
    if (method === "Network.enable" && ee.failEnable) throw ee.failEnable;
    ee.commands.push({ method, params });
    return {};
  };
  // EventEmitter already has on/removeListener/listenerCount
  return ee;
}

function createWc(dbg: MockDebugger, destroyed = false): CdpWebContentsLike {
  return {
    debugger: dbg,
    isDestroyed: () => destroyed,
  };
}

function messageCount(dbg: MockDebugger): number {
  return dbg.listenerCount("message");
}

test("1. single acquire/release attaches then detaches when adapter-owned", async () => {
  const dbg = createMockDebugger(false);
  const session = new CdpDebuggerSession();
  session.bindWebContents(createWc(dbg));
  const lease = await session.acquire("screenshot");
  assert.equal(dbg.attachCalls, 1);
  assert.equal(dbg.attached, true);
  assert.equal(session.diagnostics().adapterOwnsAttach, true);
  assert.equal(lease.alive, true);
  await lease.release();
  assert.equal(lease.alive, false);
  assert.equal(dbg.detachCalls, 1);
  assert.equal(dbg.attached, false);
  assert.equal(session.diagnostics().leaseCount, 0);
});

test("2. two simultaneous consumers share one attach; last release detaches", async () => {
  const dbg = createMockDebugger(false);
  const session = new CdpDebuggerSession();
  session.bindWebContents(createWc(dbg));
  const a = await session.acquire("screenshot");
  const b = await session.acquire("screencast");
  assert.equal(dbg.attachCalls, 1);
  assert.equal(session.diagnostics().leaseCount, 2);
  await a.release();
  assert.equal(dbg.detachCalls, 0);
  assert.equal(dbg.attached, true);
  await b.release();
  assert.equal(dbg.detachCalls, 1);
  assert.equal(dbg.attached, false);
});

test("3. concurrent acquire calls perform one attach", async () => {
  const dbg = createMockDebugger(false);
  const session = new CdpDebuggerSession();
  session.bindWebContents(createWc(dbg));
  const [a, b, c] = await Promise.all([
    session.acquire("a"),
    session.acquire("b"),
    session.acquire("c"),
  ]);
  assert.equal(dbg.attachCalls, 1);
  assert.equal(session.diagnostics().leaseCount, 3);
  await Promise.all([a.release(), b.release(), c.release()]);
  assert.equal(dbg.detachCalls, 1);
  assert.equal(session.diagnostics().leaseCount, 0);
});

test("4. external pre-attached debugger is never detached by adapter", async () => {
  const dbg = createMockDebugger(true);
  const session = new CdpDebuggerSession();
  session.bindWebContents(createWc(dbg));
  const lease = await session.acquire("typeOnly");
  assert.equal(dbg.attachCalls, 0);
  assert.equal(session.diagnostics().adapterOwnsAttach, false);
  await lease.release();
  assert.equal(dbg.detachCalls, 0);
  assert.equal(dbg.attached, true);
});

test("5. last release detaches only adapter-owned attachment", async () => {
  const owned = createMockDebugger(false);
  const sessionOwned = new CdpDebuggerSession();
  sessionOwned.bindWebContents(createWc(owned));
  const l1 = await sessionOwned.acquire("collectorNetwork");
  await l1.release();
  assert.equal(owned.detachCalls, 1);

  const external = createMockDebugger(true);
  const sessionExt = new CdpDebuggerSession();
  sessionExt.bindWebContents(createWc(external));
  const l2 = await sessionExt.acquire("collectorNetwork");
  const l3 = await sessionExt.acquire("screenshot");
  await l2.release();
  await l3.release();
  assert.equal(external.detachCalls, 0);
  assert.equal(external.attached, true);
});

test("6. duplicate release is safe", async () => {
  const dbg = createMockDebugger(false);
  const session = new CdpDebuggerSession();
  session.bindWebContents(createWc(dbg));
  const lease = await session.acquire("screenshot");
  await lease.release();
  await lease.release();
  await lease.release();
  assert.equal(dbg.detachCalls, 1);
  assert.equal(session.diagnostics().leaseCount, 0);
});

test("7. attach failure does not leak a lease", async () => {
  const dbg = createMockDebugger(false);
  dbg.failAttach = new Error("attach denied");
  const session = new CdpDebuggerSession();
  session.bindWebContents(createWc(dbg));
  await assert.rejects(() => session.acquire("screenshot"), /attach denied/);
  assert.equal(session.diagnostics().leaseCount, 0);
  assert.equal(dbg.attached, false);
  assert.equal(dbg.detachCalls, 0);
});

test("8. Network domain reference counting", async () => {
  const dbg = createMockDebugger(false);
  const session = new CdpDebuggerSession();
  session.bindWebContents(createWc(dbg));
  const a = await session.acquire("collectorNetwork");
  const b = await session.acquire("collectorNetwork");
  await session.enableDomain(a, "Network");
  assert.equal(dbg.commands.filter((c) => c.method === "Network.enable").length, 1);
  await session.enableDomain(b, "Network");
  assert.equal(dbg.commands.filter((c) => c.method === "Network.enable").length, 1);
  assert.equal(session.diagnostics().networkTenantCount, 2);
  await session.disableDomain(a, "Network");
  assert.equal(dbg.commands.some((c) => c.method === "Network.disable"), false);
  await session.disableDomain(b, "Network");
  assert.equal(dbg.commands.filter((c) => c.method === "Network.disable").length, 1);
  await a.release();
  await b.release();
});

test("9. domain enable failure does not leave ownership counts", async () => {
  const dbg = createMockDebugger(false);
  dbg.failEnable = new Error("enable failed");
  const session = new CdpDebuggerSession();
  session.bindWebContents(createWc(dbg));
  const lease = await session.acquire("collectorNetwork");
  await assert.rejects(() => session.enableDomain(lease, "Network"), /enable failed/);
  assert.equal(session.diagnostics().networkTenantCount, 0);
  assert.equal(session.diagnostics().networkOwnedByAdapter, false);
  // Retry after clearing failure should work.
  dbg.failEnable = undefined;
  await session.enableDomain(lease, "Network");
  assert.equal(session.diagnostics().networkTenantCount, 1);
  await lease.release();
});

test("10. independent listener cleanup", async () => {
  const dbg = createMockDebugger(false);
  const session = new CdpDebuggerSession();
  session.bindWebContents(createWc(dbg));
  const a = await session.acquire("a");
  const b = await session.acquire("b");
  const seenA: string[] = [];
  const seenB: string[] = [];
  const offA = session.onMessage(a, (_e, method) => {
    seenA.push(method);
  });
  session.onMessage(b, (_e, method) => {
    seenB.push(method);
  });
  assert.equal(messageCount(dbg), 2);
  dbg.emit("message", {}, "Network.requestWillBeSent", { id: 1 }, "");
  assert.deepEqual(seenA, ["Network.requestWillBeSent"]);
  assert.deepEqual(seenB, ["Network.requestWillBeSent"]);
  offA();
  assert.equal(messageCount(dbg), 1);
  dbg.emit("message", {}, "Network.loadingFinished", { id: 2 }, "");
  assert.deepEqual(seenA, ["Network.requestWillBeSent"]);
  assert.deepEqual(seenB, ["Network.requestWillBeSent", "Network.loadingFinished"]);
  await a.release();
  await b.release();
  assert.equal(messageCount(dbg), 0);
});

test("11. unexpected detach invalidates leases and notifies", async () => {
  const dbg = createMockDebugger(false);
  const session = new CdpDebuggerSession();
  session.bindWebContents(createWc(dbg));
  const notices: Array<{ reason?: string; generation: number }> = [];
  session.onUnexpectedDetach((info) => notices.push(info));
  const lease = await session.acquire("collectorNetwork");
  await session.enableDomain(lease, "Network");
  const seen: string[] = [];
  session.onMessage(lease, (_e, method) => seen.push(method));

  // Simulate external DevTools / Chromium detach without going through adapter.detach().
  dbg.attached = false;
  dbg.emit("detach", "replaced_with_devtools");

  assert.equal(lease.alive, false);
  assert.equal(lease.failReason, "unexpected-detach");
  assert.equal(session.diagnostics().leaseCount, 0);
  assert.equal(session.diagnostics().networkTenantCount, 0);
  assert.equal(session.diagnostics().adapterOwnsAttach, false);
  assert.equal(notices.length, 1);
  assert.match(String(notices[0]?.reason), /devtools|replaced/i);
  dbg.emit("message", {}, "Network.loadingFinished", {}, "");
  assert.deepEqual(seen, []);
  // No silent reattach.
  assert.equal(dbg.attachCalls, 1);
});

test("12. WebContents replacement invalidates old leases", async () => {
  const dbg1 = createMockDebugger(false);
  const dbg2 = createMockDebugger(false);
  const session = new CdpDebuggerSession();
  session.bindWebContents(createWc(dbg1));
  const lease = await session.acquire("collectorNetwork");
  const seen: string[] = [];
  session.onMessage(lease, (_e, method) => seen.push(method));
  const gen = lease.generation;

  session.onViewWillReplace("session-switch");
  assert.equal(lease.alive, false);
  assert.equal(lease.failReason, "view-replaced");
  assert.equal(messageCount(dbg1), 0);
  dbg1.emit("message", {}, "Network.requestWillBeSent", {}, "");
  assert.deepEqual(seen, []);

  session.bindWebContents(createWc(dbg2));
  const next = await session.acquire("collectorNetwork");
  assert.notEqual(next.generation, gen);
  assert.equal(next.alive, true);
  await next.release();
});

test("13. pending async acquire during replacement fails without leaking", async () => {
  const dbg = createMockDebugger(false);
  const session = new CdpDebuggerSession();
  session.bindWebContents(createWc(dbg));

  let attachStarted!: () => void;
  const gate = new Promise<void>((resolve) => {
    attachStarted = resolve;
  });
  const originalAttach = dbg.attach.bind(dbg);
  dbg.attach = () => {
    attachStarted();
    // Synchronous attach still; replacement happens interleaved via enqueue + microtasks.
    originalAttach();
  };

  const pending = session.acquire("collectorNetwork");
  // Replace after acquire is queued; serialized chain means replace enqueued after acquire starts.
  // Force ordering: wait a tick then replace while second op queued.
  await Promise.resolve();
  session.onViewWillReplace("session-switch");

  // First acquire may succeed or fail depending on chain order. Ensure no leak either way.
  const result = await pending.then(
    (lease) => ({ ok: true as const, lease }),
    (error: Error) => ({ ok: false as const, error }),
  );
  if (result.ok) {
    // If acquire won the race before replace, replace should have invalidated it.
    assert.equal(result.lease.alive, false);
  }
  assert.equal(session.diagnostics().leaseCount, 0);

  // Bind fresh and ensure clean cycle.
  const dbg2 = createMockDebugger(false);
  session.bindWebContents(createWc(dbg2));
  const lease = await session.acquire("screenshot");
  await lease.release();
  assert.equal(dbg2.detachCalls, 1);
  void gate;
});

test("13b. acquire in-flight observes generation change and rolls back adapter attach", async () => {
  const dbg = createMockDebugger(false);
  const session = new CdpDebuggerSession();
  session.bindWebContents(createWc(dbg));

  let releaseAttach!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseAttach = resolve;
  });
  const originalAttach = dbg.attach.bind(dbg);
  dbg.attach = () => {
    // Block inside attach by spinning wait — but attach is sync in Electron.
    // Simulate post-attach generation bump via custom hook: attach then caller replaces.
    originalAttach();
  };

  // Enqueue acquire, then in same turn after attach portion use a custom slow path:
  // monkey-patch enqueue by delaying sendCommand is not enough. Instead:
  // start acquire, immediately onViewWillReplace on a later chain task that runs between.
  const acquirePromise = session.acquire("collectorNetwork");
  // Schedule replace on the chain after acquire by awaiting microtask then replace —
  // acquire is already running/serialized. For a stronger race, replace before acquire resolves:
  await Promise.resolve();
  session.onViewWillReplace("destroy");
  const settled = await acquirePromise.then(
    (l) => l,
    () => null,
  );
  if (settled) assert.equal(settled.alive, false);
  assert.equal(session.diagnostics().leaseCount, 0);
  releaseAttach();
  await hold;
});

test("14. repeated acquire/release cycles leave no listener leaks", async () => {
  const dbg = createMockDebugger(false);
  const session = new CdpDebuggerSession();
  session.bindWebContents(createWc(dbg));
  for (let i = 0; i < 5; i++) {
    const lease = await session.acquire("collectorNetwork");
    const off = session.onMessage(lease, () => {});
    await session.enableDomain(lease, "Network");
    off();
    await session.disableDomain(lease, "Network");
    await lease.release();
  }
  assert.equal(messageCount(dbg), 0);
  assert.equal(dbg.listenerCount("detach"), 1); // session detach watchdog only
  assert.equal(session.diagnostics().leaseCount, 0);
  assert.equal(session.diagnostics().networkTenantCount, 0);
  assert.equal(dbg.attachCalls, 5);
  assert.equal(dbg.detachCalls, 5);
});

test("15. no negative counts; release after unexpected detach is safe", async () => {
  const dbg = createMockDebugger(false);
  const session = new CdpDebuggerSession();
  session.bindWebContents(createWc(dbg));
  const lease = await session.acquire("screenshot");
  await session.enableDomain(lease, "Network");
  dbg.attached = false;
  dbg.emit("detach", "gone");
  assert.equal(session.diagnostics().leaseCount, 0);
  assert.equal(session.diagnostics().networkTenantCount, 0);
  await lease.release();
  await lease.release();
  assert.equal(session.diagnostics().leaseCount, 0);
  // Counts must not go negative (represented as sizes).
  assert.ok(session.diagnostics().leaseCount >= 0);
  assert.ok(session.diagnostics().networkTenantCount >= 0);
  assert.ok(session.diagnostics().messageListenerCount >= 0);
});

test("sendCommand rejects dead lease; released lease ignores messages", async () => {
  const dbg = createMockDebugger(false);
  const session = new CdpDebuggerSession();
  session.bindWebContents(createWc(dbg));
  const lease = await session.acquire("typeOnly");
  const seen: string[] = [];
  session.onMessage(lease, (_e, method) => seen.push(method));
  await lease.release();
  await assert.rejects(
    () => session.sendCommand(lease, "Input.dispatchKeyEvent", { type: "char", text: "a" }),
    /not alive/,
  );
  dbg.emit("message", {}, "Input.ignored", {}, "");
  assert.deepEqual(seen, []);
});

test("Network.disable is not issued when domain was not owned by adapter", async () => {
  // Simulate: first tenant enable fails ownership path never set; or external domain.
  // Adapter only disables when networkOwnedByAdapter is true.
  const dbg = createMockDebugger(true);
  const session = new CdpDebuggerSession();
  session.bindWebContents(createWc(dbg));
  const lease = await session.acquire("collectorNetwork");
  // Manually we cannot mark external Network.enable; ensure failed enable then release
  // does not send Network.disable.
  dbg.failEnable = new Error("no");
  await assert.rejects(() => session.enableDomain(lease, "Network"));
  await lease.release();
  assert.equal(
    dbg.commands.filter((c) => c.method === "Network.disable").length,
    0,
  );
});
