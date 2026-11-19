import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CdpDebuggerSession,
  type CdpDebuggerLike,
  type CdpWebContentsLike,
} from "../src/main/cdp-debugger-session.js";
import { CollectorCaptureSessionStorage } from "../src/main/collector-capture-session-storage.js";
import { CollectorNetworkCaptureController } from "../src/main/collector-network-capture-controller.js";
import {
  resolveNetworkPartBinding,
  networkPartOptionKey,
} from "../src/shared/collectors/network-part-binding.js";
import {
  MemoryKeyValueStorage,
  PartLibraryRepository,
} from "../src/shared/collectors/part-library-repository.js";
import { isCollectorBrowserHostPage } from "../src/shared/collector-browser-host.js";
import { redactPreviewText } from "../src/shared/collectors/network-capture-redaction.js";

type MockDebugger = EventEmitter &
  CdpDebuggerLike & {
    attached: boolean;
    detachCalls: number;
    bodies: Map<string, { body: string; base64Encoded?: boolean }>;
  };

function createMockDebugger(): MockDebugger {
  const ee = new EventEmitter() as MockDebugger;
  ee.attached = false;
  ee.detachCalls = 0;
  ee.bodies = new Map();
  ee.isAttached = () => ee.attached;
  ee.attach = () => {
    ee.attached = true;
  };
  ee.detach = () => {
    ee.detachCalls += 1;
    ee.attached = false;
    ee.emit("detach", "simulated");
  };
  ee.sendCommand = async (method, params) => {
    if (method === "Network.enable" || method === "Network.disable") return {};
    if (method === "Network.getResponseBody") {
      const requestId = String((params as { requestId?: string })?.requestId ?? "");
      const hit = ee.bodies.get(requestId);
      if (!hit) throw new Error("No resource with given identifier found");
      return hit;
    }
    return {};
  };
  return ee;
}

async function pump(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 15));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function withController(
  fn: (ctx: {
    dbg: MockDebugger;
    cdp: CdpDebuggerSession;
    controller: CollectorNetworkCaptureController;
    storage: CollectorCaptureSessionStorage;
    root: string;
    browserSessionId: { current: string };
    emit: (method: string, params: Record<string, unknown>) => void;
  }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rpa-c2b6-"));
  const dbg = createMockDebugger();
  const cdp = new CdpDebuggerSession({ detachWhenIdle: false });
  cdp.bindWebContents({ debugger: dbg, isDestroyed: () => false } satisfies CdpWebContentsLike);
  const storage = new CollectorCaptureSessionStorage(root);
  const browserSessionId = { current: "browser-sess-a" };
  const controller = new CollectorNetworkCaptureController(
    () => cdp,
    storage,
    root,
    () => browserSessionId.current,
    () => "https://example.com/feed",
  );
  const emit = (method: string, params: Record<string, unknown>) => {
    dbg.emit("message", {}, method, params, "");
  };
  try {
    await fn({ dbg, cdp, controller, storage, root, browserSessionId, emit });
  } finally {
    await controller.stopIfActive("test_cleanup");
    await rm(root, { recursive: true, force: true });
  }
}

test("C2B.6 binding: no Network Part disables start selection", () => {
  const binding = resolveNetworkPartBinding(
    [{ partId: "visual_1", partVersion: 1 }],
    [{ partId: "visual_1", name: "V", partType: "visual", version: 1, status: "ready" }],
  );
  assert.equal(binding.kind, "none");
  assert.match(binding.reason, /no Network Part/i);
});

test("C2B.6 binding: single Network Part auto-selects", () => {
  const binding = resolveNetworkPartBinding(
    [
      { partId: "visual_1", partVersion: 1 },
      { partId: "net_1", partVersion: 2 },
    ],
    [
      { partId: "visual_1", name: "V", partType: "visual", version: 1, status: "ready" },
      { partId: "net_1", name: "N", partType: "network", version: 3, status: "draft" },
    ],
  );
  assert.equal(binding.kind, "single");
  if (binding.kind !== "single") return;
  assert.equal(binding.selected.partId, "net_1");
  assert.equal(binding.selected.partVersion, 2);
});

test("C2B.6 binding: multiple Network Parts require explicit selection", () => {
  const parts = [
    { partId: "n1", name: "A", partType: "network" as const, version: 1, status: "draft" as const },
    { partId: "n2", name: "B", partType: "network" as const, version: 1, status: "draft" as const },
  ];
  const refs = [
    { partId: "n1", partVersion: 1 },
    { partId: "n2", partVersion: 1 },
  ];
  const unbound = resolveNetworkPartBinding(refs, parts);
  assert.equal(unbound.kind, "multiple");
  assert.match(unbound.reason, /Select which Network Part/i);
  const key = networkPartOptionKey({ partId: "n2", partVersion: 1 });
  const bound = resolveNetworkPartBinding(refs, parts, key);
  assert.equal(bound.kind, "multiple");
  assert.equal(bound.reason, "");
  assert.ok(bound.options.some((o) => o.partId === "n2"));
});

test("C2B.6 IPC-style start/stop binds browser session + network part", async () => {
  await withController(async ({ controller, storage }) => {
    const started = await controller.start({
      scriptId: "script_abc",
      networkPartId: "net_part_1",
      networkPartVersion: 3,
      sourceUrl: "https://example.com/feed",
    });
    assert.equal(started.status, "running");
    assert.equal(started.scriptId, "script_abc");
    assert.equal(started.networkPartId, "net_part_1");
    assert.equal(started.networkPartVersion, 3);
    assert.equal(started.browserSessionId, "browser-sess-a");
    const status = controller.status();
    assert.equal(status.status, "running");
    assert.equal(status.browserSessionId, "browser-sess-a");
    const stopped = await controller.stop("manual");
    assert.ok(["stopped", "partial"].includes(stopped.status));
    const listed = await storage.listSessions({ scriptId: "script_abc" });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.captureSessionId, started.captureSessionId);
  });
});

test("C2B.6 rejects invalid start params and double start", async () => {
  await withController(async ({ controller }) => {
    await assert.rejects(
      () =>
        controller.start({
          scriptId: "",
          networkPartId: "n",
          networkPartVersion: 1,
        }),
      /Invalid Network Capture/,
    );
    await controller.start({
      scriptId: "s1",
      networkPartId: "n1",
      networkPartVersion: 1,
    });
    await assert.rejects(
      () =>
        controller.start({
          scriptId: "s1",
          networkPartId: "n1",
          networkPartVersion: 1,
        }),
      /already active/,
    );
    await controller.stop();
  });
});

test("C2B.6 browser session switch stops capture and preserves evidence", async () => {
  await withController(async ({ controller, dbg, emit, storage, browserSessionId }) => {
    const started = await controller.start({
      scriptId: "s-switch",
      networkPartId: "n1",
      networkPartVersion: 1,
    });
    dbg.bodies.set("r1", { body: JSON.stringify({ ok: true }) });
    emit("Network.requestWillBeSent", {
      requestId: "r1",
      request: { method: "GET", url: "https://example.com/a", headers: {} },
    });
    emit("Network.responseReceived", {
      requestId: "r1",
      response: { status: 200, headers: { "content-type": "application/json" } },
    });
    emit("Network.loadingFinished", { requestId: "r1" });
    await pump();

    browserSessionId.current = "browser-sess-b";
    await controller.stopIfActive("browser-session-switch");
    const status = controller.status();
    assert.ok(["stopped", "partial", "failed", "idle"].includes(status.status));
    const rows = await storage.readRequestsNdjson(started.captureSessionId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.bodyStatus, "json_ok");
  });
});

test("C2B.6 same-session navigation continues capture", async () => {
  await withController(async ({ controller, dbg, emit, storage }) => {
    const started = await controller.start({
      scriptId: "s-nav",
      networkPartId: "n1",
      networkPartVersion: 1,
    });
    for (const id of ["a", "b"]) {
      dbg.bodies.set(id, { body: JSON.stringify({ id }) });
      emit("Network.requestWillBeSent", {
        requestId: id,
        documentURL: id === "a" ? "https://example.com/1" : "https://example.com/2",
        request: { method: "GET", url: `https://example.com/api/${id}`, headers: {} },
      });
      emit("Network.responseReceived", {
        requestId: id,
        response: { status: 200, headers: { "content-type": "application/json" } },
      });
      emit("Network.loadingFinished", { requestId: id });
    }
    await pump();
    await controller.stop();
    const rows = await storage.readRequestsNdjson(started.captureSessionId);
    assert.equal(rows.length, 2);
    assert.equal(controller.status().status === "running", false);
  });
});

test("C2B.6 unexpected debugger detach marks partial/failed", async () => {
  await withController(async ({ controller, dbg }) => {
    await controller.start({
      scriptId: "s-detach",
      networkPartId: "n1",
      networkPartVersion: 1,
    });
    dbg.attached = false;
    dbg.emit("detach", "devtools");
    await waitUntil(() =>
      ["partial", "failed", "stopped", "stopping"].includes(controller.status().status),
    );
    await waitUntil(() =>
      ["partial", "failed", "stopped"].includes(controller.status().status),
    );
    const status = controller.status().status;
    assert.ok(["partial", "failed", "stopped"].includes(status), `status=${status}`);
  });
});

test("C2B.6 repeated start/stop does not leak CDP listeners", async () => {
  await withController(async ({ controller, cdp, dbg }) => {
    for (let i = 0; i < 3; i++) {
      await controller.start({
        scriptId: "s-loop",
        networkPartId: "n1",
        networkPartVersion: 1,
      });
      await controller.stop("manual");
    }
    assert.equal(cdp.diagnostics().leaseCount, 0);
    assert.equal(dbg.listenerCount("message"), 0);
  });
});

test("C2B.6 requestId reuse after flush uses unique artifactIds (no body collision)", async () => {
  await withController(async ({ controller, dbg, emit, storage }) => {
    const started = await controller.start({
      scriptId: "s-reuse",
      networkPartId: "n1",
      networkPartVersion: 1,
    });
    for (const body of ['{"n":1}', '{"n":2}']) {
      dbg.bodies.set("same", { body });
      emit("Network.requestWillBeSent", {
        requestId: "same",
        request: { method: "GET", url: "https://example.com/reuse", headers: {} },
      });
      emit("Network.responseReceived", {
        requestId: "same",
        response: { status: 200, headers: { "content-type": "application/json" } },
      });
      emit("Network.loadingFinished", { requestId: "same" });
      await pump();
    }
    await controller.stop();
    const rows = await storage.readRequestsNdjson(started.captureSessionId);
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]!.artifactId, rows[1]!.artifactId);
    assert.notEqual(rows[0]!.bodyPath, rows[1]!.bodyPath);
    const b0 = await readFile(path.join(started.artifactRoot, rows[0]!.bodyPath!), "utf8");
    const b1 = await readFile(path.join(started.artifactRoot, rows[1]!.bodyPath!), "utf8");
    assert.equal(JSON.parse(b0).n, 1);
    assert.equal(JSON.parse(b1).n, 2);
  });
});

test("C2B.6 base64 response body decoding", async () => {
  await withController(async ({ controller, dbg, emit, storage }) => {
    const started = await controller.start({
      scriptId: "s-b64",
      networkPartId: "n1",
      networkPartVersion: 1,
    });
    const payload = JSON.stringify({ hello: "base64" });
    dbg.bodies.set("b64", {
      body: Buffer.from(payload, "utf8").toString("base64"),
      base64Encoded: true,
    });
    emit("Network.requestWillBeSent", {
      requestId: "b64",
      request: { method: "GET", url: "https://example.com/b64", headers: {} },
    });
    emit("Network.responseReceived", {
      requestId: "b64",
      response: { status: 200, headers: { "content-type": "application/json" } },
    });
    emit("Network.loadingFinished", { requestId: "b64" });
    await pump();
    await controller.stop();
    const rows = await storage.readRequestsNdjson(started.captureSessionId);
    assert.equal(rows[0]!.bodyStatus, "json_ok");
    const text = await readFile(path.join(started.artifactRoot, rows[0]!.bodyPath!), "utf8");
    assert.equal(JSON.parse(text).hello, "base64");
  });
});

test("C2B.6 quota exhaustion keeps partial evidence", async () => {
  await withController(async ({ controller, cdp, storage, dbg, emit, root }) => {
    // Start via engine limits by constructing a dedicated capture through controller then
    // using storage — controller always uses default limits, so drive engine directly for quota.
    const { CollectorNetworkCapture } = await import("../src/main/collector-network-capture.js");
    const capture = new CollectorNetworkCapture({ cdp, storage, projectDir: root });
    const started = await capture.start({
      cdpGeneration: cdp.diagnostics().generation,
      scriptId: "s-quota",
      networkPartId: "n1",
      networkPartVersion: 1,
      limits: { maxRequestsTracked: 1, maxTotalArtifactBytes: 10_000_000 },
    });
    dbg.bodies.set("a", { body: '{"a":1}' });
    dbg.bodies.set("b", { body: '{"b":2}' });
    for (const id of ["a", "b"]) {
      emit("Network.requestWillBeSent", {
        requestId: id,
        request: { method: "GET", url: `https://example.com/${id}`, headers: {} },
      });
      emit("Network.responseReceived", {
        requestId: id,
        response: { status: 200, headers: { "content-type": "application/json" } },
      });
      emit("Network.loadingFinished", { requestId: id });
    }
    await pump();
    const stopped = await capture.stop();
    assert.equal(stopped.status, "partial");
    const rows = await storage.readRequestsNdjson(started.captureSessionId);
    assert.equal(rows.length, 1);
  });
});

test("C2B.6 safe evidence preview rejects traversal and redacts secrets", async () => {
  await withController(async ({ controller, dbg, emit }) => {
    const started = await controller.start({
      scriptId: "s-prev",
      networkPartId: "n1",
      networkPartVersion: 1,
    });
    dbg.bodies.set("p", {
      body: JSON.stringify({ access_token: "secret", n: 1 }),
    });
    emit("Network.requestWillBeSent", {
      requestId: "p",
      request: { method: "GET", url: "https://example.com/p", headers: {} },
    });
    emit("Network.responseReceived", {
      requestId: "p",
      response: { status: 200, headers: { "content-type": "application/json" } },
    });
    emit("Network.loadingFinished", { requestId: "p" });
    await pump();
    await controller.stop();
    const listed = await controller.listRequests(started.captureSessionId);
    assert.equal(listed.total, 1);
    const bodyPath = listed.items[0]!.bodyPath!;
    const ok = await controller.readBodyPreview(started.captureSessionId, bodyPath, 10_000);
    assert.equal(ok.ok, true);
    assert.match(ok.preview, /REDACTED/);
    assert.doesNotMatch(ok.preview, /secret/);
    const bad = await controller.readBodyPreview(
      started.captureSessionId,
      "../session.json",
      10_000,
    );
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /Invalid artifact/i);
    assert.match(redactPreviewText('{"access_token":"abc"}'), /REDACTED/);
  });
});

test("C2B.6 Part Library data remains intact after capture metadata ops", async () => {
  const kv = new MemoryKeyValueStorage();
  const repo = new PartLibraryRepository(kv);
  const net = repo.createNetworkDraftPart("Net Draft");
  const visual = repo.createVisualFeedItemPart("Visual");
  const script = repo.createCollectorScript("Script", [
    { partId: visual.partId, partVersion: visual.version },
    { partId: net.partId, partVersion: net.version },
  ]);
  const before = JSON.stringify(repo.listParts());
  await withController(async ({ controller }) => {
    await controller.start({
      scriptId: script.scriptId,
      networkPartId: net.partId,
      networkPartVersion: net.version,
    });
    await controller.stop();
  });
  const repo2 = new PartLibraryRepository(kv);
  assert.equal(JSON.stringify(repo2.listParts()), before);
  assert.equal(repo2.getScript(script.scriptId)?.name, "Script");
  assert.equal(repo2.getPart(net.partId)?.partType, "network");
});

test("C2B.6 workspace page is a collector browser host page", () => {
  assert.equal(isCollectorBrowserHostPage("collector-script-workspace"), true);
  assert.equal(isCollectorBrowserHostPage("collectors"), true);
});
