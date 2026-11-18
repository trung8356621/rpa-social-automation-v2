import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const { findOcrCandidates } = await import(
  pathToFileURL(path.join(root, "dist/main/ocr-candidates.js")).href
);
const { resolveVisualTarget } = await import(
  pathToFileURL(path.join(root, "dist/main/target-resolver.js")).href
);
const { localOcr } = await import(
  pathToFileURL(path.join(root, "dist/main/ocr.js")).href
);

const db = new DatabaseSync(path.join(root, ".local/creator/creator.sqlite"), {
  readOnly: true,
});
function step(id, version) {
  const row = db
    .prepare("SELECT payload FROM steps WHERE id = ? AND version = ?")
    .get(id, version);
  return JSON.parse(row.payload);
}
const user = step("04c801be-1933-47aa-bd26-9ff8bd31e5f7", 7);
const pass = step("1e7c2ad4-94ea-4b05-85c3-ef63daca5f86", 6);
const userPayload = { ...user.payload, text: "fixture_user" };
const passPayload = { ...pass.payload, text: "fixture_pass" };

const userCapture = path.join(
  root,
  ".local/creator/captures/74585ff7-9360-448b-b2c4-2d0dd741e100.png",
);
const passCapture = path.join(
  root,
  ".local/creator/captures/e1ed868b-2ace-41a8-849a-8e90338bc937.png",
);
const userAsset = path.join(
  root,
  ".local/creator/targets",
  userPayload.target.asset,
);
const passAsset = path.join(
  root,
  ".local/creator/targets",
  passPayload.target.asset,
);

const userFrame = fs.readFileSync(userCapture);
const passFrame = fs.readFileSync(passCapture);
const userTemplate = fs.existsSync(userAsset)
  ? fs.readFileSync(userAsset)
  : await sharp({
      create: {
        width: userPayload.target.roi.width,
        height: userPayload.target.roi.height,
        channels: 3,
        background: "#fff",
      },
    })
      .png()
      .toBuffer();
const passTemplate = fs.existsSync(passAsset)
  ? fs.readFileSync(passAsset)
  : await sharp({
      create: {
        width: passPayload.target.roi.width,
        height: passPayload.target.roi.height,
        channels: 3,
        background: "#fff",
      },
    })
      .png()
      .toBuffer();

const viewport = { x: 0, y: 0, width: 1024, height: 560 };

console.log("assets", {
  userAssetExists: fs.existsSync(userAsset),
  passAssetExists: fs.existsSync(passAsset),
  passOcr: {
    text: passPayload.target.ocr.text,
    kind: passPayload.target.ocr.kind,
    bbox: passPayload.target.ocr.bbox,
    clickOffset: passPayload.target.clickOffset,
    matchTo: passPayload.target.matchTo,
  },
});

// Real OCR on the failed Password capture.
const recognize = (buf) => localOcr.recognize(buf);
const live = await recognize(passFrame);
const passwordHits = (live.segments || []).filter((s) =>
  /password/i.test(s.text),
);
console.log(
  "live_password_segments",
  passwordHits.map((s) => ({
    text: s.text,
    kind: s.kind,
    conf: s.confidence,
    bbox: s.bbox,
  })),
);
const refined = findOcrCandidates(live, passPayload.target.ocr);
console.log(
  "refined_candidates",
  refined.map((s) => ({
    text: s.text,
    kind: s.kind,
    conf: s.confidence,
    bbox: s.bbox,
  })),
);

const userResolved = await resolveVisualTarget(
  userFrame,
  userTemplate,
  userPayload,
  { recognize },
  viewport,
);
console.log("username_result", {
  method: userResolved.method,
  x: userResolved.x,
  y: userResolved.y,
  matched: userResolved.resolution.attempts.filter((a) => a.outcome === "matched")
    .length,
});

const passResolved = await resolveVisualTarget(
  passFrame,
  passTemplate,
  passPayload,
  { recognize },
  viewport,
);
console.log("password_result", {
  method: passResolved.method,
  x: passResolved.x,
  y: passResolved.y,
  matched: passResolved.resolution.attempts.filter((a) => a.outcome === "matched")
    .length,
  context: passResolved.resolution.context,
});
