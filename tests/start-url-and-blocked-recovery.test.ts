import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import { BrowserSessions } from "../src/main/browser-sessions.js";
import { TestLab } from "../src/main/test-lab.js";
import {
  isSameStartPage,
  parseHttpStartUrl,
  START_URL_REQUIRED,
} from "../src/shared/start-url.js";
import {
  actionTagStartUrlMode,
  resolveUrlFromActionTag,
} from "../src/shared/action-tag-url.js";
import type { ActionTag } from "../src/shared/contracts.js";

test("parseHttpStartUrl and same-page compare", () => {
  assert.equal(parseHttpStartUrl(""), undefined);
  assert.equal(parseHttpStartUrl("ftp://x"), undefined);
  assert.equal(
    parseHttpStartUrl("https://www.facebook.com/groups/1/")?.href,
    "https://www.facebook.com/groups/1/",
  );
  assert.equal(
    isSameStartPage(
      "https://www.facebook.com/groups/1/",
      "https://www.facebook.com/groups/1",
    ),
    true,
  );
  assert.equal(
    isSameStartPage(
      "https://mayhopphat.com/wp-login.php",
      "https://www.facebook.com/",
    ),
    false,
  );
  assert.match(START_URL_REQUIRED, /^START_URL_REQUIRED/);
});

test("ensureForScenario never copies Browser Session lastUrl from another Script", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "start-url-ensure-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    const sessions = new BrowserSessions(store);
    const sessionId = sessions.activeId();
    sessions.recordVisit(sessionId, "https://mayhopphat.com/wp-admin/");
    assert.equal(sessions.get(sessionId).lastUrl, "https://mayhopphat.com/wp-admin/");

    const facebook = store.newFlow("Facebook draft", 1);
    store.updateFlowMeta(facebook.id, {
      startUrl: "https://www.facebook.com/groups/demo",
    });
    const orphan = store.newFlow("No URL", 1);
    const lab = new TestLab(store, sessions);

    const ok = lab.ensureForScenario(facebook.id, true);
    assert.equal(ok.startUrl, "https://www.facebook.com/groups/demo");
    assert.notEqual(ok.startUrl, "https://mayhopphat.com/wp-admin/");

    const missing = lab.ensureForScenario(orphan.id, false);
    assert.equal(missing.startUrl, "");
    assert.throws(() => lab.validate(missing, false), /START_URL_REQUIRED/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("two Scripts keep independent startUrl ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "start-url-scripts-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    const wp = store.newFlow("WP Login", 1);
    store.updateFlowMeta(wp.id, { startUrl: "https://mayhopphat.com/wp-login.php" });
    const fb = store.newFlow("FB Post", 1);
    store.updateFlowMeta(fb.id, { startUrl: "https://www.facebook.com/groups/x" });
    assert.equal(
      store.flows().find((f) => f.id === wp.id)?.startUrl,
      "https://mayhopphat.com/wp-login.php",
    );
    assert.equal(
      store.flows().find((f) => f.id === fb.id)?.startUrl,
      "https://www.facebook.com/groups/x",
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("tag change clears prior Script Start URL when Static Tag cannot resolve", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "start-url-tag-clear-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    const wpTag: ActionTag = {
      id: 1,
      tag_key: "mayhopphat.login",
      platform: "mayhopphat",
      target: "login",
      action: "",
      name: "WP",
      base_url: "https://mayhopphat.com",
      url_pattern: "/wp-login.php",
      path_inputs: [],
    };
    const fbTag: ActionTag = {
      id: 2,
      tag_key: "facebook.group.post",
      platform: "facebook",
      target: "group",
      action: "post",
      name: "FB",
      base_url: "https://www.facebook.com",
      url_pattern: "/groups/{group_id}",
      path_inputs: [{ key: "group_id", type: "string", required: true }],
    };
    const flow = store.newFlow("Mixed", 1);
    const wpResolved = resolveUrlFromActionTag(wpTag, {});
    assert.equal(actionTagStartUrlMode(wpTag), "auto");
    assert.equal(wpResolved.ok, true);
    if (wpResolved.ok) {
      store.updateFlowMeta(flow.id, {
        actionTagKey: wpTag.tag_key,
        startUrl: wpResolved.url,
      });
    }
    assert.equal(
      store.flows().find((f) => f.id === flow.id)?.startUrl,
      "https://mayhopphat.com/wp-login.php",
    );

    // Mirrors updateFlowMetadata on Static Tag change: resolve fail → clear startUrl.
    assert.equal(actionTagStartUrlMode(fbTag), "manual");
    const fbResolved = resolveUrlFromActionTag(fbTag, {});
    assert.equal(fbResolved.ok, false);
    // Failed resolve must clear prior Script URL (mirrors updateFlowMetadata).
    store.updateFlowMeta(flow.id, {
      actionTagKey: fbTag.tag_key,
      startUrl: "",
      pathInputValues: {},
    });
    // Store normalizes "" → undefined; UI treats both as START_URL_REQUIRED.
    assert.equal(store.flows().find((f) => f.id === flow.id)?.startUrl, undefined);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("assertFlowExecutable blocks Play All / Test Lab when pinned CLICK_TARGET lacks ROI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "preflight-missing-roi-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    store.newFlow("FB POC", 1);
    store.updateFlowMeta(store.flow()!.id, {
      startUrl: "https://www.facebook.com/groups/demo",
    });
    store.saveStep("Wait", { action: "SLEEP", sleepMs: 10 });
    const broken = store.saveStep("Click Login", { action: "CLICK_TARGET" });
    const flow = store.flow()!;
    assert.ok(flow.steps.some((r) => r.id === broken.id && r.version === broken.version));
    assert.throws(
      () => store.assertFlowExecutable(flow),
      /Step thiếu ảnh ROI target đã crop|→ Step /,
    );
    assert.throws(
      () => store.assertStepExecutable(broken.id, broken.version, flow),
      /Click Login|thiếu ảnh ROI|Ghim version/i,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Test Lab Case Start URL stays on Script Start URL — never Browser lastUrl", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "case-start-url-owner-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    const sessions = new BrowserSessions(store);
    sessions.recordVisit(sessions.activeId(), "https://mayhopphat.com/wp-admin/");
    const flow = store.newFlow("Facebook script", 1);
    store.updateFlowMeta(flow.id, {
      startUrl: "https://www.facebook.com/groups/314158368669766",
    });
    const lab = new TestLab(store, sessions);
    const item = lab.ensureForScenario(flow.id, true);
    assert.equal(item.startUrl, "https://www.facebook.com/groups/314158368669766");
    assert.notEqual(item.startUrl, "https://mayhopphat.com/wp-admin/");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupted RUNNING case recovers so Run Again is not stuck on RUNNING", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blocked-running-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    const sessions = new BrowserSessions(store);
    const flow = store.newFlow("Script", 1);
    store.updateFlowMeta(flow.id, { startUrl: "https://www.facebook.com/" });
    const lab = new TestLab(store, sessions);
    const item = lab.ensureForScenario(flow.id, true);
    lab.result(item.id, {
      runId: "run-stuck",
      caseId: item.id,
      caseName: item.name,
      flowId: flow.id,
      sessionId: item.sessionId,
      startUrl: item.startUrl,
      status: "RUNNING",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      message: "interrupted",
      steps: [],
    });
    // Reconstruct lab as on app restart — clears stuck RUNNING.
    const recovered = new TestLab(store, sessions).get(item.id);
    assert.equal(recovered.lastResult?.status, "ERROR");
    assert.notEqual(recovered.lastResult?.status, "RUNNING");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
