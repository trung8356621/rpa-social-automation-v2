import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { PostDetailParentConfig, PostDetailSavedParentResolution } from "../src/shared/post-detail-collector/types.js";
import type { PostDetailDomStrategy } from "../src/renderer/post-detail-collector/types.js";
import {
  ensureTerminalResolution,
  isTerminalResolutionStatus,
  runAutoMatchStrategies,
} from "../src/renderer/post-detail-collector/auto-match.js";
import { resolveStableParent } from "../src/renderer/post-detail-collector/BatchValidationStep.js";
import { migratePostDetailState } from "../src/renderer/post-detail-collector/store.js";

function makeConfig(platform = "facebook", parentLevel = 26): PostDetailParentConfig {
  return {
    version: 2,
    platform,
    parentLevel,
    locatorStrategy: "POST_IDENTITY_ACTION_ROW_LEVEL",
    actionRowLocator: {
      version: 2,
      strategy: "POST_SCOPED_RELATIVE_XPATH",
      postIdentityAnchor: {
        platform: "facebook",
        reason: "facebook-permalink-path",
        xpathTemplate: "//a[contains(@href, {{POST_ID}})]",
      },
      absoluteXPath: "/html/body/div[1]",
      relativeXPath: "ancestor::div[1]",
      diagnosticXPathPrefixes: [],
      actionRowTag: "DIV",
      actionRowRole: "group",
      actionRowStructure: {
        childCount: 3,
        buttonCount: 3,
        svgCount: 3,
        directPattern: "DIV|DIV|DIV",
      },
      confirmedParentLevel: parentLevel,
      teachingEvidence: {
        anchorTag: "A",
        anchorReason: "permalink",
        anchorHrefPattern: "/posts/",
        absoluteMatchCount: 1,
        relativeMatchCount: 1,
        sameNode: true,
        confirmedRowMatched: true,
        confirmedParentMatched: true,
      },
    },
    updatedAt: "2026-11-16T00:00:00.000Z",
  };
}

function makeStrategy(id: string, platform = "facebook"): PostDetailDomStrategy {
  return {
    id,
    version: 1,
    platform,
    structuralSignature: id,
    parentConfig: makeConfig(platform),
    anchors: {},
    validationStatus: "CONFIRMED",
    successes: 0,
    failures: 0,
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
  };
}

function matchedResolution(postId: string, text = "Hello world"): PostDetailSavedParentResolution {
  return {
    status: "PARENT_MATCHED",
    innerHTML: `<div><span>${text}</span></div>`,
    rect: { x: 0, y: 0, width: 400, height: 200 },
    diagnosticMeta: {
      postId,
      postIdentityVerified: true,
      actionRowVerified: true,
      parentVerified: true,
      domAnchorsVerified: false,
    },
    diagnostics: [`Matched post ${postId}`],
  };
}

function installMinimalDomParser() {
  const previous = (globalThis as { DOMParser?: unknown }).DOMParser;
  class MinimalElement {
    innerHTML = "";
    children: MinimalElement[] = [];
    childNodes: Array<{ nodeType: number; textContent: string }> = [];
    attributes: Array<{ name: string; value: string }> = [];
    tagName = "DIV";
    get textContent() {
      return this.innerHTML.replace(/<[^>]+>/g, " ").trim();
    }
    querySelectorAll() {
      return [];
    }
    querySelector() {
      return null;
    }
    getAttribute() {
      return null;
    }
  }
  (globalThis as { DOMParser?: unknown }).DOMParser = class {
    parseFromString() {
      return {
        createElement: () => new MinimalElement(),
      };
    }
  };
  return () => {
    if (previous === undefined) delete (globalThis as { DOMParser?: unknown }).DOMParser;
    else (globalThis as { DOMParser?: unknown }).DOMParser = previous;
  };
}

test("1. Parent matched immediately after 2 stable snapshots", async () => {
  const restore = installMinimalDomParser();
  try {
    let calls = 0;
    const invoke = async () => {
      calls++;
      return matchedResolution("323911194117") as never;
    };
    const result = await runAutoMatchStrategies({
      invoke,
      strategies: [makeStrategy("s1")],
      expectedPostId: "323911194117",
      currentUrl: "https://www.facebook.com/groups/g/posts/323911194117/",
      isCancelled: () => false,
      retryDelayMs: 1,
    });
    assert.equal(result.outcome, "MATCHED");
    assert.equal(result.resolution.status, "PARENT_MATCHED");
    assert.equal(result.strategyId, "s1");
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});

test("2. Retryable DOM not ready eventually matches", async () => {
  const restore = installMinimalDomParser();
  try {
    let calls = 0;
    const invoke = async () => {
      calls++;
      if (calls <= 2) {
        return {
          status: "REMATCH_REQUIRED",
          failureCode: "ACTION_ROW_SELECTOR_NOT_FOUND",
          innerHTML: "",
          rect: null,
          diagnostics: ["Waiting for lazy DOM"],
        } as never;
      }
      return matchedResolution("323911194117") as never;
    };
    const result = await runAutoMatchStrategies({
      invoke,
      strategies: [makeStrategy("s1")],
      expectedPostId: "323911194117",
      currentUrl: "https://www.facebook.com/groups/g/posts/323911194117/",
      isCancelled: () => false,
      retryDelayMs: 1,
    });
    assert.equal(result.outcome, "MATCHED");
    assert.equal(result.resolution.status, "PARENT_MATCHED");
    assert.equal(calls, 4);
  } finally {
    restore();
  }
});

test("3. Non-retryable failure stops immediately and reaches terminal state", async () => {
  let calls = 0;
  const invoke = async () => {
    calls++;
    return {
      status: "REMATCH_REQUIRED",
      failureCode: "ACTION_ROW_AMBIGUOUS",
      innerHTML: "",
      rect: null,
      diagnostics: ["Multiple action rows matched"],
    } as never;
  };
  const result = await runAutoMatchStrategies({
    invoke,
    strategies: [makeStrategy("s1")],
    expectedPostId: "323911194117",
    currentUrl: "https://www.facebook.com/groups/g/posts/323911194117/",
    isCancelled: () => false,
    maxAttemptsPerStrategy: 10,
    retryDelayMs: 1,
  });
  assert.equal(result.outcome, "FAILED");
  assert.equal(result.resolution.status, "REMATCH_REQUIRED");
  assert.equal(result.resolution.failureCode, "ACTION_ROW_AMBIGUOUS");
  assert.equal(calls, 1);
  assert.equal(isTerminalResolutionStatus(result.resolution.status), true);
});

test("4. All strategies exhausted produces terminal failure", async () => {
  let calls = 0;
  const invoke = async () => {
    calls++;
    return {
      status: "REMATCH_REQUIRED",
      failureCode: "NOT_FOUND",
      innerHTML: "",
      rect: null,
      diagnostics: ["Not found"],
    } as never;
  };
  const result = await runAutoMatchStrategies({
    invoke,
    strategies: [makeStrategy("s1"), makeStrategy("s2")],
    expectedPostId: "323911194117",
    currentUrl: "https://www.facebook.com/groups/g/posts/323911194117/",
    isCancelled: () => false,
    maxAttemptsPerStrategy: 2,
    retryDelayMs: 1,
  });
  assert.equal(result.outcome, "FAILED");
  assert.equal(result.resolution.status, "REMATCH_REQUIRED");
  assert.equal(result.resolution.diagnosticMeta?.strategiesTried, 2);
  assert.equal(calls, 4);
});

test("5. Total timeout bounds multi-strategy resolution to BROWSER_NOT_READY", async () => {
  const invoke = async () => {
    await new Promise(resolve => setTimeout(resolve, 15));
    return {
      status: "BROWSER_NOT_READY",
      failureCode: "BROWSER_NOT_READY",
      innerHTML: "",
      rect: null,
      diagnostics: ["Still loading"],
    } as never;
  };
  const result = await runAutoMatchStrategies({
    invoke,
    strategies: [makeStrategy("s1"), makeStrategy("s2"), makeStrategy("s3")],
    expectedPostId: "323911194117",
    currentUrl: "https://www.facebook.com/groups/g/posts/323911194117/",
    isCancelled: () => false,
    timeoutMs: 35,
    maxAttemptsPerStrategy: 10,
    retryDelayMs: 10,
  });
  assert.equal(result.outcome, "FAILED");
  assert.equal(result.resolution.status, "BROWSER_NOT_READY");
  assert.equal(result.resolution.diagnosticMeta?.timedOut, true);
  assert.equal(isTerminalResolutionStatus(result.resolution.status), true);
});

test("6 & 9. Navigation A -> B while A resolving cancels A and prevents old async result from overwriting B", async () => {
  const restore = installMinimalDomParser();
  try {
    let activeEpoch = 1;
    const writes: Array<{ post: string; status: string }> = [];

    const runA = (async () => {
      const epoch = 1;
      const res = await runAutoMatchStrategies({
        invoke: async () => {
          await new Promise(resolve => setTimeout(resolve, 30));
          return matchedResolution("post-A") as never;
        },
        strategies: [makeStrategy("s1")],
        expectedPostId: "post-A",
        currentUrl: "https://www.facebook.com/groups/g/posts/111/",
        isCancelled: () => activeEpoch !== epoch,
        retryDelayMs: 1,
      });
      if (activeEpoch === epoch) {
        writes.push({ post: "A", status: res.resolution.status });
      }
      return res;
    })();

    await new Promise(resolve => setTimeout(resolve, 5));
    activeEpoch = 2; // Navigate to B while A is still awaiting invoke

    const resB = await runAutoMatchStrategies({
      invoke: async () => matchedResolution("post-B") as never,
      strategies: [makeStrategy("s1")],
      expectedPostId: "post-B",
      currentUrl: "https://www.facebook.com/groups/g/posts/222/",
      isCancelled: () => activeEpoch !== 2,
      retryDelayMs: 1,
    });
    if (activeEpoch === 2) {
      writes.push({ post: "B", status: resB.resolution.status });
    }

    const resA = await runA;
    assert.equal(resA.outcome, "CANCELLED");
    assert.equal(resA.resolution.status, "CANCELLED");
    assert.deepEqual(writes, [{ post: "B", status: "PARENT_MATCHED" }]);
  } finally {
    restore();
  }
});

test("7. App restart with persisted RESOLVING normalizes to terminal BROWSER_NOT_READY", () => {
  const migrated = migratePostDetailState({
    savedParentResolution: {
      status: "RESOLVING",
      innerHTML: "",
      rect: null,
      diagnostics: ["In flight"],
    },
    urlItems: [
      {
        id: "facebook:323911194117",
        originalUrl: "https://www.facebook.com/groups/g/posts/323911194117/",
        canonicalUrl: "https://www.facebook.com/groups/g/posts/323911194117/",
        postId: "323911194117",
        platform: "facebook",
        status: "PROCESSING",
        diagnostics: [],
        updatedAt: "2026-11-16T00:00:00.000Z",
      },
    ],
  });
  assert.equal(migrated.savedParentResolution?.status, "BROWSER_NOT_READY");
  assert.equal(migrated.urlItems?.[0]?.status, "NEEDS_ATTENTION");
  assert.equal(ensureTerminalResolution({ status: "RESOLVING", innerHTML: "", rect: null, diagnostics: [] }).status, "REMATCH_REQUIRED");
});

test("8 & 10. Page guards duplicate resolvers, provides Retry Auto Match, and Step 3 UI separates RESOLVING from failure", () => {
  const page = readFileSync("src/renderer/post-detail-collector/PostDetailCollectorPage.tsx", "utf8");
  const step3 = readFileSync("src/renderer/post-detail-collector/SavedParentHtmlStep.tsx", "utf8");

  assert.match(page, /activeResolveRunRef/);
  assert.match(page, /cancelActiveResolve/);
  assert.match(page, /retryAutoMatch/);
  assert.match(page, /onRetryAutoMatch=/);
  assert.match(page, /activeResolveRunRef\.current\?\.targetKey === targetKey/);

  assert.match(step3, /status === "RESOLVING" \? <div><h3>Resolving Parent\.\.\.<\/h3>/);
  assert.match(step3, /Retry Auto Match/);
  assert.match(step3, /Customize · Rematch Parent/);
  assert.match(step3, /Advanced Debug/);
});

test("resolveStableParent returns CANCELLED immediately when cancelled mid-run", async () => {
  let cancelled = false;
  const res = await resolveStableParent({
    invoke: async () => {
      cancelled = true;
      return matchedResolution("323911194117") as never;
    },
    config: makeConfig(),
    expectedPostId: "323911194117",
    currentUrl: "https://www.facebook.com/groups/g/posts/323911194117/",
    cancelled: () => cancelled,
    retryDelayMs: 1,
  });
  assert.equal(res.status, "CANCELLED");
});
