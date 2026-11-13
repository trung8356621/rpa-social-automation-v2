/**
 * Offline Phase A verification: re-match saved Anh Tho templates against saved frames
 * using the same clustering / early-stop rules (no live BrowserCore required).
 *
 * Usage: npx tsx scripts/verify-post-detail-action-row-offline.mjs
 *   or:  node --experimental-strip-types ... (prefer tsx via package)
 */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const project = process.cwd();
const runId = process.argv[2] || "pd_20261112T092528Z_42o7d5";
const runDir = path.join(project, "scratch", "post-detail-runs", runId);
const outDir = path.join(project, "scratch", "post-detail-action-row-verify");

async function pngToRgba(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Pure NCC (same math as TemplateMatcher.pureJs grayscale) — Node-side. */
function matchNcc(tpl, target, threshold) {
  const tw = tpl.width;
  const th = tpl.height;
  const sw = target.width;
  const sh = target.height;
  const count = tw * th;
  let tsum = 0;
  for (let i = 0; i < tpl.data.length; i += 4) tsum += tpl.data[i];
  const tm = tsum / count;
  let tv = 0;
  for (let i = 0; i < tpl.data.length; i += 4) tv += (tpl.data[i] - tm) ** 2;
  const ts = Math.sqrt(tv) || 1;
  const raw = [];
  for (let sy = 0; sy <= sh - th; sy++) {
    for (let sx = 0; sx <= sw - tw; sx++) {
      let sum = 0;
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) sum += target.data[((sy + y) * sw + sx + x) * 4];
      }
      const sm = sum / count;
      let num = 0;
      let sv = 0;
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          const td = tpl.data[(y * tw + x) * 4] - tm;
          const sd = target.data[((sy + y) * sw + sx + x) * 4] - sm;
          num += td * sd;
          sv += sd * sd;
        }
      }
      const score = num / (ts * (Math.sqrt(sv) || 1));
      if (score >= threshold) raw.push({ x: sx, y: sy, score });
    }
  }
  raw.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const cur of raw) {
    let overlaps = false;
    for (const item of kept) {
      const iw = Math.max(0, Math.min(cur.x + tw, item.x + tw) - Math.max(cur.x, item.x));
      const ih = Math.max(0, Math.min(cur.y + th, item.y + th) - Math.max(cur.y, item.y));
      if ((iw * ih) / (2 * tw * th - iw * ih) > 0.35) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) {
      kept.push(cur);
      if (kept.length >= 5) break;
    }
  }
  return kept.map((m) => ({
    bbox: { x: m.x, y: m.y, width: tw, height: th },
    score: Math.round(m.score * 1000) / 1000,
  }));
}

async function main() {
  const { clusterActionRows, shouldStopForActionRow } = await import(
    "../dist/shared/post-detail-collector/action-row.js"
  );
  const { detectPostDetailContainer } = await import(
    "../dist/shared/post-detail-collector/auto-scan.js"
  );

  const manifest = JSON.parse(await readFile(path.join(runDir, "auto-scan-manifest.json"), "utf8"));
  const templates = [];
  for (const ref of manifest.visualReferences) {
    const buf = await readFile(path.join(runDir, ref.templatePath));
    const rgba = await pngToRgba(buf);
    templates.push({ ...ref, rgba });
  }

  const frameDirs = (await readdir(path.join(runDir, "frames")))
    .filter((n) => n.startsWith("frame-"))
    .sort();
  const frames = [];
  let bestStop = null;

  for (const name of frameDirs) {
    const meta = JSON.parse(await readFile(path.join(runDir, "frames", name, "meta.json"), "utf8"));
    const shot = await readFile(path.join(runDir, "frames", name, "screenshot.png"));
    const target = await pngToRgba(shot);
    const anchors = [];
    const candidates = [];
    const matchLogs = [];
    for (const tpl of templates) {
      const type = /like/i.test(tpl.label)
        ? "LIKE"
        : /comment/i.test(tpl.label)
          ? "COMMENT"
          : /share/i.test(tpl.label)
            ? "SHARE"
            : null;
      if (!type) continue;
      const hits = matchNcc(tpl.rgba, target, 0.55);
      if (!hits.length) {
        matchLogs.push({ type, score: 0, accepted: false });
        continue;
      }
      hits.forEach((h, rank) => {
        const entry = {
          type,
          frameId: meta.frameId,
          frameIndex: meta.frameIndex,
          bbox: h.bbox,
          score: h.score,
          templateId: tpl.sampleId,
          candidateRank: rank,
        };
        candidates.push(entry);
        if (rank === 0) anchors.push(entry);
        matchLogs.push({ type, score: h.score, accepted: rank === 0, bbox: h.bbox });
      });
    }
    const clusters = clusterActionRows(anchors, candidates);
    const frame = {
      frameId: meta.frameId,
      frameIndex: meta.frameIndex,
      scrollDeltaApplied: meta.scrollDeltaApplied,
      observedScrollPx: meta.observedScrollPx,
      width: meta.width,
      height: meta.height,
      anchors,
      anchorCandidates: candidates,
      notes: [`offline-ncc clusters=${clusters.length}`],
    };
    frames.push(frame);
    if (!bestStop && clusters[0] && shouldStopForActionRow(clusters[0])) {
      bestStop = {
        frameIndex: meta.frameIndex,
        frameId: meta.frameId,
        cluster: {
          types: clusters[0].types,
          meanScore: clusters[0].meanScore,
          strength: clusters[0].strength,
          orderOk: clusters[0].orderOk,
          bbox: clusters[0].bbox,
        },
        matchLogs,
      };
    }
  }

  const container = detectPostDetailContainer({
    runId: `${runId}_offline`,
    sourceUrl: manifest.sourceUrl,
    frames,
    wheelPoint: manifest.scrollMetadata.wheelPoint,
    deltaY: manifest.scrollMetadata.deltaY,
    settleMs: manifest.scrollMetadata.settleMs,
    maxFrames: manifest.scrollMetadata.maxFrames,
    stoppedReason: bestStop ? "MAIN_ACTION_ROW_CANDIDATE" : "max-frames",
    requestedScrollPx: manifest.scrollMetadata.requestedScrollPx,
    observedScrollPx: manifest.scrollMetadata.observedScrollPx,
  });

  const report = {
    kind: "post-detail-action-row-offline",
    sourceRunId: runId,
    createdAt: new Date().toISOString(),
    firstMainActionRow: bestStop,
    mainActionRow: container.mainActionRow,
    containerStatus: container.status,
    containerBounds: container.containerBounds,
    notes: container.notes,
    phaseA:
      container.mainActionRow?.status === "MAIN_ACTION_ROW_CANDIDATE" || bestStop
        ? "PASS"
        : "FAIL",
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.phaseA === "PASS" ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
