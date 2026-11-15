import assert from "node:assert/strict";
import test from "node:test";
import { auditVisualReferenceRoles, structuredReferenceRole } from "../src/shared/post-detail-collector/visual-reference-role.js";
import type { PostDetailAnchorType, VisualReferenceSample } from "../src/shared/post-detail-collector/types.js";

const ref = (id: string, semanticRole?: PostDetailAnchorType, label = "legacy-name"): VisualReferenceSample => ({ sampleId: id, semanticRole, label, dataUrl: "", width: 20, height: 20, bbox: { x: 0, y: 0, width: 20, height: 20 }, createdAt: "2026-01-01T00:00:00Z" });

test("structured roles never infer legacy role from free-text label", () => {
  assert.equal(structuredReferenceRole(ref("old", undefined, "like")), null);
  const audit = auditVisualReferenceRoles([ref("l", "LIKE"), ref("c", "COMMENT"), ref("s", "SHARE")]);
  assert.equal(audit.valid, true);
});

test("duplicate and legacy roles are detected without discarding references", () => {
  const samples = [ref("l1", "LIKE"), ref("l2", "LIKE"), ref("old", undefined, "share")];
  const audit = auditVisualReferenceRoles(samples);
  assert.deepEqual(audit.duplicates, ["LIKE"]);
  assert.equal(audit.legacy[0]?.sampleId, "old");
  assert.deepEqual(audit.missing, ["COMMENT", "SHARE"]);
  assert.equal(samples.length, 3);
});
