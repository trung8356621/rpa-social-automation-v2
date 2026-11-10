import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { clusterMatches } from "../src/renderer/experiments/visual-match-lab/MultiItemRecognition";
import { classifyLiveCandidate, type LiveCandidate } from "../src/renderer/experiments/visual-match-lab/LiveScrollTest";

const read = (path: string) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Visual Match Lab is a standalone Creator sidebar page, not Script Test Lab", () => {
  const shell = read("src/renderer/app-shell.tsx"), renderer = read("src/renderer/main.tsx"), contracts = read("src/shared/contracts.ts"), vite = read("vite.config.ts");
  assert.match(shell, /page: "visual-match-lab", label: "Visual Match Lab"/);
  assert.match(renderer, /appPage === "visual-match-lab" && <VisualMatchLabPage/);
  assert.match(contracts, /"test-lab" \| "visual-match-lab"/);
  assert.match(vite, /dedupe: \["react", "react-dom"\]/);
});

test("Lab runtime holds the existing BrowserCore and enforces webContents identity and freshness", () => {
  const runtime = read("src/main/visual-match-lab.ts");
  assert.match(runtime, /private readonly browser: BrowserCore/);
  assert.match(runtime, /webContentsId: wc\.id/);
  assert.match(runtime, /STALE_OR_WRONG_BROWSER_INSTANCE/);
  assert.match(runtime, /STALE_VIEWPORT/);
  assert.doesNotMatch(runtime, /new BrowserCore|cookies|partition|createServer/);
});

test("Lab page retains Stage E controls and contains no public-action click command", () => {
  const page = read("src/renderer/experiments/visual-match-lab/VisualMatchLabPage.tsx"), original = read("experiments/visual-match-lab/src/App.tsx");
  for (const label of ["Template:", "Run Visual Match"]) assert.match(original, new RegExp(label));
  for (const label of ["Highlight DOM", "Inspect Parent", "DOM Verification"]) assert.match(page, new RegExp(label));
  assert.doesNotMatch(page, /visualMatchLabClick|sendInputEvent|testClick/i);
});

test("multi-item grouping uses geometry and never merges rows with duplicate OCR values", () => {
  const match = (id: string, x: number, y: number) => ({ id, bbox: { x, y, width: 20, height: 20 }, score: 0.9, method: "grayscale" as const, isBest: false });
  const groups = clusterMatches(
    [match("a", 20, 100), match("b", 100, 100), match("c", 180, 100), match("d", 20, 300), match("e", 100, 300), match("f", 180, 300)],
    { text: "90 90", confidence: 90, language: "vie+eng", segments: [
      { id: "1", text: "90", bbox: { x: 220, y: 100, width: 20, height: 12 }, confidence: 91 },
      { id: "2", text: "90", bbox: { x: 220, y: 300, width: 20, height: 12 }, confidence: 92 },
    ] },
  );
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.ocrValues[0]?.value), ["90", "90"]);
});

test("live scroll classification deduplicates overlap geometry and excludes comment actions", () => {
  const seen = [{ docY: 900, fingerprint: "0".repeat(64) }] as LiveCandidate[];
  assert.equal(classifyLiveCandidate("post", 3, 920, "0".repeat(64), seen), "DUPLICATE");
  assert.equal(classifyLiveCandidate("post", 3, 1200, "0".repeat(64), seen), "NEW_ITEM");
  assert.equal(classifyLiveCandidate("comment", 3, 1200, "1".repeat(64), seen), "COMMENT_ACTION");
  assert.equal(classifyLiveCandidate("unknown", 3, 1200, "1".repeat(64), seen), "NEEDS_ATTENTION");
});

test("live scroll POC is bounded, overlap-aware, and never sends public actions", () => {
  const source = read("src/renderer/experiments/visual-match-lab/LiveScrollTest.tsx");
  assert.match(source, /frame <= 10/);
  assert.match(source, /viewport\.height \* 0\.65/);
  assert.match(source, /PARTIAL PASS/);
  assert.match(source, /BROWSER_INSTANCE_CHANGED/);
  assert.match(source, /TEMPLATE_NOT_READY/);
  assert.doesNotMatch(source, /if \(templateError\) throw/);
  assert.doesNotMatch(source, /sendInputEvent|visualMatchLabClick|Test Click/i);
});

test("original and live workflows share Stage A-D and expose template readiness", () => {
  const original = read("experiments/visual-match-lab/src/App.tsx");
  const live = read("src/renderer/experiments/visual-match-lab/LiveScrollTest.tsx");
  const engine = read("experiments/visual-match-lab/src/cv/recognition-pipeline.ts");
  assert.match(original, /runRecognitionPipeline\(fixture\)/);
  assert.match(live, /runRecognitionPipeline\(fixture\)/);
  assert.match(live, /TEMPLATE_NOT_READY/);
  for (const stage of ["ImageProcessor", "CandidateClassifier", "GroupRecognizer"]) assert.match(engine, new RegExp(stage));
});

test("live Facebook templates are confirmed crops and saved frames can rerun Stage E", () => {
  const live = read("src/renderer/experiments/visual-match-lab/LiveScrollTest.tsx");
  const calibration = read("src/renderer/experiments/visual-match-lab/LiveTemplateCalibration.tsx");
  assert.match(live, /Re-run Stage E on Existing Frames|rerunExisting/);
  assert.match(live, /visual_match_lab_live_frames_v1/);
  assert.match(calibration, /visual_match_lab_live_templates_v1/);
  for (const icon of ["like", "comment", "share"]) assert.match(calibration, new RegExp(icon));
  assert.match(calibration, /drawImage\(image, rect\.x, rect\.y/);
});
