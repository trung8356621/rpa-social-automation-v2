import fs from "node:fs";
import path from "node:path";
import { chromium } from "./playwright-runner/node_modules/playwright-core/index.mjs";

const cssPath = path.resolve("src/renderer/experiments/visual-match-lab/visual-match-lab.css");
const css = fs.readFileSync(cssPath, "utf8");

// Load base64 of real evidence image Frame 4
const imgPath = path.resolve("scratch/boundary-evidence-f4-r0.png");
const imgBase64 = fs.existsSync(imgPath)
  ? `data:image/png;base64,${fs.readFileSync(imgPath).toString("base64")}`
  : "";

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Visual Match Lab - Frame Inspector</title>
  <style>
    body {
      margin: 0;
      padding: 20px;
      background: #0b1120;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    ${css}
  </style>
</head>
<body>
  <div class="visual-match-lab-page">
    <div class="live-scroll-test">
      <h2>Live Scroll &amp; Permalink Boundary POC</h2>
      <p style="color: #94a3b8; font-size: 12px; margin-top: 4px;">
        BrowserCore 1024×560 · 65% overlap scroll · maximum 50 frames · OpenCV Action Row → DOM hit-test → parentNode traversal → Permalink Filter → Boundary
      </p>

      <!-- Run Summary Bar -->
      <div class="run-summary-container">
        <div class="live-scroll-summary">
          <div class="summary-stat-card">
            <span class="stat-label">Capture</span>
            <span class="stat-val"><b class="text-green">50 pass</b> / 0 fail</span>
          </div>
          <div class="summary-stat-card">
            <span class="stat-label">Action Rows</span>
            <span class="stat-val">31</span>
          </div>
          <div class="summary-stat-card">
            <span class="stat-label">Raw Icons</span>
            <span class="stat-val">93</span>
          </div>
          <div class="summary-stat-card highlight-card">
            <span class="stat-label">Boundary Found</span>
            <span class="stat-val text-green font-bold">28</span>
          </div>
          <div class="summary-stat-card">
            <span class="stat-label">Ambiguous</span>
            <span class="stat-val text-amber">0</span>
          </div>
          <div class="summary-stat-card">
            <span class="stat-label">Not Found</span>
            <span class="stat-val text-muted">3</span>
          </div>
          <div class="summary-stat-card">
            <span class="stat-label">Confirmed Posts</span>
            <span class="stat-val text-blue font-bold">28</span>
          </div>
          <div class="summary-stat-card">
            <span class="stat-label">Duplicates</span>
            <span class="stat-val">0</span>
          </div>
          <div class="summary-stat-card">
            <span class="stat-label">Needs Attention</span>
            <span class="stat-val text-amber">3</span>
          </div>
          <div class="summary-stat-card">
            <span class="stat-label">Comment Actions</span>
            <span class="stat-val text-purple">0</span>
          </div>
        </div>

        <div class="saved-runs-bar">
          <span class="saved-runs-label">📂 Saved Runs (3):</span>
          <div class="saved-runs-chips">
            <button class="run-chip active">
              <span class="chip-time">09:14:41</span>
              <span class="chip-id">run_1794363137380...</span>
              <span class="chip-badge">28 found</span>
              <span class="chip-source">📁</span>
            </button>
            <button class="run-chip">
              <span class="chip-time">08:41:20</span>
              <span class="chip-id">run_1794361220180...</span>
              <span class="chip-badge">18 found</span>
            </button>
            <button class="run-chip">
              <span class="chip-time">04:57:08</span>
              <span class="chip-id">run_1794304608245...</span>
              <span class="chip-badge">10 found</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Frame Inspector (70% Left / 30% Right) -->
      <div class="frame-inspector-container">
        <!-- Header -->
        <header class="frame-inspector-header">
          <div class="inspector-header-left">
            <span class="run-tag">Run: <b>run_1794363137380_f0a3s</b></span>
            <span class="platform-tag">Platform: <b>FACEBOOK</b></span>
            <span class="badge-boundary BOUNDARY_FOUND">BOUNDARY_FOUND</span>
          </div>

          <div class="inspector-header-center">
            <button class="nav-btn prev-btn">&larr; Previous</button>
            <span class="frame-counter">Frame <b>04</b> / 50</span>
            <button class="nav-btn next-btn">Next &rarr;</button>
            <button class="nav-btn next-error-btn">Next Attention ⚠</button>
          </div>

          <div class="inspector-header-right">
            <div class="filter-pill-group">
              <button class="filter-pill active">All (50)</button>
              <button class="filter-pill">Found (28)</button>
              <button class="filter-pill">Attention (3)</button>
              <button class="filter-pill">No Row (19)</button>
            </div>
          </div>
        </header>

        <!-- Main 70/30 Content -->
        <div class="frame-inspector-main">
          <!-- Left 70%: Screenshot Viewer -->
          <div class="inspector-left-pane">
            <div class="frame-screenshot-wrapper">
              <div class="screenshot-toolbar">
                <div class="toolbar-group">
                  <span class="toolbar-label">View:</span>
                  <button class="toolbar-btn active">Highlighted ✔</button>
                  <button class="toolbar-btn">Original</button>
                </div>
                <div class="toolbar-group">
                  <span class="toolbar-label">Zoom:</span>
                  <button class="toolbar-btn">-</button>
                  <span class="zoom-indicator">100%</span>
                  <button class="toolbar-btn">+</button>
                  <button class="toolbar-btn">Reset</button>
                </div>
                <div class="toolbar-group metadata">
                  <span>1024×560 (viewport: 1024×560)</span>
                </div>
              </div>

              <div class="screenshot-viewport">
                <div class="screenshot-canvas-area">
                  <img src="${imgBase64}" class="screenshot-img" alt="Frame 04 evidence">
                </div>
              </div>
            </div>
          </div>

          <!-- Right 30%: Diagnostics & Inspector -->
          <div class="inspector-right-pane">
            <div class="frame-diagnostics-panel">
              <!-- Capture -->
              <section class="diag-group capture-group">
                <h4 class="diag-title">📸 Capture</h4>
                <div class="diag-grid">
                  <div class="diag-item">
                    <span class="diag-label">Frame:</span>
                    <span class="diag-value">#04</span>
                  </div>
                  <div class="diag-item">
                    <span class="diag-label">Scroll Y:</span>
                    <span class="diag-value">1092 px</span>
                  </div>
                  <div class="diag-item">
                    <span class="diag-label">Dimensions:</span>
                    <span class="diag-value">1024×560</span>
                  </div>
                  <div class="diag-item">
                    <span class="diag-label">Status:</span>
                    <span class="diag-value status-pass">CAPTURE_PASS</span>
                  </div>
                </div>
              </section>

              <!-- OpenCV -->
              <section class="diag-group cv-group">
                <h4 class="diag-title">👁 OpenCV Recognition</h4>
                <div class="diag-grid">
                  <div class="diag-item">
                    <span class="diag-label">Detection:</span>
                    <span class="diag-value status-pass">DETECTION_PASS</span>
                  </div>
                  <div class="diag-item">
                    <span class="diag-label">Raw Icons:</span>
                    <span class="diag-value">3 candidates</span>
                  </div>
                  <div class="diag-item">
                    <span class="diag-label">Action Clusters:</span>
                    <span class="diag-value">1 detected</span>
                  </div>
                  <div class="diag-item">
                    <span class="diag-label">Match Score:</span>
                    <span class="diag-value">100.0%</span>
                  </div>
                </div>
                <div class="diag-status-text">
                  PIPELINE_PASS: Stage A–D processed 24 candidates in 38.2 ms; Stage E executed.
                </div>
              </section>

              <!-- DOM Boundary -->
              <section class="diag-group boundary-group">
                <div class="boundary-group-header">
                  <h4 class="diag-title">🎯 DOM Boundary &amp; Traversal</h4>
                  <span class="badge-boundary BOUNDARY_FOUND">BOUNDARY_FOUND</span>
                </div>
                <div class="boundary-info-content">
                  <div class="diag-grid">
                    <div class="diag-item">
                      <span class="diag-label">Candidate Status:</span>
                      <span class="diag-value status-highlight">NEW_ITEM</span>
                    </div>
                    <div class="diag-item">
                      <span class="diag-label">DOM Context:</span>
                      <span class="diag-value">post (BOUNDARY_FOUND)</span>
                    </div>
                    <div class="diag-item">
                      <span class="diag-label">Hit Element:</span>
                      <span class="diag-value monospace-val">&lt;i&gt;</span>
                    </div>
                    <div class="diag-item">
                      <span class="diag-label">Ancestors Traversed:</span>
                      <span class="diag-value">28 levels</span>
                    </div>
                    <div class="diag-item">
                      <span class="diag-label">First Permalink:</span>
                      <span class="diag-value">Level 26</span>
                    </div>
                    <div class="diag-item">
                      <span class="diag-label">Crossed (Second):</span>
                      <span class="diag-value">Level 27</span>
                    </div>
                  </div>

                  <div class="container-summary-box">
                    <span class="container-summary-label">Candidate Container:</span>
                    <div class="container-summary-val">
                      <code>&lt;div role="article"&gt;</code>
                      <span class="container-dims">Level 26 · 680×448 px</span>
                    </div>
                  </div>

                  <div class="post-identities-box">
                    <span class="identities-label">Post Identities (1):</span>
                    <div class="identities-list">
                      <span class="identity-pill">facebook: <b>29290501077301996</b></span>
                    </div>
                  </div>

                  <!-- Permalink Inspection -->
                  <div class="permalink-inspector-section">
                    <h5 class="section-subtitle">🔗 Permalink &amp; URL Classification</h5>
                    <div class="url-category-block current-item-block">
                      <div class="category-header">
                        <span class="category-title">Current Item URLs (1)</span>
                        <span class="category-hint">L0 – L26</span>
                      </div>
                      <div class="url-interactive-list">
                        <div class="url-interactive-card matched">
                          <div class="card-top-meta">
                            <div class="meta-left">
                              <span class="level-badge">L26</span>
                              <span class="tag-badge">&lt;div role="article"&gt;</span>
                              <span class="scope-tag current">CURRENT_ITEM</span>
                            </div>
                            <div class="meta-right">
                              <span class="status-pill matched">✔ fb_group_post</span>
                            </div>
                          </div>
                          <div class="url-raw-display">
                            <b>Raw URL:</b> <span class="raw-url-text">https://www.facebook.com/groups/seovamarketing/posts/29290501077301996/</span>
                          </div>
                          <div class="url-canonical-display">
                            <b>Canonical:</b> <span class="canonical-url-text">https://www.facebook.com/groups/seovamarketing/posts/29290501077301996/</span>
                          </div>
                          <div class="url-identity-display">
                            <b>Extracted ID:</b> <code>facebook:29290501077301996</code>
                          </div>
                          <div class="url-actions-bar">
                            <button type="button" class="url-act-btn open-btn">🌐 Open in BrowserCore</button>
                            <button type="button" class="url-act-btn copy-btn">📋 Copy URL</button>
                            <button type="button" class="url-act-btn use-btn">⚡ Use This URL</button>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div class="url-category-block feed-neighbor-block">
                      <div class="category-header">
                        <span class="category-title">Feed / Neighbor URLs (2)</span>
                        <span class="category-hint">L &ge; 27</span>
                      </div>
                      <div class="notice-subtext" style="font-size: 10px; color: #94a3b8; font-style: italic;">
                        ℹ Notice: URLs found at or above the feed container level are neighbor posts and are never used to confirm ownership of the current item.
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>
`;

const previewHtmlPath = path.resolve("scratch/frame-inspector-preview.html");
fs.writeFileSync(previewHtmlPath, html, "utf8");

async function capture() {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.goto(`file://${previewHtmlPath.replace(/\\\\/g, "/")}`, { waitUntil: "networkidle" });
  const outPath = path.resolve("scratch/visual-match-lab-frame-inspector.png");
  await page.screenshot({ path: outPath, fullPage: true });
  console.log("Screenshot successfully saved to:", outPath);
  await browser.close();
}

capture().catch(console.error);
