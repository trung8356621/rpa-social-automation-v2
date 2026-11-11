import path from "node:path";
import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import type { BrowserCore } from "./browser-core.js";
import type { SavedRunSummaryItem } from "../shared/contracts.js";
import {
  buildBoundaryProbeScript,
  buildRemoveBoundaryHighlightsScript,
  type BoundaryProbeResult,
  type BoundaryDebugReport,
  type BoundaryDebugRecord,
} from "../shared/boundary-probe.js";

type Point = { x: number; y: number };
type Snapshot = { webContentsId: number; url: string; scrollX: number; scrollY: number };

function inspectScript(point: Point, parent: boolean) {
  return `(() => {
    let el = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
    if (${parent} && el) el = el.parentElement;
    if (!el) return null;
    const clickable = el.closest('button,a,[role="button"],[role="link"],input,[tabindex]');
    const article = el.closest('[role="article"],article');
    const nestedArticle = article?.parentElement?.closest('[role="article"],article');
    const comment = el.closest('[aria-label*="comment" i],[aria-label*="bình luận" i],[data-ad-rendering-role="comment"]');
    const rect = el.getBoundingClientRect(); const cr = clickable?.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), ariaLabel: el.getAttribute('aria-label') || '',
      text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      clickable: clickable ? { tag: clickable.tagName.toLowerCase(), role: clickable.getAttribute('role'), ariaLabel: (clickable.getAttribute('aria-label') || clickable.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240), rect: { x: cr.x, y: cr.y, width: cr.width, height: cr.height } } : null,
      context: comment || nestedArticle ? 'comment' : article ? 'post' : 'unknown'
    };
  })()`;
}

export class VisualMatchLabRuntime {
  private captures = new Map<string, Snapshot>();
  constructor(
    private readonly browser: BrowserCore,
    private readonly withVisibleBrowser: <T>(operation: () => Promise<T>) => Promise<T>,
    private readonly projectDir: string = process.cwd(),
  ) {}

  private async facebook() {
    const wc = this.browser.view.webContents;
    const url = wc.getURL();
    const isFb = /^https:\/\/(?:www\.)?facebook\.com\//i.test(url);
    const isThreads = /^https:\/\/(?:www\.)?threads\.(?:net|com)\//i.test(url);
    if (!isFb && !isThreads) throw new Error("BROWSER_NOT_FACEBOOK: Mở Facebook hoặc Threads trong BrowserCore của Creator V2 trước.");
    const loggedIn = await wc.executeJavaScript(`(() => {
      if (/(?:threads\\.net|threads\\.com)/i.test(location.hostname)) return true;
      return Boolean(
        document.querySelector('[role="navigation"],[role="feed"],[aria-label*="Account" i],[aria-label*="Tài khoản" i]') &&
        !document.querySelector('input[type="password"],form[action*="login"],input[name="email"]')
      );
    })()`);
    if (!loggedIn) throw new Error("FACEBOOK_NOT_LOGGED_IN: Đăng nhập thủ công trong BrowserCore của Creator V2 trước.");
    return wc;
  }
  async state() {
    const wc = await this.facebook();
    return { connected: true, loggedIn: true, webContentsId: wc.id, url: wc.getURL() };
  }
  async capture() {
    const wc = await this.facebook(); const webContentsId = wc.id;
    const capture = await this.withVisibleBrowser(() => this.browser.capture({ requireCanonical: false }));
    if (this.browser.view.webContents.id !== webContentsId) throw new Error("BROWSER_INSTANCE_CHANGED");
    const viewport = await wc.executeJavaScript(`({width:innerWidth,height:innerHeight,scrollX,scrollY,dpr:devicePixelRatio,url:location.href})`);
    this.captures.clear();
    this.captures.set(capture.id, { webContentsId, url: viewport.url, scrollX: viewport.scrollX, scrollY: viewport.scrollY });
    return { ...capture, webContentsId, viewport };
  }
  private async fresh(captureId: string, webContentsId: number) {
    const expected = this.captures.get(captureId); const wc = await this.facebook();
    if (!expected || expected.webContentsId !== webContentsId || wc.id !== webContentsId) throw new Error("STALE_OR_WRONG_BROWSER_INSTANCE");
    const current = await wc.executeJavaScript(`({url:location.href,scrollX,scrollY})`);
    if (current.url !== expected.url || current.scrollX !== expected.scrollX || current.scrollY !== expected.scrollY) { this.captures.clear(); throw new Error("STALE_VIEWPORT: Capture BrowserCore lại sau navigate/scroll."); }
    return wc;
  }
  async inspect(captureId: string, webContentsId: number, point: Point, parent = false) {
    const wc = await this.fresh(captureId, webContentsId);
    return { webContentsId, element: await wc.executeJavaScript(inspectScript(point, parent)) };
  }
  async highlight(captureId: string, webContentsId: number, point: Point) {
    const wc = await this.fresh(captureId, webContentsId);
    const highlighted = await wc.executeJavaScript(`(() => {
      document.querySelectorAll('[data-visual-match-lab-highlight]').forEach(n => n.remove());
      const el = document.elementFromPoint(${Number(point.x)},${Number(point.y)}); if (!el) return false;
      const r=el.getBoundingClientRect(), box=document.createElement('div'); box.dataset.visualMatchLabHighlight='true';
      Object.assign(box.style,{position:'fixed',left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px',border:'3px solid #ef4444',background:'rgba(239,68,68,.12)',zIndex:'2147483647',pointerEvents:'none'});
      document.documentElement.appendChild(box); return true;
    })()`);
    return { webContentsId, highlighted };
  }
  async probeBoundary(
    captureId: string,
    webContentsId: number,
    point: Point,
    actionRowBbox?: { x: number; y: number; width: number; height: number },
    options?: { highlight?: boolean; captureEvidence?: boolean; customRules?: any[] },
  ): Promise<BoundaryProbeResult & { webContentsId: number; evidenceDataUrl?: string }> {
    const wc = await this.fresh(captureId, webContentsId);
    const shouldHighlight = options?.highlight !== false;
    const script = buildBoundaryProbeScript(point, actionRowBbox, {
      highlight: shouldHighlight,
      customRules: options?.customRules,
    });
    const result = (await wc.executeJavaScript(script)) as BoundaryProbeResult;
    let evidenceDataUrl: string | undefined;

    try {
      if (shouldHighlight && options?.captureEvidence !== false) {
        await wc.executeJavaScript(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
        const nativeImg = await wc.capturePage(undefined, { stayHidden: true });
        if (!nativeImg.isEmpty()) {
          evidenceDataUrl = `data:image/png;base64,${nativeImg.toPNG().toString("base64")}`;
        } else {
          const evidence = await this.withVisibleBrowser(() => this.browser.capture({ requireCanonical: false }));
          evidenceDataUrl = evidence.dataUrl;
        }
      }
    } finally {
      if (shouldHighlight) {
        await wc.executeJavaScript(buildRemoveBoundaryHighlightsScript());
      }
    }

    return { ...result, webContentsId, evidenceDataUrl };
  }
  async scroll(webContentsId: number, deltaY: number) {
    const wc = await this.facebook();
    if (wc.id !== webContentsId) throw new Error("WRONG_BROWSER_INSTANCE");
    await wc.executeJavaScript(`scrollBy({top:${Number(deltaY) || 0},behavior:'instant'})`);
    this.captures.clear();
    return { webContentsId, scrolled: true };
  }
  async saveBoundaryDebug(report: BoundaryDebugReport) {
    const scratchDir = path.join(this.projectDir, "scratch");
    await mkdir(scratchDir, { recursive: true });
    const latestPath = path.join(scratchDir, "visual-match-lab-boundary-debug.json");
    const runPath = path.join(scratchDir, `visual-match-lab-boundary-debug-${report.runId}.json`);

    // 1. Save evidence images to separate files on disk to prevent bloating JSON with Base64
    for (const record of report.records) {
      if (record.evidenceScreenshotBase64) {
        const match = /^data:image\/png;base64,(.+)$/.exec(record.evidenceScreenshotBase64);
        if (match) {
          // Per-run filename: shared names were overwritten by every later run, so old
          // runs silently pointed at screenshots of a different feed position.
          const imgPath = path.join(scratchDir, `boundary-evidence-${report.runId}-f${record.frameNumber}-r${record.rowIndex}.png`);
          await writeFile(imgPath, Buffer.from(match[1], "base64")).catch(() => undefined);
          record.evidenceScreenshotSaved = imgPath;
        }
        // Free base64 memory in saved debug JSON artifact
        delete record.evidenceScreenshotBase64;
      }
    }

    // 2. Persist lean JSON debug artifact with image file paths
    const jsonStr = JSON.stringify(report, null, 2);
    await writeFile(latestPath, jsonStr, "utf8");
    await writeFile(runPath, jsonStr, "utf8");

    // 3. Persist structured run structure: runs/{runId}/...
    try {
      const runDir = path.join(scratchDir, "runs", report.runId);
      await mkdir(runDir, { recursive: true });

      const manifest = {
        runId: report.runId,
        timestamp: report.timestamp,
        platform: report.environment.platform,
        totalFrames: report.totalFrames,
        summary: report.summary,
      };
      await writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      await writeFile(path.join(runDir, "summary.json"), JSON.stringify(report.summary, null, 2), "utf8");
      await writeFile(path.join(runDir, "rules-snapshot.json"), JSON.stringify(report.environment, null, 2), "utf8");

      // Group records by frame
      const frameGroups = new Map<number, BoundaryDebugRecord[]>();
      for (const r of report.records) {
        const list = frameGroups.get(r.frameNumber) || [];
        list.push(r);
        frameGroups.set(r.frameNumber, list);
      }

      for (const [frameNum, frameRecords] of frameGroups) {
        const frameDir = path.join(runDir, "frames", String(frameNum).padStart(3, "0"));
        await mkdir(frameDir, { recursive: true });
        await writeFile(path.join(frameDir, "debug.json"), JSON.stringify(frameRecords, null, 2), "utf8");
        for (const rec of frameRecords) {
          if (rec.evidenceScreenshotSaved) {
            const dest = path.join(frameDir, `highlighted-r${rec.rowIndex}.png`);
            await writeFile(dest, await readFile(rec.evidenceScreenshotSaved)).catch(() => undefined);
          }
        }
      }
    } catch (err) {
      console.warn("Failed to create structured runs directory:", err);
    }

    return { ok: true, path: latestPath, runPath, recordCount: report.records.length };
  }

  async listRuns(): Promise<SavedRunSummaryItem[]> {
    const scratchDir = path.join(this.projectDir, "scratch");
    const runsDir = path.join(scratchDir, "runs");
    const result: Map<string, SavedRunSummaryItem> = new Map();

    // 1. Read structured runs in scratch/runs/
    try {
      const entries = await readdir(runsDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory()) {
          const runId = ent.name;
          if (runId.startsWith("run_audit_")) continue;
          const manifestPath = path.join(runsDir, runId, "manifest.json");
          try {
            const data = JSON.parse(await readFile(manifestPath, "utf8"));
            result.set(runId, {
              runId,
              timestamp: data.timestamp || new Date().toISOString(),
              platform: data.platform || "facebook",
              totalFrames: data.totalFrames || 0,
              actionRowsDetected: data.summary?.totalProbed || 0,
              boundaryFoundCount: data.summary?.boundaryFoundCount || 0,
              boundaryAmbiguousCount: data.summary?.boundaryAmbiguousCount || 0,
              boundaryNotFoundCount: data.summary?.boundaryNotFoundCount || 0,
              jumpedZeroToTwoPlusCount: data.summary?.jumpedZeroToTwoPlusCount || 0,
              noActionRowCount: Math.max(0, (data.totalFrames || 0) - (data.summary?.totalProbed || 0)),
              source: "structured",
            });
          } catch {}
        }
      }
    } catch {}

    // 2. Read legacy runs from scratch/visual-match-lab-boundary-debug-*.json
    try {
      const files = await readdir(scratchDir);
      for (const file of files) {
        const match = /^visual-match-lab-boundary-debug-(run_[^.]+)\.json$/.exec(file);
        if (match) {
          const runId = match[1];
          if (runId.startsWith("run_audit_")) continue;
          if (!result.has(runId)) {
            try {
              const fullPath = path.join(scratchDir, file);
              const data = JSON.parse(await readFile(fullPath, "utf8"));
              result.set(runId, {
                runId,
                timestamp: data.timestamp || new Date().toISOString(),
                platform: data.environment?.platform || "facebook",
                totalFrames: data.totalFrames || 0,
                actionRowsDetected: data.summary?.totalProbed || 0,
                boundaryFoundCount: data.summary?.boundaryFoundCount || 0,
                boundaryAmbiguousCount: data.summary?.boundaryAmbiguousCount || 0,
                boundaryNotFoundCount: data.summary?.boundaryNotFoundCount || 0,
                jumpedZeroToTwoPlusCount: data.summary?.jumpedZeroToTwoPlusCount || 0,
                noActionRowCount: Math.max(0, (data.totalFrames || 0) - (data.summary?.totalProbed || 0)),
                source: "legacy",
              });
            } catch {}
          }
        }
      }
    } catch {}

    return Array.from(result.values()).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async loadRun(runId: string): Promise<{ ok: boolean; report: BoundaryDebugReport; runId: string }> {
    const scratchDir = path.join(this.projectDir, "scratch");
    const runDir = path.join(scratchDir, "runs", runId);
    let report: BoundaryDebugReport | null = null;

    // Check structured run first
    try {
      const manifestPath = path.join(runDir, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const framesDir = path.join(runDir, "frames");
      const frameEntries = await readdir(framesDir, { withFileTypes: true });
      const records: BoundaryDebugRecord[] = [];
      for (const fe of frameEntries) {
        if (fe.isDirectory()) {
          const debugPath = path.join(framesDir, fe.name, "debug.json");
          try {
            const frameRecords: BoundaryDebugRecord[] = JSON.parse(await readFile(debugPath, "utf8"));
            for (const r of frameRecords) {
              const imgPath = path.join(framesDir, fe.name, `highlighted-r${r.rowIndex}.png`);
              try {
                const imgBuf = await readFile(imgPath);
                r.evidenceScreenshotBase64 = `data:image/png;base64,${imgBuf.toString("base64")}`;
              } catch {}
              records.push(r);
            }
          } catch {}
        }
      }
      report = {
        runId: manifest.runId,
        timestamp: manifest.timestamp,
        environment: { width: 1024, height: 560, zoom: 1, platform: manifest.platform || "facebook" },
        totalFrames: manifest.totalFrames,
        records,
        summary: manifest.summary,
      };
    } catch {
      // Fallback to legacy file
      const legacyPath = path.join(scratchDir, `visual-match-lab-boundary-debug-${runId}.json`);
      try {
        report = JSON.parse(await readFile(legacyPath, "utf8"));
        if (report) {
          const synthetic = report.runId.startsWith("run_audit_");
          for (const r of report.records) {
            if (r.evidenceScreenshotBase64 && r.evidenceScreenshotBase64.startsWith("data:image/")) {
              continue;
            }
            if (synthetic) continue;
            const candidates: string[] = [];
            if (r.evidenceScreenshotSaved) {
              candidates.push(r.evidenceScreenshotSaved);
              candidates.push(path.join(scratchDir, path.basename(r.evidenceScreenshotSaved)));
            }
            candidates.push(path.join(scratchDir, `boundary-evidence-${report.runId}-f${r.frameNumber}-r${r.rowIndex}.png`));
            candidates.push(path.join(scratchDir, `boundary-evidence-f${r.frameNumber}-r${r.rowIndex}.png`));

            for (const p of candidates) {
              try {
                const imgBuf = await readFile(p);
                r.evidenceScreenshotBase64 = `data:image/png;base64,${imgBuf.toString("base64")}`;
                r.evidenceScreenshotSaved = p;
                break;
              } catch {}
            }
          }
        }
      } catch {}
    }

    if (!report) {
      throw new Error(`RUN_NOT_FOUND: Could not load run ${runId}`);
    }

    return { ok: true, report, runId };
  }
}
