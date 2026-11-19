import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CollectorCaptureSessionStorage } from "../src/main/collector-capture-session-storage.js";
import {
  activeVisualPartFromBinding,
  isVisualTemplatesComplete,
  resolveVisualPartBinding,
  visualPartOptionKey,
} from "../src/shared/collectors/visual-part-binding.js";
import {
  VISUAL_OBSERVATION_SCHEMA_VERSION,
  type VisualObservationRecord,
} from "../src/shared/collectors/visual-observation-types.js";
import {
  MemoryKeyValueStorage,
  PartLibraryRepository,
} from "../src/shared/collectors/part-library-repository.js";
import { WEB_HEIGHT, WEB_WIDTH } from "../src/shared/geometry.js";
import { emptyVisualFeedItemConfig } from "../src/shared/collectors/part-library-types.js";

function completeTemplates() {
  const tpl = (kind: string) => ({
    kind,
    dataUrl: `data:image/png;base64,${kind}`,
    width: 24,
    height: 24,
    sourceFrameId: "f1",
    bbox: { x: 0, y: 0, width: 24, height: 24 },
  });
  return {
    like: tpl("like"),
    comment: tpl("comment"),
    share: tpl("share"),
  };
}

test("c2b6.2: canonical viewport constants remain 1024×560", () => {
  assert.equal(WEB_WIDTH, 1024);
  assert.equal(WEB_HEIGHT, 560);
});

test("c2b6.2: Workspace shell is non-scrolling; evidence scrolls independently", () => {
  const css = readFileSync("src/renderer/collectors/part-library.css", "utf8");
  const tsx = readFileSync("src/renderer/collectors/CollectorScriptWorkspace.tsx", "utf8");
  assert.match(css, /\.collector-script-workspace\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.csw-evidence-scroll\s*\{[^}]*overflow:\s*auto/s);
  assert.match(css, /\.csw-browser-panel-body\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /width:\s*1024px/);
  assert.match(css, /height:\s*560px/);
  assert.match(tsx, /csw-evidence-scroll/);
  assert.match(tsx, /csw-workspace-shell/);
  assert.match(tsx, /Observe Visual Now/);
  assert.doesNotMatch(tsx, /for\s*\(\s*let\s+frame\s*=\s*1;\s*frame\s*<=\s*5/);
});

test("c2b6.2: Creator geometry constants untouched by Workspace host CSS", () => {
  const geometry = readFileSync("src/shared/geometry.ts", "utf8");
  assert.match(geometry, /width:\s*1024/);
  assert.match(geometry, /height:\s*560/);
  const workspace = readFileSync("src/renderer/collectors/CollectorScriptWorkspace.tsx", "utf8");
  assert.doesNotMatch(workspace, /browser-core/i);
});

test("c2b6.2: Visual Part resolves from Part Library templates (not legacy)", () => {
  const storage = new MemoryKeyValueStorage();
  const repo = new PartLibraryRepository(storage);
  const visual = repo.createVisualFeedItemPart("test");
  repo.updatePartConfig(visual.partId, {
    ...emptyVisualFeedItemConfig(),
    templates: completeTemplates(),
  });
  const network = repo.createNetworkDraftPart("test network");
  const script = repo.createCollectorScript("script", [
    { partId: visual.partId, partVersion: 1 },
    { partId: network.partId, partVersion: 1 },
  ]);

  const binding = resolveVisualPartBinding(script.partRefs, repo.listParts());
  assert.equal(binding.kind, "single");
  if (binding.kind !== "single") return;
  assert.equal(binding.selected.partId, visual.partId);
  assert.equal(binding.selected.partVersion, 1);
  assert.ok(binding.selected.templatesComplete);
  assert.ok(isVisualTemplatesComplete(binding.selected.templates));
  assert.equal(activeVisualPartFromBinding(binding)?.name, "test");
});

test("c2b6.2: missing / incomplete Visual Part reports explicitly", () => {
  const storage = new MemoryKeyValueStorage();
  const repo = new PartLibraryRepository(storage);
  const emptyVisual = repo.createVisualFeedItemPart("empty");
  const script = repo.createCollectorScript("s", [
    { partId: emptyVisual.partId, partVersion: 1 },
  ]);
  const binding = resolveVisualPartBinding(script.partRefs, repo.listParts());
  assert.equal(binding.kind, "incomplete");
  if (binding.kind !== "incomplete") return;
  assert.match(binding.reason, /missing Like\/Comment\/Share/i);

  const none = resolveVisualPartBinding([], repo.listParts());
  assert.equal(none.kind, "none");
});

test("c2b6.2: multiple Visual Parts require explicit selection", () => {
  const storage = new MemoryKeyValueStorage();
  const repo = new PartLibraryRepository(storage);
  const a = repo.createVisualFeedItemPart("a");
  const b = repo.createVisualFeedItemPart("b");
  repo.updatePartConfig(a.partId, {
    ...emptyVisualFeedItemConfig(),
    templates: completeTemplates(),
  });
  repo.updatePartConfig(b.partId, {
    ...emptyVisualFeedItemConfig(),
    templates: completeTemplates(),
  });
  const script = repo.createCollectorScript("multi", [
    { partId: a.partId, partVersion: 1 },
    { partId: b.partId, partVersion: 1 },
  ]);
  const unbound = resolveVisualPartBinding(script.partRefs, repo.listParts());
  assert.equal(unbound.kind, "multiple");
  if (unbound.kind !== "multiple") return;
  assert.match(unbound.reason, /Select which Visual Part/i);
  assert.equal(unbound.selected, undefined);

  const key = visualPartOptionKey({ partId: b.partId, partVersion: 1 });
  const bound = resolveVisualPartBinding(script.partRefs, repo.listParts(), key);
  assert.equal(bound.kind, "multiple");
  if (bound.kind !== "multiple") return;
  assert.equal(bound.selected?.partId, b.partId);
});

test("c2b6.2: Visual observation storage shares captureSessionId with Network layout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rpa-c2b62-"));
  try {
    const storage = new CollectorCaptureSessionStorage(root);
    const captureSessionId = "capsess_visual_001";
    await storage.writeSession({
      schemaVersion: 1,
      captureSessionId,
      cdpGeneration: 1,
      status: "running",
      startedAt: new Date().toISOString(),
      filters: {},
      limits: {
        maxRequestsTracked: 100,
        maxBodyBytes: 1000,
        maxTotalArtifactBytes: 10_000,
        maxPendingBodyFetches: 2,
      },
      stats: {
        requestsTracked: 0,
        bodiesSaved: 0,
        bodiesSkipped: 0,
        bodiesFetched: 0,
        parseJsonOk: 0,
        parseNdjsonOk: 0,
        parseInvalid: 0,
        loadFailed: 0,
        redirects: 0,
        totalArtifactBytes: 0,
        diagnostics: 0,
        bodyStatusCounts: {},
      },
      artifactRoot: storage.getSessionDir(captureSessionId),
      diagnostics: [],
    });

    const observation: VisualObservationRecord = {
      schemaVersion: VISUAL_OBSERVATION_SCHEMA_VERSION,
      observationId: "vobs_1",
      captureSessionId,
      browserSessionId: "browser-a",
      visualPartId: "part_test",
      visualPartVersion: 1,
      observedAt: new Date().toISOString(),
      status: "success",
      actionRowsDetected: 2,
      rawIconMatches: 6,
      candidateCount: 2,
      boundaryFound: 2,
      boundaryAmbiguous: 0,
      boundaryNotFound: 0,
      estimatedUniqueItemCount: 2,
      duplicateCount: 0,
      possibleDuplicateCount: 0,
      candidates: [
        {
          candidateId: "cand_1",
          boundaryStatus: "BOUNDARY_FOUND",
          dedupeStatus: "NEW_ITEM",
          iconCount: 3,
          matchScore: 0.9,
        },
      ],
      diagnostics: ["unit"],
    };

    const written = await storage.appendVisualObservation(observation, [
      { candidateId: "cand_1", html: "<article>post</article>", maxBytes: 10_000 },
    ]);
    assert.match(written.observationArtifactRef, /visual\/observations\.ndjson/);
    assert.ok(written.htmlArtifactRefs.cand_1);

    const loaded = await storage.readVisualObservations(captureSessionId);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.captureSessionId, captureSessionId);
    assert.equal(loaded[0]?.estimatedUniqueItemCount, 2);
    assert.equal(loaded[0]?.candidates[0]?.htmlArtifactRef, written.htmlArtifactRefs.cand_1);

    const htmlPath = path.join(storage.getSessionDir(captureSessionId), written.htmlArtifactRefs.cand_1!);
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /<article>post<\/article>/);

    // Network evidence path remains independent under same session root.
    await storage.appendRequestMeta({
      schemaVersion: 1,
      captureSessionId,
      requestId: "r1",
      artifactId: "a1",
      method: "GET",
      url: "https://example.com/x",
      urlRedacted: "https://example.com/x",
      timestamp: new Date().toISOString(),
      bodyStatus: "not_requested",
      completed: true,
    });
    const requests = await storage.readRequestsNdjson(captureSessionId);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.captureSessionId, loaded[0]?.captureSessionId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("c2b6.2: Visual observe helper reuses matcher imports (no forked thresholds)", () => {
  const src = readFileSync("src/renderer/collectors/visual-runtime-observe.ts", "utf8");
  assert.match(src, /detectActionRows/);
  assert.match(src, /runRecognitionPipeline/);
  assert.match(src, /visualMatchLabCapture/);
  assert.match(src, /visualMatchLabProbeBoundary/);
  assert.match(src, /dedupeCandidates/);
  assert.match(src, /0\.72/);
  assert.match(src, /grayscale/);
  assert.doesNotMatch(src, /for\s*\(\s*let\s+frame\s*=\s*1;\s*frame\s*<=\s*5/);
  assert.match(src, /html_snapshot_requires_boundary_probe/);
});

test("c2b6.2: Feed Visual Counter AutoMatch still owns five-sample authoring loop", () => {
  const auto = readFileSync("src/renderer/feed-item-collector/AutoMatchStep.tsx", "utf8");
  assert.match(auto, /for \(let frame = 1; frame <= 5; frame\+\+\)/);
  assert.match(auto, /0\.72/);
});

test("c2b6.2: partRefs order is not treated as Visual execution order", () => {
  const bindingSrc = readFileSync("src/shared/collectors/visual-part-binding.ts", "utf8");
  assert.match(bindingSrc, /never treated as execution order/);
  const networkSrc = readFileSync("src/shared/collectors/network-part-binding.ts", "utf8");
  assert.match(networkSrc, /never treated as execution order/);
});
