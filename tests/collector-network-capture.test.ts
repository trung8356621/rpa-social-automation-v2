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
import { CollectorNetworkCapture } from "../src/main/collector-network-capture.js";
import { CollectorCaptureSessionStorage } from "../src/main/collector-capture-session-storage.js";
import { parseNetworkResponseText } from "../src/shared/collectors/network-body-parse.js";
import {
  redactHeaders,
  redactUrl,
  redactPreviewText,
} from "../src/shared/collectors/network-capture-redaction.js";

type MockDebugger = EventEmitter &
  CdpDebuggerLike & {
    attached: boolean;
    detachCalls: number;
    bodies: Map<string, { body: string; base64Encoded?: boolean }>;
    failBodyFor?: Set<string>;
  };

function createMockDebugger(): MockDebugger {
  const ee = new EventEmitter() as MockDebugger;
  ee.attached = false;
  ee.detachCalls = 0;
  ee.bodies = new Map();
  ee.failBodyFor = new Set();
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
      if (ee.failBodyFor?.has(requestId)) throw new Error("No resource with given identifier found");
      const hit = ee.bodies.get(requestId);
      if (!hit) throw new Error("No resource with given identifier found");
      return hit;
    }
    return {};
  };
  return ee;
}

async function withCapture(
  fn: (ctx: {
    dbg: MockDebugger;
    cdp: CdpDebuggerSession;
    capture: CollectorNetworkCapture;
    storage: CollectorCaptureSessionStorage;
    root: string;
    emit: (method: string, params: Record<string, unknown>) => void;
  }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rpa-cap-"));
  const dbg = createMockDebugger();
  const cdp = new CdpDebuggerSession({ detachWhenIdle: false });
  cdp.bindWebContents({ debugger: dbg, isDestroyed: () => false } satisfies CdpWebContentsLike);
  const storage = new CollectorCaptureSessionStorage(root);
  const capture = new CollectorNetworkCapture({ cdp, storage, projectDir: root });
  const emit = (method: string, params: Record<string, unknown>) => {
    dbg.emit("message", {}, method, params, "");
  };
  try {
    await fn({ dbg, cdp, capture, storage, root, emit });
  } finally {
    await capture.stop("test_cleanup").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
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

test("15. redaction strips cookies, authorization and sensitive query params", () => {
  assert.equal(
    redactHeaders({
      Cookie: "sid=abc",
      Authorization: "Bearer xyz",
      Accept: "application/json",
    }).Cookie,
    "[REDACTED]",
  );
  assert.equal(
    redactHeaders({ authorization: "Bearer xyz" }).authorization,
    "[REDACTED]",
  );
  assert.match(
    redactUrl("https://example.com/api?access_token=secret&q=1"),
    /access_token=%5BREDACTED%5D|access_token=\[REDACTED\]/,
  );
  assert.match(redactPreviewText('{"access_token":"abc","n":1}'), /REDACTED/);
});

test("4-6. JSON / NDJSON / invalid JSON parsing helpers", () => {
  assert.equal(parseNetworkResponseText('{"a":1}').status, "json_ok");
  assert.equal(parseNetworkResponseText('{"a":1}\n{"b":2}\n').status, "ndjson_ok");
  assert.equal(parseNetworkResponseText('{"a":1}\nNOTJSON\n{"b":2}').status, "ndjson_partial");
  assert.equal(parseNetworkResponseText("not-json").status, "json_invalid");
  assert.equal(parseNetworkResponseText("").status, "empty");
});

test("1+2+3. start/stop, metadata tracking, response body capture", async () => {
  await withCapture(async ({ cdp, capture, storage, emit, dbg }) => {
    const started = await capture.start({
      cdpGeneration: cdp.diagnostics().generation,
      browserSessionId: "sess-1",
      sourceUrl: "https://example.com/feed",
    });
    assert.equal(started.status, "running");
    assert.equal(capture.getStatus().status, "running");

    dbg.bodies.set("r1", { body: JSON.stringify({ post: 1 }) });
    emit("Network.requestWillBeSent", {
      requestId: "r1",
      documentURL: "https://example.com/feed",
      wallTime: 1,
      type: "XHR",
      request: {
        method: "POST",
        url: "https://example.com/api/data?access_token=secret",
        headers: { Cookie: "a=1", Accept: "application/json" },
      },
    });
    emit("Network.responseReceived", {
      requestId: "r1",
      response: {
        status: 200,
        mimeType: "application/json",
        url: "https://example.com/api/data",
        headers: { "content-type": "application/json", "set-cookie": "x=1" },
      },
    });
    emit("Network.loadingFinished", { requestId: "r1" });
    await pump();

    const stopped = await capture.stop("manual");
    assert.ok(["stopped", "partial"].includes(stopped.status));
    const rows = await storage.readRequestsNdjson(started.captureSessionId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.method, "POST");
    // Final url may be response URL; urlRedacted prefers first request URL (query secrets).
    assert.match(rows[0]!.urlRedacted, /access_token=%5BREDACTED%5D|access_token=\[REDACTED\]/);
    assert.equal(rows[0]!.requestHeadersRedacted?.Cookie, "[REDACTED]");
    assert.equal(rows[0]!.responseHeadersRedacted?.["set-cookie"], "[REDACTED]");
    assert.equal(rows[0]!.bodyStatus, "json_ok");
    assert.ok(rows[0]!.bodyPath);
    const body = await readFile(
      path.join(stopped.artifactRoot, rows[0]!.bodyPath!),
      "utf8",
    );
    assert.equal(JSON.parse(body).post, 1);
    const session = await storage.readSession(started.captureSessionId);
    assert.ok(session);
    assert.equal(session!.stats.bodiesSaved, 1);
  });
});

test("5. NDJSON body parse status", async () => {
  await withCapture(async ({ cdp, capture, storage, emit, dbg }) => {
    const started = await capture.start({ cdpGeneration: cdp.diagnostics().generation });
    dbg.bodies.set("nd", { body: '{"a":1}\n{"b":2}\n' });
    emit("Network.requestWillBeSent", {
      requestId: "nd",
      request: { method: "GET", url: "https://example.com/stream", headers: {} },
    });
    emit("Network.responseReceived", {
      requestId: "nd",
      response: {
        status: 200,
        mimeType: "application/x-ndjson",
        headers: { "content-type": "application/x-ndjson" },
      },
    });
    emit("Network.loadingFinished", { requestId: "nd" });
    await pump();
    await capture.stop();
    const rows = await storage.readRequestsNdjson(started.captureSessionId);
    assert.equal(rows[0]!.bodyStatus, "ndjson_ok");
    assert.equal(rows[0]!.objectCount, 2);
  });
});

test("6+7. invalid JSON and non-JSON content types", async () => {
  await withCapture(async ({ cdp, capture, storage, emit, dbg }) => {
    const started = await capture.start({ cdpGeneration: cdp.diagnostics().generation });
    dbg.bodies.set("bad", { body: "NOT JSON {" });
    emit("Network.requestWillBeSent", {
      requestId: "bad",
      request: { method: "GET", url: "https://example.com/x", headers: {} },
    });
    emit("Network.responseReceived", {
      requestId: "bad",
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    });
    emit("Network.loadingFinished", { requestId: "bad" });

    emit("Network.requestWillBeSent", {
      requestId: "img",
      request: { method: "GET", url: "https://example.com/a.png", headers: {} },
    });
    emit("Network.responseReceived", {
      requestId: "img",
      response: {
        status: 200,
        mimeType: "image/png",
        headers: { "content-type": "image/png" },
      },
    });
    emit("Network.loadingFinished", { requestId: "img" });
    await pump();
    await capture.stop();
    const rows = await storage.readRequestsNdjson(started.captureSessionId);
    const bad = rows.find((r) => r.requestId === "bad");
    const img = rows.find((r) => r.requestId === "img");
    assert.equal(bad?.bodyStatus, "json_invalid");
    assert.equal(img?.bodyStatus, "skipped_filter");
    assert.equal(img?.bodyPath, undefined);
  });
});

test("8. redirect handling keeps same requestId continuity", async () => {
  await withCapture(async ({ cdp, capture, storage, emit, dbg }) => {
    const started = await capture.start({ cdpGeneration: cdp.diagnostics().generation });
    dbg.bodies.set("redir", { body: '{"ok":true}' });
    emit("Network.requestWillBeSent", {
      requestId: "redir",
      request: { method: "GET", url: "https://example.com/old", headers: {} },
    });
    emit("Network.requestWillBeSent", {
      requestId: "redir",
      redirectResponse: {
        status: 302,
        mimeType: "text/html",
        headers: { location: "https://example.com/new" },
      },
      request: { method: "GET", url: "https://example.com/new", headers: {} },
    });
    emit("Network.responseReceived", {
      requestId: "redir",
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    });
    emit("Network.loadingFinished", { requestId: "redir" });
    await pump();
    const stopped = await capture.stop();
    assert.ok(stopped.stats.redirects >= 1);
    const rows = await storage.readRequestsNdjson(started.captureSessionId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.fromRedirect, true);
    assert.match(rows[0]!.url, /\/new/);
  });
});

test("9+10. loading failure and missing body", async () => {
  await withCapture(async ({ cdp, capture, storage, emit, dbg }) => {
    const started = await capture.start({ cdpGeneration: cdp.diagnostics().generation });
    emit("Network.requestWillBeSent", {
      requestId: "fail",
      request: { method: "GET", url: "https://example.com/fail", headers: {} },
    });
    emit("Network.loadingFailed", {
      requestId: "fail",
      errorText: "net::ERR_FAILED",
    });

    dbg.failBodyFor!.add("miss");
    emit("Network.requestWillBeSent", {
      requestId: "miss",
      request: { method: "GET", url: "https://example.com/miss", headers: {} },
    });
    emit("Network.responseReceived", {
      requestId: "miss",
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    });
    emit("Network.loadingFinished", { requestId: "miss" });
    await pump();
    await capture.stop();
    const rows = await storage.readRequestsNdjson(started.captureSessionId);
    assert.equal(rows.find((r) => r.requestId === "fail")?.bodyStatus, "failed");
    assert.equal(rows.find((r) => r.requestId === "miss")?.bodyStatus, "unavailable");
  });
});

test("11. quota exhaustion preserves completed evidence as partial", async () => {
  await withCapture(async ({ cdp, capture, storage, emit, dbg }) => {
    const started = await capture.start({
      cdpGeneration: cdp.diagnostics().generation,
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
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      });
      emit("Network.loadingFinished", { requestId: id });
    }
    await pump();
    const stopped = await capture.stop();
    assert.equal(stopped.status, "partial");
    const rows = await storage.readRequestsNdjson(started.captureSessionId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.requestId, "a");
  });
});

test("12. unexpected detach marks capture partial/failed and releases", async () => {
  await withCapture(async ({ cdp, capture, dbg }) => {
    await capture.start({ cdpGeneration: cdp.diagnostics().generation });
    dbg.attached = false;
    dbg.emit("detach", "devtools");
    await waitUntil(() =>
      ["partial", "failed", "stopped"].includes(capture.getStatus().status),
    );
    const status = capture.getStatus();
    assert.ok(
      ["partial", "failed", "stopped"].includes(status.status),
      `status=${status.status}`,
    );
    assert.equal(cdp.diagnostics().leaseCount, 0);
  });
});

test("13. browser generation invalidation stops capture", async () => {
  await withCapture(async ({ cdp, capture }) => {
    await capture.start({ cdpGeneration: cdp.diagnostics().generation });
    cdp.onViewWillReplace("session-switch");
    await waitUntil(() =>
      ["partial", "failed", "stopped"].includes(capture.getStatus().status),
    );
    const status = capture.getStatus();
    assert.ok(
      ["partial", "failed", "stopped"].includes(status.status),
      `status=${status.status}`,
    );
    assert.equal(cdp.diagnostics().leaseCount, 0);
  });
});

test("14. repeated capture without listener leaks", async () => {
  await withCapture(async ({ cdp, capture, dbg, emit }) => {
    for (let i = 0; i < 3; i++) {
      const started = await capture.start({
        cdpGeneration: cdp.diagnostics().generation,
        captureSessionId: `capsession${i}abcdefgh`,
      });
      dbg.bodies.set(`r${i}`, { body: `{"i":${i}}` });
      emit("Network.requestWillBeSent", {
        requestId: `r${i}`,
        request: { method: "GET", url: "https://example.com/x", headers: {} },
      });
      emit("Network.responseReceived", {
        requestId: `r${i}`,
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      });
      emit("Network.loadingFinished", { requestId: `r${i}` });
      await pump();
      await capture.stop();
      assert.ok(started.captureSessionId);
    }
    assert.equal(cdp.diagnostics().leaseCount, 0);
    assert.equal(cdp.diagnostics().networkTenantCount, 0);
    assert.equal(dbg.listenerCount("message"), 0);
  });
});

test("16. storage write/read/recovery of session + requests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rpa-store-"));
  try {
    const storage = new CollectorCaptureSessionStorage(root);
    const id = "capturesessionstore01";
    await storage.writeSession({
      schemaVersion: 1,
      captureSessionId: id,
      cdpGeneration: 1,
      status: "stopped",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      filters: {},
      limits: {
        maxRequestsTracked: 10,
        maxBodyBytes: 1000,
        maxTotalArtifactBytes: 10000,
        maxPendingBodyFetches: 2,
      },
      stats: {
        requestsTracked: 1,
        bodiesSaved: 1,
        bodiesSkipped: 0,
        bodiesFetched: 1,
        parseJsonOk: 1,
        parseNdjsonOk: 0,
        parseInvalid: 0,
        loadFailed: 0,
        redirects: 0,
        totalArtifactBytes: 5,
        diagnostics: 0,
        bodyStatusCounts: { json_ok: 1 },
      },
      artifactRoot: storage.getSessionDir(id),
      diagnostics: [],
    });
    await storage.appendRequestMeta({
      schemaVersion: 1,
      captureSessionId: id,
      requestId: "r1",
      artifactId: "art001",
      method: "GET",
      url: "https://example.com",
      urlRedacted: "https://example.com",
      timestamp: new Date().toISOString(),
      bodyStatus: "json_ok",
      completed: true,
    });
    const session = await storage.readSession(id);
    const rows = await storage.readRequestsNdjson(id);
    assert.equal(session?.status, "stopped");
    assert.equal(rows.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("17. capture independence from Visual Part (no visual imports/deps in start)", async () => {
  await withCapture(async ({ cdp, capture }) => {
    // Engine starts with only CDP + storage — no Visual Counter binding required.
    const started = await capture.start({
      cdpGeneration: cdp.diagnostics().generation,
    });
    assert.equal(started.status, "running");
    assert.equal(started.browserSessionId, undefined);
    await capture.stop();
  });
});

test("late events after stop are ignored", async () => {
  await withCapture(async ({ cdp, capture, emit, storage, dbg }) => {
    const started = await capture.start({ cdpGeneration: cdp.diagnostics().generation });
    await capture.stop();
    dbg.bodies.set("late", { body: '{"x":1}' });
    emit("Network.requestWillBeSent", {
      requestId: "late",
      request: { method: "GET", url: "https://example.com/late", headers: {} },
    });
    emit("Network.loadingFinished", { requestId: "late" });
    await pump();
    const rows = await storage.readRequestsNdjson(started.captureSessionId);
    assert.equal(rows.length, 0);
  });
});
