/**
 * Electron runtime: prove Post Detail wheel delivery moves nested scroll content.
 * 1) Local modal fixture (deterministic) — mouseMove + signed wheel + visual MAD.
 * 2) Optional live Anh Tho URL using Default partition cookies in .local/creator.
 *
 * Usage: npm run build && electron scripts/verify-post-detail-wheel-runtime.mjs
 * Optional: POST_DETAIL_LIVE=1 to attempt Facebook fixture.
 */
import { app, BrowserWindow } from "electron";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(__dirname, "..");
const outDir = path.join(project, "scratch", "post-detail-wheel-runtime");
const ANH_THO =
  "https://www.facebook.com/groups/seovamarketing/posts/29327016206983816/";

// Share Default session cookies with the Creator app.
app.setPath("userData", path.join(project, ".local", "creator"));
app.setPath("sessionData", path.join(project, ".local", "creator", "chromium"));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pngMad(prevBuf, nextBuf, roi) {
  const prev = await sharp(prevBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const next = await sharp(nextBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = Math.min(prev.info.width, next.info.width);
  const h = Math.min(prev.info.height, next.info.height);
  const x0 = Math.max(0, roi.x);
  const y0 = Math.max(0, roi.y);
  const x1 = Math.min(w, x0 + roi.width);
  const y1 = Math.min(h, y0 + roi.height);
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * prev.info.width + x) * 4;
      const j = (y * next.info.width + x) * 4;
      const lp = 0.299 * prev.data[i] + 0.587 * prev.data[i + 1] + 0.114 * prev.data[i + 2];
      const ln = 0.299 * next.data[j] + 0.587 * next.data[j + 1] + 0.114 * next.data[j + 2];
      sum += Math.abs(lp - ln);
      count += 1;
    }
  }
  return count ? sum / count : 0;
}

async function capturePng(browser) {
  const cap = await browser.capture({ requireCanonical: false });
  const buf = browser.captureBuffer(cap.id);
  return { cap, buf };
}

app.whenReady().then(async () => {
  const report = {
    kind: "post-detail-wheel-runtime",
    createdAt: new Date().toISOString(),
    fixture: null,
    live: null,
  };
  await mkdir(outDir, { recursive: true });

  const { BrowserCore } = await import("../dist/main/browser-core.js");
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const browser = new BrowserCore(win, outDir, "persist:creator-default");
  Object.assign(browser.bounds, { x: 40, y: 40, width: 1024, height: 560 });
  browser.view.setBounds(browser.bounds);
  browser.setVisible(true);

  // --- 1) Nested modal fixture (Facebook-like scroll container) ---
  const fixtureHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#0b0f14;overflow:hidden;font-family:sans-serif}
    .backdrop{position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center}
    .modal{width:680px;height:520px;background:#fff;border-radius:12px;overflow:auto;box-shadow:0 8px 40px rgba(0,0,0,.45)}
    .block{height:160px;margin:12px;padding:16px;border-left:6px solid #1877f2;color:#111;font-size:28px;font-weight:700}
  </style></head><body>
  <div class="backdrop"><div class="modal" id="modal">
    ${Array.from({ length: 18 }, (_, i) => {
      const hue = (i * 47) % 360;
      return `<div class="block" id="b${i}" style="background:hsl(${hue} 70% 78%)">Modal block ${i + 1} · MARK-${i}</div>`;
    }).join("")}
  </div></div>
  <script>
    window.__scrollProbe = () => {
      const el = document.getElementById('modal');
      return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    };
  </script>
  </body></html>`;

  await browser.view.webContents.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(fixtureHtml)}`,
  );
  await sleep(400);
  win.focus();
  browser.view.webContents.focus();
  await sleep(80);

  const beforeProbe = await browser.view.webContents.executeJavaScript(`window.__scrollProbe()`);
  const before = await capturePng(browser);
  await writeFile(path.join(outDir, "fixture-before.png"), before.buf);

  const point = { x: 512, y: 280 };
  // Same signed convention as BrowserCore self-test / Auto Scan defaults.
  browser.scroll(-280, point);
  await sleep(550);

  const afterProbe = await browser.view.webContents.executeJavaScript(`window.__scrollProbe()`);
  const after = await capturePng(browser);
  await writeFile(path.join(outDir, "fixture-after.png"), after.buf);

  const motion = await pngMad(before.buf, after.buf, {
    x: Math.round(1024 * 0.22),
    y: Math.round(560 * 0.12),
    width: Math.round(1024 * 0.56),
    height: Math.round(560 * 0.7),
  });
  const scrollDelta = (afterProbe.scrollTop || 0) - (beforeProbe.scrollTop || 0);
  const visualOk = motion >= 6.5;
  const fixtureOk = scrollDelta > 20 && visualOk;
  report.fixture = {
    ok: fixtureOk,
    wheelPoint: point,
    requestedDeltaY: -280,
    scrollTopBefore: beforeProbe.scrollTop,
    scrollTopAfter: afterProbe.scrollTop,
    observedScrollTopDelta: scrollDelta,
    visualMotionScore: Math.round(motion * 1000) / 1000,
    outcome: fixtureOk
      ? "VISUAL_SCROLL_CONFIRMED"
      : scrollDelta > 20
        ? "SCROLL_TOP_MOVED_BUT_LOW_MAD"
        : "SCROLL_NOT_MOVING",
  };
  console.log("[fixture]", JSON.stringify(report.fixture, null, 2));

  // --- 2) Live Anh Tho (optional / best-effort with Default cookies) ---
  if (process.env.POST_DETAIL_LIVE === "1") {
    try {
      await browser.navigate(ANH_THO);
      await sleep(5000);
      win.focus();
      browser.view.webContents.focus();
      await sleep(100);
      const url = browser.view.webContents.getURL();
      const liveBefore = await capturePng(browser);
      await writeFile(path.join(outDir, "live-before.png"), liveBefore.buf);
      browser.scroll(-280, point);
      await sleep(700);
      const liveAfter = await capturePng(browser);
      await writeFile(path.join(outDir, "live-after.png"), liveAfter.buf);
      const liveMotion = await pngMad(liveBefore.buf, liveAfter.buf, {
        x: Math.round(liveBefore.cap.width * 0.22),
        y: Math.round(liveBefore.cap.height * 0.12),
        width: Math.round(liveBefore.cap.width * 0.56),
        height: Math.round(liveBefore.cap.height * 0.7),
      });
      report.live = {
        ok: liveMotion >= 6.5,
        url,
        requestedDeltaY: -280,
        visualMotionScore: Math.round(liveMotion * 1000) / 1000,
        outcome: liveMotion >= 6.5 ? "VISUAL_SCROLL_CONFIRMED" : "SCROLL_NOT_MOVING_OR_LOGIN",
      };
      console.log("[live]", JSON.stringify(report.live, null, 2));
    } catch (error) {
      report.live = { ok: false, error: String(error) };
      console.error("[live] failed", error);
    }
  } else {
    report.live = { skipped: true, hint: "Set POST_DETAIL_LIVE=1 to attempt Anh Tho with Default cookies" };
  }

  await writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("Wrote", path.join(outDir, "report.json"));
  app.exit(fixtureOk ? 0 : 1);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
