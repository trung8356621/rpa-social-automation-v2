import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureTestLabStartUrl,
  isNavigationAbortError,
  type TestLabNavWebContents,
} from "../src/main/test-lab-start-nav.js";

type Listener = (...args: unknown[]) => void;

function mockWc(initialUrl: string, opts?: { loading?: boolean }) {
  let url = initialUrl;
  let loading = opts?.loading ?? false;
  const listeners = new Map<string, Set<Listener>>();
  const wc: TestLabNavWebContents = {
    getURL: () => url,
    isLoading: () => loading,
    isDestroyed: () => false,
    stop: () => {
      loading = false;
    },
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as Listener);
      listeners.set(event, set);
    },
    removeListener: (event, listener) => {
      listeners.get(event)?.delete(listener as Listener);
    },
  };
  return {
    wc,
    setUrl: (next: string) => {
      url = next;
    },
    setLoading: (next: boolean) => {
      loading = next;
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
  };
}

test("isNavigationAbortError detects ERR_ABORTED (-3)", () => {
  assert.equal(
    isNavigationAbortError(new Error("ERR_ABORTED (-3) loading 'https://www.facebook.com/groups/1'")),
    true,
  );
  assert.equal(isNavigationAbortError(new Error("net::ERR_NAME_NOT_RESOLVED")), false);
});

test("already on Start URL and ready → skip reload", async () => {
  const href = "https://www.facebook.com/groups/314158368669766";
  const mock = mockWc(href);
  let navigated = 0;
  const result = await ensureTestLabStartUrl({
    wc: mock.wc,
    startHref: href,
    navigate: async () => {
      navigated += 1;
    },
    settleMs: 0,
  });
  assert.equal(result.skipped, true);
  assert.equal(navigated, 0);
  assert.equal(result.finalUrl, href);
  assert.ok(result.events.some((e) => e.type === "skip-already-ready"));
  assert.equal(mock.listenerCount("did-fail-load"), 0);
});

test("ERR_ABORTED then final URL matches → continue", async () => {
  const href = "https://www.facebook.com/groups/314158368669766";
  const mock = mockWc("https://www.facebook.com/");
  const result = await ensureTestLabStartUrl({
    wc: mock.wc,
    startHref: href,
    settleMs: 0,
    sleep: async () => undefined,
    navigate: async () => {
      mock.setLoading(true);
      mock.emit("did-fail-load", {}, -3, "ERR_ABORTED", href, true);
      mock.setUrl(href);
      mock.setLoading(false);
      mock.emit("did-navigate", {}, href, 200);
      mock.emit("dom-ready");
      throw new Error(`ERR_ABORTED (-3) loading '${href}'`);
    },
  });
  assert.equal(result.skipped, false);
  assert.equal(result.finalUrl, href);
  assert.ok(result.events.some((e) => e.type === "abort-ignored"));
  assert.ok(result.events.some((e) => e.type === "ready"));
  assert.equal(mock.listenerCount("did-fail-load"), 0);
});

test("ERR_ABORTED without reaching Start URL → ERROR", async () => {
  const href = "https://www.facebook.com/groups/314158368669766";
  const mock = mockWc("https://www.facebook.com/");
  await assert.rejects(
    () =>
      ensureTestLabStartUrl({
        wc: mock.wc,
        startHref: href,
        settleMs: 0,
        sleep: async () => undefined,
        navigate: async () => {
          mock.emit("did-fail-load", {}, -3, "ERR_ABORTED", href, true);
          mock.setUrl("https://www.facebook.com/");
          mock.setLoading(false);
          throw new Error(`ERR_ABORTED (-3) loading '${href}'`);
        },
      }),
    /chưa tới đích/,
  );
  assert.equal(mock.listenerCount("did-fail-load"), 0);
});

test("real network failure → ERROR", async () => {
  const href = "https://www.facebook.com/groups/314158368669766";
  const mock = mockWc("about:blank");
  await assert.rejects(
    () =>
      ensureTestLabStartUrl({
        wc: mock.wc,
        startHref: href,
        settleMs: 0,
        sleep: async () => undefined,
        navigate: async () => {
          mock.emit(
            "did-fail-load",
            {},
            -105,
            "ERR_NAME_NOT_RESOLVED",
            href,
            true,
          );
          throw new Error("ERR_NAME_NOT_RESOLVED");
        },
      }),
    /tải thất bại \(-105/,
  );
});

test("HTTP 500 on did-navigate → ERROR", async () => {
  const href = "https://example.com/start";
  const mock = mockWc("about:blank");
  await assert.rejects(
    () =>
      ensureTestLabStartUrl({
        wc: mock.wc,
        startHref: href,
        settleMs: 0,
        sleep: async () => undefined,
        navigate: async () => {
          mock.setUrl(href);
          mock.emit("did-navigate", {}, href, 500);
          mock.setLoading(false);
        },
      }),
    /HTTP 500/,
  );
});
