import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const db = new DatabaseSync(path.join(root, ".local/creator/creator.sqlite"), {
  readOnly: true,
});

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("tables", tables.map((t) => t.name));

function dumpStep(idPrefix) {
  for (const table of tables.map((t) => t.name)) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.includes("id")) continue;
      const row = db.prepare(`SELECT * FROM ${table} WHERE id LIKE ? LIMIT 1`).get(`${idPrefix}%`);
      if (row) return { table, cols, row };
    } catch {
      /* ignore */
    }
  }
  return null;
}

const password = dumpStep("1e7c2ad4");
const username = dumpStep("04c801be");
for (const hit of [username, password]) {
  if (!hit) continue;
  const payloadRaw =
    hit.row.payload_json || hit.row.payload || hit.row.body || hit.row.data;
  let payload = payloadRaw;
  if (typeof payloadRaw === "string") {
    try {
      payload = JSON.parse(payloadRaw);
    } catch {
      payload = payloadRaw;
    }
  }
  const target = payload?.target || {};
  console.log(
    JSON.stringify(
      {
        table: hit.table,
        id: hit.row.id,
        name: hit.row.name,
        version: hit.row.version,
        action: payload?.action,
        matchTo: target.matchTo,
        roi: target.roi,
        environment: target.environment,
        clickOffset: target.clickOffset,
        asset: target.asset,
        ocr: target.ocr
          ? {
              text: target.ocr.text,
              kind: target.ocr.kind,
              bbox: target.ocr.bbox,
              confidence: target.ocr.confidence,
              confirmed: target.ocr.confirmed,
            }
          : null,
        typedLen: typeof payload?.text === "string" ? payload.text.length : null,
      },
      null,
      2,
    ),
  );
}

const { findOcrCandidates } = await import(
  pathToFileURL(path.join(root, "dist/main/ocr-candidates.js")).href
);
const { resolveVisualTarget } = await import(
  pathToFileURL(path.join(root, "dist/main/target-resolver.js")).href
);

// Prefer real OCR if available; fall back to logged segments from the failed run.
let recognize;
try {
  const ocrMod = await import(pathToFileURL(path.join(root, "dist/main/ocr.js")).href);
  if (typeof ocrMod.recognizeImage === "function") {
    recognize = (buf) => ocrMod.recognizeImage(buf, "vie+eng");
  } else if (typeof ocrMod.recognize === "function") {
    recognize = (buf) => ocrMod.recognize(buf, "vie+eng");
  }
} catch (error) {
  console.log("ocr module load failed", String(error?.message || error));
}

const capturePath = path.join(
  root,
  ".local/creator/captures/e1ed868b-2ace-41a8-849a-8e90338bc937.png",
);
const frame = fs.readFileSync(capturePath);

const selection = {
  text: "Password",
  kind: "word",
  bbox: { x: 2, y: 3, width: 56, height: 11 },
  confidence: 92,
  confirmed: true,
  language: "vie+eng",
};

const loggedLive = {
  text: "Password\nLost your password?",
  confidence: 92,
  language: "vie+eng",
  segments: [
    {
      id: "13",
      text: "Password",
      kind: "line",
      confidence: 92,
      bbox: { x: 371, y: 333, width: 56, height: 11 },
    },
    {
      id: "14",
      text: "Password",
      kind: "word",
      confidence: 92,
      bbox: { x: 371, y: 333, width: 56, height: 11 },
    },
    {
      id: "24",
      text: "Lost your password?",
      kind: "line",
      confidence: 95,
      bbox: { x: 370, y: 492, width: 115, height: 15 },
    },
    {
      id: "27",
      text: "password?",
      kind: "word",
      confidence: 95,
      bbox: { x: 426, y: 492, width: 59, height: 15 },
    },
  ],
};

const beforeCandidates = [
  loggedLive.segments[1],
  loggedLive.segments[3],
];
console.log(
  "before_refine_candidates",
  beforeCandidates.map((c) => ({
    text: c.text,
    conf: c.confidence,
    bbox: c.bbox,
    center: { x: c.bbox.x + c.bbox.width / 2, y: c.bbox.y + c.bbox.height / 2 },
  })),
);
const after = findOcrCandidates(loggedLive, selection);
console.log(
  "after_refine_candidates",
  after.map((c) => ({
    text: c.text,
    conf: c.confidence,
    bbox: c.bbox,
    center: { x: c.bbox.x + c.bbox.width / 2, y: c.bbox.y + c.bbox.height / 2 },
  })),
);

let asset = password?.row
  ? (() => {
      const payload = JSON.parse(password.row.payload_json || password.row.payload || "{}");
      return payload?.target?.asset;
    })()
  : null;

const assetCandidates = [
  asset && path.join(root, ".local/creator/targets", asset),
  asset && path.join(root, ".local/creator/assets", asset),
  path.join(root, ".local/creator/targets"),
].filter(Boolean);

let templateBuf = null;
let templatePath = null;
if (asset) {
  for (const candidate of [
    path.join(root, ".local/creator/targets", asset),
    path.join(root, ".local/creator/assets", asset),
    path.join(root, "assets", asset),
  ]) {
    if (fs.existsSync(candidate)) {
      templateBuf = fs.readFileSync(candidate);
      templatePath = candidate;
      break;
    }
  }
}
if (!templateBuf) {
  // Minimal crop proxy matching saved ROI size.
  const sharp = (await import("sharp")).default;
  templateBuf = await sharp({
    create: { width: 273, height: 61, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  templatePath = "(synthetic-roi)";
}

const payload = {
  action: "CLICK_AND_TYPE",
  text: "fixture_pass",
  inputMethod: "keyboard",
  target: {
    asset: asset || "password.png",
    roi: { x: 369, y: 257, width: 273, height: 61 },
    environment: { width: 1024, height: 560, zoom: 1 },
    matchTo: "middle",
    ocr: selection,
    clickOffset: { x: 0, y: 0 },
  },
};

const resolvedLogged = await resolveVisualTarget(
  frame,
  templateBuf,
  payload,
  {
    recognize: async (input) =>
      input === templateBuf
        ? {
            text: "Password",
            confidence: 92,
            language: "vie+eng",
            segments: [
              {
                id: "t",
                text: "Password",
                kind: "word",
                confidence: 92,
                bbox: { x: 2, y: 3, width: 56, height: 11 },
              },
            ],
          }
        : loggedLive,
  },
  { x: 0, y: 0, width: 1024, height: 560 },
);

console.log(
  "resolve_logged_ocr",
  JSON.stringify(
    {
      method: resolvedLogged.method,
      x: resolvedLogged.x,
      y: resolvedLogged.y,
      attempts: resolvedLogged.resolution.attempts,
      context: resolvedLogged.resolution.context,
      templatePath,
    },
    null,
    2,
  ),
);

// Username then Password order using logged Username capture segments from Play All.
const usernameCapture = path.join(
  root,
  ".local/creator/captures/74585ff7-9360-448b-b2c4-2d0dd741e100.png",
);
const usernameSelection = {
  text: "Username or Email Address",
  kind: "line",
  bbox: { x: 67, y: 138, width: 168, height: 11 },
  confidence: 90,
  confirmed: true,
  language: "vie+eng",
};
const usernameLive = {
  text: "Username or Email Address\nPassword\nLost your password?",
  confidence: 93,
  language: "vie+eng",
  segments: [
    {
      id: "6",
      text: "Username or Email Address",
      kind: "line",
      confidence: 90,
      bbox: { x: 371, y: 264, width: 168, height: 11 },
    },
    {
      id: "14",
      text: "Password",
      kind: "word",
      confidence: 92,
      bbox: { x: 371, y: 333, width: 56, height: 11 },
    },
    {
      id: "27",
      text: "password?",
      kind: "word",
      confidence: 95,
      bbox: { x: 426, y: 492, width: 59, height: 15 },
    },
  ],
};

if (fs.existsSync(usernameCapture)) {
  const userFrame = fs.readFileSync(usernameCapture);
  const userTemplate = await (
    await import("sharp")
  ).default({
    create: { width: 402, height: 190, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  const userResolved = await resolveVisualTarget(
    userFrame,
    userTemplate,
    {
      action: "CLICK_AND_TYPE",
      text: "fixture_user",
      inputMethod: "keyboard",
      target: {
        asset: "username.png",
        roi: { x: 304, y: 126, width: 402, height: 190 },
        environment: { width: 1024, height: 560, zoom: 1 },
        matchTo: "none",
        ocr: usernameSelection,
        clickOffset: { x: 0, y: 0 },
      },
    },
    {
      recognize: async (input) =>
        input === userTemplate
          ? {
              text: usernameSelection.text,
              confidence: 90,
              language: "vie+eng",
              segments: [
                {
                  id: "t",
                  text: usernameSelection.text,
                  kind: "line",
                  confidence: 90,
                  bbox: usernameSelection.bbox,
                },
              ],
            }
          : usernameLive,
    },
    { x: 0, y: 0, width: 1024, height: 560 },
  );
  console.log(
    "username_then_password_order",
    JSON.stringify(
      {
        username: {
          method: userResolved.method,
          x: userResolved.x,
          y: userResolved.y,
          matchedAttempts: userResolved.resolution.attempts.filter(
            (a) => a.outcome === "matched",
          ).length,
        },
        password: {
          method: resolvedLogged.method,
          x: resolvedLogged.x,
          y: resolvedLogged.y,
          matchedAttempts: resolvedLogged.resolution.attempts.filter(
            (a) => a.outcome === "matched",
          ).length,
          text: after[0]?.text,
        },
      },
      null,
      2,
    ),
  );
}

if (recognize) {
  try {
    const liveOcr = await recognize(frame);
    const liveCandidates = findOcrCandidates(liveOcr, selection);
    console.log(
      "live_ocr_password_candidates",
      liveCandidates.map((c) => ({
        text: c.text,
        conf: c.confidence,
        bbox: c.bbox,
      })),
    );
  } catch (error) {
    console.log("live_ocr_failed", String(error?.message || error));
  }
}
