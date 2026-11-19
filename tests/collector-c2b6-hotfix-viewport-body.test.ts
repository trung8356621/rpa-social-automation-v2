import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CdpDebuggerSession,
  type CdpDebuggerLike,
  type CdpWebContentsLike,
} from "../src/main/cdp-debugger-session.js";
import { CollectorNetworkCapture } from "../src/main/collector-network-capture.js";
import { CollectorCaptureSessionStorage } from "../src/main/collector-capture-session-storage.js";
import {
  DEFAULT_NETWORK_CAPTURE_FILTERS,
  emptyCaptureStats,
} from "../src/shared/collectors/capture-session-types.js";
import {
  parseNetworkResponseText,
  stripJsonDefensePrefix,
} from "../src/shared/collectors/network-body-parse.js";
import { WEB_HEIGHT, WEB_WIDTH } from "../src/shared/geometry.js";

type MockDebugger = EventEmitter &
  CdpDebuggerLike & {
    attached: boolean;
    bodies: Map<string, { body: string; base64Encoded?: boolean }>;
  };

function createMockDebugger(): MockDebugger {
  const ee = new EventEmitter() as MockDebugger;
  ee.attached = false;
  ee.bodies = new Map();
  ee.isAttached = () => ee.attached;
  ee.attach = () => {
    ee.attached = true;
  };
  ee.detach = () => {
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

test("hotfix: Creator execution viewport constants remain 1024×560", () => {
  assert.equal(WEB_WIDTH, 1024);
  assert.equal(WEB_HEIGHT, 560);
});

test("hotfix: Workspace host CSS/JS locks 1024×560; does not stretch", () => {
  const css = readFileSync("src/renderer/collectors/part-library.css", "utf8");
  const tsx = readFileSync("src/renderer/collectors/CollectorScriptWorkspace.tsx", "utf8");
  assert.match(css, /width:\s*1024px/);
  assert.match(css, /height:\s*560px/);
  assert.match(css, /max-width:\s*1024px/);
  assert.match(css, /max-height:\s*560px/);
  assert.doesNotMatch(css, /\.csw-browser-host\s*\{[^}]*min-height:\s*360px/s);
  assert.match(tsx, /WEB_WIDTH/);
  assert.match(tsx, /WEB_HEIGHT/);
  assert.match(tsx, /style=\{\{\s*width:\s*WEB_WIDTH,\s*height:\s*WEB_HEIGHT\s*\}\}/);
});

test("hotfix: Creator browser layout still uses WEB_WIDTH; BrowserCore untouched by Workspace", () => {
  const geometry = readFileSync("src/shared/geometry.ts", "utf8");
  const browserCore = readFileSync("src/main/browser-core.ts", "utf8");
  const workspace = readFileSync("src/renderer/collectors/CollectorScriptWorkspace.tsx", "utf8");
  assert.match(geometry, /width:\s*1024/);
  assert.match(geometry, /height:\s*560/);
  assert.doesNotMatch(workspace, /browser-core/i);
  assert.doesNotMatch(workspace, /switchPartition|new BrowserCore/);
  // BrowserCore file not edited by this hotfix path expectation: still exports getCdpSession.
  assert.match(browserCore, /getCdpSession/);
});

test("hotfix: default body filter excludes broad javascript substring", () => {
  const includes = DEFAULT_NETWORK_CAPTURE_FILTERS.bodyContentTypeIncludes ?? [];
  assert.ok(includes.some((x) => x === "json"));
  assert.ok(!includes.some((x) => x.toLowerCase() === "javascript"));
});

test("hotfix: XSSI defense prefixes parse as JSON without endpoint hardcoding", () => {
  assert.equal(stripJsonDefensePrefix('for (;;);{"a":1}'), '{"a":1}');
  assert.equal(parseNetworkResponseText('for (;;);{"a":1}').status, "json_ok");
  assert.equal(parseNetworkResponseText("while(1);{\"b\":2}").status, "json_ok");
  assert.equal(parseNetworkResponseText(")]}',\n{\"c\":3}").status, "json_ok");
});

test("hotfix: counters distinguish skipped JS, persisted invalid, and JSON ok", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rpa-hotfix-"));
  const dbg = createMockDebugger();
  const cdp = new CdpDebuggerSession({ detachWhenIdle: false });
  cdp.bindWebContents({ debugger: dbg, isDestroyed: () => false } satisfies CdpWebContentsLike);
  const storage = new CollectorCaptureSessionStorage(root);
  const capture = new CollectorNetworkCapture({ cdp, storage, projectDir: root });
  const emit = (method: string, params: Record<string, unknown>) => {
    dbg.emit("message", {}, method, params, "");
  };
  try {
    const started = await capture.start({ cdpGeneration: cdp.diagnostics().generation });

    // Script asset — must be skipped by content-type filter (not counted as JSON).
    emit("Network.requestWillBeSent", {
      requestId: "js1",
      request: { method: "GET", url: "https://example.com/app.js", headers: {} },
    });
    emit("Network.responseReceived", {
      requestId: "js1",
      response: {
        status: 200,
        mimeType: "application/javascript",
        headers: { "content-type": "application/javascript" },
      },
    });
    emit("Network.loadingFinished", { requestId: "js1" });

    // Real JSON with XSSI prefix.
    dbg.bodies.set("j1", { body: 'for (;;);{"ok":true}' });
    emit("Network.requestWillBeSent", {
      requestId: "j1",
      request: { method: "GET", url: "https://example.com/api", headers: {} },
    });
    emit("Network.responseReceived", {
      requestId: "j1",
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    });
    emit("Network.loadingFinished", { requestId: "j1" });

    // text/plain non-JSON — fetched + persisted as invalid.
    dbg.bodies.set("t1", { body: "not-json-at-all" });
    emit("Network.requestWillBeSent", {
      requestId: "t1",
      request: { method: "GET", url: "https://example.com/plain", headers: {} },
    });
    emit("Network.responseReceived", {
      requestId: "t1",
      response: {
        status: 200,
        headers: { "content-type": "text/plain" },
      },
    });
    emit("Network.loadingFinished", { requestId: "t1" });

    await pump();
    const stopped = await capture.stop();
    assert.equal(stopped.stats.requestsTracked, 3);
    assert.equal(stopped.stats.bodyStatusCounts?.skipped_filter, 1);
    assert.equal(stopped.stats.parseJsonOk, 1);
    assert.equal(stopped.stats.parseInvalid, 1);
    assert.equal(stopped.stats.bodiesFetched, 2);
    assert.equal(stopped.stats.bodiesSaved, 2);
    assert.ok((stopped.stats.bodiesSkipped ?? 0) >= 1);

    const rows = await storage.readRequestsNdjson(started.captureSessionId);
    const jsonRow = rows.find((r) => r.requestId === "j1");
    assert.equal(jsonRow?.bodyStatus, "json_ok");
    assert.ok(jsonRow?.bodyPath);
    const body = await readFile(path.join(stopped.artifactRoot, jsonRow!.bodyPath!), "utf8");
    assert.match(body, /for\s*\(;|;\)/);
    assert.ok(emptyCaptureStats().bodyStatusCounts);
  } finally {
    await capture.stop("cleanup").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("hotfix: Workspace stats UI no longer conflates bodiesSaved with JSON ok", () => {
  const tsx = readFileSync("src/renderer/collectors/CollectorScriptWorkspace.tsx", "utf8");
  assert.match(tsx, /Bodies persisted/);
  assert.match(tsx, /JSON parsed ok/);
  assert.match(tsx, /Body status breakdown/);
  assert.doesNotMatch(
    tsx,
    /parseJsonOk[\s\S]*saved ·[\s\S]*bodiesSaved[\s\S]*total bodies/,
  );
});
