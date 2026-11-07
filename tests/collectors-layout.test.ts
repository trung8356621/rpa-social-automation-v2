import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const stylePath = resolve("src/renderer/style.css");
const editorPath = resolve("src/renderer/collectors/CollectorEditor.tsx");
const css = readFileSync(stylePath, "utf8");
const editor = readFileSync(editorPath, "utf8");

test("collector editor uses flex body regions instead of overlapping absolute Versions", () => {
  assert.match(css, /\.collector-editor-body\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.collector-versions-slot\s*\{[^}]*flex:\s*0 0/s);
  assert.match(css, /\.collector-wizard-main\s*\{[^}]*flex:\s*1 1 auto/s);
  assert.match(css, /\.collector-version-panel\s*\{[^}]*position:\s*relative\s*!important/s);
  assert.doesNotMatch(css, /\.collector-versions-slot\s*\{[^}]*position:\s*absolute/s);
  const versionPanel = readFileSync(resolve("src/renderer/collectors/VersionPanel.tsx"), "utf8");
  assert.match(versionPanel, /role="complementary"/);
  assert.doesNotMatch(versionPanel, /<aside[\s>]/);
});

test("narrow viewports use intentional Versions drawer with backdrop", () => {
  assert.match(css, /\.collector-versions-drawer-layer/);
  assert.match(css, /\.collector-versions-backdrop/);
  assert.match(editor, /versions-drawer-mode/);
  assert.match(editor, /Hide Versions|Versions/);
  assert.match(editor, /drawerMode/);
});

test("C1.7 compact editor chrome fills viewport without outer editor scroll", () => {
  assert.match(css, /\.collector-editor-row1\s*\{/s);
  assert.match(css, /\.collector-wizard-stage\s*\{[^}]*flex:\s*1 1 auto/s);
  assert.match(css, /\.collector-wizard-main\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.collector-capture-workspace\s*\{[^}]*flex:\s*1 1 auto/s);
  assert.match(css, /\.collector-review-workspace\s*\{[^}]*flex:\s*1 1 auto/s);
  assert.match(editor, /collector-editor-chrome/);
  assert.match(editor, /collector-editor-row1/);
  assert.match(editor, /collector-meta-details/);
  assert.match(editor, /Dismiss/);
});

test("web-dev entry is isolated from production build entry", () => {
  const vite = readFileSync(resolve("vite.config.ts"), "utf8");
  const pkg = readFileSync(resolve("package.json"), "utf8");
  assert.match(pkg, /"dev:web":\s*"vite"/);
  assert.match(vite, /web-dev-bootstrap\.ts/);
  assert.match(vite, /ctx\.server/);
  // C2.1: stub transform must be serve-only or Electron white-screens on read-only creator.
  assert.match(vite, /apply:\s*["']serve["']/);
  const html = readFileSync(resolve("src/renderer/index.html"), "utf8");
  assert.match(html, /main\.tsx/);
  assert.doesNotMatch(html, /web-dev-bootstrap/);
});

test("C1.8 three-column review + minimal library + admin zoom wiring", () => {
  const review = readFileSync(resolve("src/renderer/collectors/ReviewMappingStep.tsx"), "utf8");
  const capture = readFileSync(resolve("src/renderer/collectors/CaptureStep.tsx"), "utf8");
  const zoom = readFileSync(resolve("src/renderer/ui-zoom.ts"), "utf8");
  const main = readFileSync(resolve("src/renderer/main.tsx"), "utf8");
  assert.match(css, /\.collector-review-workspace-3col/);
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*5fr\)\s*minmax\(160px,\s*2fr\)\s*minmax\(220px,\s*3fr\)/);
  assert.match(css, /\.collector-review-image-frame img\s*\{[^}]*object-fit:\s*contain/s);
  assert.match(css, /\.collector-library-thumb img\s*\{[^}]*object-fit:\s*contain/s);
  assert.match(review, /collector-review-workspace-3col/);
  assert.match(review, /Sample Data/);
  assert.match(review, /applyAuditActionAndAdvance/);
  assert.match(review, /excludeTags/);
  assert.match(review, /Quarantine/);
  assert.doesNotMatch(review, /ROI \$\{/);
  assert.match(capture, /collector-library-card/);
  assert.doesNotMatch(capture, /Recapture/);
  assert.doesNotMatch(capture, /onPreview/);
  assert.match(zoom, /ADMIN_UI_ZOOM_KEY/);
  assert.match(zoom, /style\.zoom/);
  assert.match(main, /installAdminUiZoomShortcuts/);
});

test("C2 real browser adapter + overlays collectors visibility", () => {
  const adapter = readFileSync(resolve("src/renderer/collectors/browser-capture.ts"), "utf8");
  const capture = readFileSync(resolve("src/renderer/collectors/CaptureStep.tsx"), "utf8");
  const overlays = readFileSync(resolve("src/main/creator-overlays.ts"), "utf8");
  const main = readFileSync(resolve("src/main/main.ts"), "utf8");
  assert.match(adapter, /collectorNavigate|collectorFreezeFrame|collectorCropRoi/);
  assert.match(adapter, /BROWSER_CORE_UNAVAILABLE/);
  assert.doesNotMatch(adapter, /iframe|CORS proxy/i);
  assert.match(capture, /isElectronBrowserCoreAvailable/);
  assert.match(capture, /UI-only preview/);
  assert.match(capture, /collector-browser-host/);
  assert.match(capture, /collectorReportBrowserHost|collectorBrowserHost/);
  assert.match(capture, /fitCaptureImageInDisplay|position:\s*[\"']fixed[\"']/);
  assert.match(capture, /assertRoiFitsCapture|clientPointToCaptureCoords/);
  assert.doesNotMatch(capture, /objectFit:\s*[\"']fill[\"'].*inset:\s*0/s);
  assert.match(overlays, /setCollectorHost|resolveBrowserViewBounds|shouldShowBrowserForPage/);
  assert.match(main, /collectorBrowserHost/);
  assert.match(main, /requireCanonical:\s*false/);
});

test("C2.4 Capture split layout: browser left, tools right, no Capture mode checkbox", () => {
  const capture = readFileSync(resolve("src/renderer/collectors/CaptureStep.tsx"), "utf8");
  assert.match(css, /\.collector-capture-split\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(200px,\s*240px\)/s);
  assert.match(css, /\.collector-capture-tools\s*\{/s);
  assert.match(capture, /collector-capture-split/);
  assert.match(capture, /collector-capture-tools/);
  assert.match(capture, /Capture Region \/ Chụp vùng/);
  assert.doesNotMatch(capture, /Capture mode/);
  assert.doesNotMatch(capture, /type=\"checkbox\"/);
  // Tools sidebar must not collapse Capture into a single stacked column at 1100px.
  assert.match(css, /\.collector-capture-split\s*\{[^}]*minmax\(180px,\s*220px\)/s);
});
