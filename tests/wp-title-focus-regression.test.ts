import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { resolveVisualTarget } from "../src/main/target-resolver.js";
import { matchTemplate } from "../src/main/visual.js";
import { Store } from "../src/main/storage.js";
import {
  assertScriptPublishBody,
  buildScriptCatalogSnapshot,
  buildScriptPublishBody,
} from "../src/shared/script-release.js";
import {
  computeExecutionDigest,
  computeScriptContentDigest,
} from "../src/shared/script-digest.js";
import { nextPublishedScriptVersion } from "../src/shared/script-version.js";
import type { Flow, OcrResult, Payload, Step } from "../src/shared/contracts.js";

async function buildTitleFixtures() {
  // 507x41 WordPress Classic Editor #title box with outer gray border and "Add title" placeholder
  const fullSvg = `<svg width="507" height="41" xmlns="http://www.w3.org/2000/svg">
    <rect x="0.5" y="0.5" width="506" height="40" fill="#ffffff" stroke="#8c8f94" stroke-width="1"/>
    <text x="12" y="26" font-family="Arial, sans-serif" font-size="20" fill="#646970">Add title</text>
  </svg>`;
  const fullTemplate = await sharp(Buffer.from(fullSvg)).png().toBuffer();

  // Interior crop (100x29) inside #title excluding the 4px outer border that changes on :focus
  const interiorRect = { x: 6, y: 6, width: 100, height: 29 };
  const interiorTemplate = await sharp(fullTemplate)
    .extract({
      left: interiorRect.x,
      top: interiorRect.y,
      width: interiorRect.width,
      height: interiorRect.height,
    })
    .png()
    .toBuffer();

  async function renderViewport(state: "unfocused" | "focused_with_caret" | "focused_without_caret") {
    const overlays: sharp.OverlayOptions[] = [{ input: fullTemplate, left: 181, top: 455 }];
    if (state !== "unfocused") {
      // Simulate WordPress :focus blue border + box-shadow (and optional 1px caret)
      const focusSvg = `<svg width="507" height="41" xmlns="http://www.w3.org/2000/svg">
        <rect x="1" y="1" width="505" height="39" fill="none" stroke="#2271b1" stroke-width="3"/>
        ${state === "focused_with_caret" ? '<line x1="10" y1="10" x2="10" y2="30" stroke="#1d2327" stroke-width="1"/>' : ""}
      </svg>`;
      overlays.push({ input: Buffer.from(focusSvg), left: 181, top: 455 });
    }
    return sharp({
      create: { width: 1024, height: 560, channels: 3, background: "#f0f0f1" },
    })
      .composite(overlays)
      .png()
      .toBuffer();
  }

  return { fullTemplate, interiorTemplate, interiorRect, renderViewport };
}

test("maytuicanvas EN Step 0 interior template resolves in unfocused, focused+caret, and focused-no-caret states", async () => {
  const { fullTemplate, interiorTemplate, interiorRect, renderViewport } = await buildTitleFixtures();

  const failingOcr = {
    recognize: async (): Promise<OcrResult> => ({
      text: "",
      confidence: 0,
      language: "vie+eng",
      segments: [],
    }),
  };

  const correctedPayload: Payload = {
    action: "CLICK_AND_TYPE",
    variableId: "12c3f299-e7a1-43dc-9865-2d3c3613b129",
    inputMethod: "clipboard",
    method: "auto",
    threshold: 0.96,
    timeoutMs: 3000,
    target: {
      asset: "interior-add-title.png",
      roi: {
        x: 181 + interiorRect.x,
        y: 455 + interiorRect.y,
        width: interiorRect.width,
        height: interiorRect.height,
      },
      environment: { width: 1024, height: 560, zoom: 1 },
      matchTo: "none",
    },
  };

  for (const state of ["unfocused", "focused_with_caret", "focused_without_caret"] as const) {
    const frame = await renderViewport(state);
    if (state !== "unfocused") {
      // Confirm old full-border template degrades on focus ring
      const legacyMatch = await matchTemplate(
        frame,
        fullTemplate,
        { x: 181, y: 455, width: 507, height: 41 },
        { expand: false, threshold: 0.96 },
      );
      assert.ok(legacyMatch.score < 0.96, `Expected full-border template to drop below 0.96 in ${state}, got ${legacyMatch.score}`);
    }

    const resolved = await resolveVisualTarget(frame, interiorTemplate, correctedPayload, failingOcr);
    assert.equal(resolved.method, "image", `Expected image resolution in ${state}`);
    assert.ok(resolved.score >= 0.96, `Expected score >= 0.96 in ${state}, got ${resolved.score}`);
    assert.equal(resolved.x, 181 + interiorRect.x + interiorRect.width / 2);
    assert.equal(resolved.y, 455 + interiorRect.y + interiorRect.height / 2);
  }
});

test("immutable Release 12 is preserved when preparing Release 13 with corrected EN Step 0 and unchanged VI variant", () => {
  const store = new Store(":memory:");
  try {
    // 1. Seed EN Flow (Release 12 baseline)
    const enVarId = "12c3f299-e7a1-43dc-9865-2d3c3613b129";
    const enFlowId = "382f26c4-d39a-4f2d-a8a3-d255f6c65c61";
    const step0Id = "8277dc02-284a-45b7-bb63-401881b6b568";

    store.newFlow("create post wp en", 1);
    store.updateVariables(
      [{ id: enVarId, key: "title", type: "text" }],
      { [enVarId]: "Sample Maytuicanvas Title" },
    );

    const v5Payload: Payload = {
      action: "CLICK_AND_TYPE",
      variableId: enVarId,
      inputMethod: "clipboard",
      method: "auto",
      threshold: 0.96,
      timeoutMs: 3000,
      target: {
        asset: "2b58dbca-864e-4b86-b25b-1644cf515fd9.png",
        roi: { x: 181, y: 455, width: 507, height: 41 },
        environment: { width: 1024, height: 560, zoom: 1 },
        ocr: {
          text: "Add title",
          bbox: { x: 11, y: 11, width: 83, height: 18 },
          confidence: 92,
          kind: "line",
          language: "vie+eng",
          confirmed: true,
        },
        matchTo: "top",
      },
    };
    const saveDraftPayload: Payload = {
      action: "CLICK_TARGET",
      method: "auto",
      threshold: 0.96,
      timeoutMs: 3000,
      target: {
        asset: "eb8d0bd4-7f84-46d2-b350-8faea1cf25be.png",
        roi: { x: 719, y: 452, width: 97, height: 41 },
        environment: { width: 1024, height: 560, zoom: 1 },
        ocr: {
          text: "Save Draft",
          bbox: { x: 19, y: 15, width: 61, height: 11 },
          confidence: 92,
          kind: "line",
          language: "vie+eng",
          confirmed: true,
        },
        matchTo: "middle",
      },
    };

    const step0v5 = store.saveStep("Add title", v5Payload);
    const step1v1 = store.saveStep("Save draft", saveDraftPayload);

    const enFlowBase: Flow = {
      id: enFlowId,
      name: "create post wp en",
      zoom: 1,
      actionTagKey: "maytuicanvas.create_post",
      variables: [{ id: enVarId, key: "title", type: "text" }],
      defaultPattern: { values: { [enVarId]: "Sample Maytuicanvas Title" } },
      steps: [
        { id: step0v5.id, version: step0v5.version },
        { id: step1v1.id, version: step1v1.version },
      ],
      groups: [],
    };

    const release12 = buildScriptPublishBody({
      flow: enFlowBase,
      steps: [step0v5, step1v1],
      version: "12",
      assets: [
        { path: "assets/2b58dbca-864e-4b86-b25b-1644cf515fd9.png", sha256: "a".repeat(64), kind: "target" },
        { path: "assets/eb8d0bd4-7f84-46d2-b350-8faea1cf25be.png", sha256: "b".repeat(64), kind: "target" },
      ],
    });
    const release12Frozen = structuredClone(release12);

    // 2. Seed VI Variant (must remain completely unchanged)
    const viFlow: Flow = {
      id: "00c6ca04-3d37-4dbf-a4a3-5fc83e9b17a5",
      name: "create post wp",
      zoom: 1,
      actionTagKey: "maytuicanvas.create_post",
      variables: [{ id: "b031151e-24e0-433c-a604-a94e4b597e73", key: "title", type: "text" }],
      defaultPattern: { values: { "b031151e-24e0-433c-a604-a94e4b597e73": "Tiêu đề mẫu" } },
      steps: [{ id: "a539bbf5-6ece-47d7-9f2e-1333fd151476", version: 5 }],
      groups: [],
    };
    const viStep: Step = {
      id: "a539bbf5-6ece-47d7-9f2e-1333fd151476",
      version: 5,
      name: "Ttitle",
      createdAt: new Date().toISOString(),
      payload: {
        action: "CLICK_AND_TYPE",
        variableId: "b031151e-24e0-433c-a604-a94e4b597e73",
        inputMethod: "keyboard",
        method: "auto",
        threshold: 0.96,
        timeoutMs: 3000,
        target: {
          asset: "18690ccb-86bf-4f5d-898a-565d1c23de3b.png",
          roi: { x: 181, y: 454, width: 512, height: 41 },
          ocr: {
            text: "Thêm tiêu đề",
            bbox: { x: 11, y: 11, width: 128, height: 19 },
            confidence: 96,
            kind: "line",
            language: "vie+eng",
            confirmed: true,
          },
          matchTo: "top",
        },
      },
    };
    const viReleaseBefore = buildScriptPublishBody({ flow: viFlow, steps: [viStep], version: "12" });

    // 3. Author new Step 0 version (v2 in in-memory store) with interior template + matchTo: "none"
    const step0vNext = store.saveStep(
      "Add title",
      {
        ...v5Payload,
        target: {
          asset: "11111111-1111-4111-8111-111111111111.png",
          roi: { x: 187, y: 461, width: 100, height: 29 },
          environment: { width: 1024, height: 560, zoom: 1 },
          matchTo: "none",
        },
      },
      step0v5.id,
    );

    const enFlowNext: Flow = {
      ...enFlowBase,
      steps: [
        { id: step0vNext.id, version: step0vNext.version },
        { id: step1v1.id, version: step1v1.version },
      ],
    };

    const nextVersion = nextPublishedScriptVersion("12");
    assert.equal(nextVersion, "13");

    const snapshot13 = buildScriptCatalogSnapshot({
      flow: enFlowNext,
      steps: [step0vNext, step1v1],
      version: nextVersion,
      assets: [
        { path: "assets/11111111-1111-4111-8111-111111111111.png", sha256: "c".repeat(64), kind: "target" },
        { path: "assets/eb8d0bd4-7f84-46d2-b350-8faea1cf25be.png", sha256: "b".repeat(64), kind: "target" },
      ],
    });
    assert.equal(snapshot13.incomplete, false);
    assert.deepEqual(snapshot13.health_warnings, []);
    assert.ok(snapshot13.publish_body);

    const release13 = assertScriptPublishBody(snapshot13.publish_body!);
    assert.equal(release13.version, "13");
    assert.equal(release13.action_tag_key, "maytuicanvas.create_post");
    assert.equal(release13.manifest.steps[0].variableId, enVarId);
    assert.equal(release13.manifest.steps[0].variable_key, "title");
    assert.equal(release13.manifest.default_pattern?.values[enVarId], "Sample Maytuicanvas Title");
    assert.equal(release13.content_digest, computeScriptContentDigest(release13));
    assert.equal(snapshot13.execution_digest, computeExecutionDigest(release13.manifest));

    // Verify Release 12 was not mutated and has a distinct digest
    assert.deepEqual(release12, release12Frozen);
    assert.notEqual(release13.content_digest, release12.content_digest);

    // Verify VI variant remains identical
    const viReleaseAfter = buildScriptPublishBody({ flow: viFlow, steps: [viStep], version: "12" });
    assert.equal(viReleaseAfter.content_digest, viReleaseBefore.content_digest);
  } finally {
    store.close();
  }
});
