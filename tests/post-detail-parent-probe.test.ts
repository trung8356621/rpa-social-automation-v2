import assert from "node:assert/strict";
import test from "node:test";
import { buildPostDetailActionAnchorProbeJs, buildPostDetailParentProbeJs, CLEAR_POST_DETAIL_PARENT_HIGHLIGHT_JS, orderProgressiveCandidates } from "../src/main/post-detail-parent-probe.js";

test("calibration checks exact level before ±1 and full fallback", () => {
  const rows = [{ parentLevel: 7, descendantCount: 900 }, { parentLevel: 8, descendantCount: 100 }, { parentLevel: 9, descendantCount: 800 }, { parentLevel: 12, descendantCount: 1200 }];
  assert.deepEqual(orderProgressiveCandidates(rows, 8), { items: [rows[1], rows[3], rows[0], rows[2]], mode: "EXACT" });
  assert.deepEqual(orderProgressiveCandidates(rows.filter(x => x.parentLevel !== 8), 8).items.slice(0, 2), [rows[0], rows[2]]);
  assert.equal(orderProgressiveCandidates(rows, 4).mode, "FULL_PROGRESSIVE");
});

test("progressive probe includes URL queries, second-row stop, root guard and cleanup", () => {
  const source = buildPostDetailParentProbeJs({ sourceUrl: "https://www.facebook.com/groups/g/permalink/42/", runId: "r", expectedWebContentsId: 1, frameId: "f", screenshot: { width: 100, height: 100 }, anchors: [], expectedParentLevel: 8 });
  assert.doesNotThrow(() => new Function(`return ${source}`));
  assert.match(source, /multi_permalinks/);
  assert.match(source, /SECOND_ACTION_ROW_FOUND/);
  assert.match(source, /document\.body/);
  assert.match(source, /pointer-events:none/);
  assert.match(CLEAR_POST_DETAIL_PARENT_HIGHLIGHT_JS, /dispose/);
  const anchorSource = buildPostDetailActionAnchorProbeJs({ sourceUrl: "https://www.facebook.com/groups/g/permalink/42/", runId: "r", expectedWebContentsId: 1, frameId: "f", screenshot: { width: 100, height: 100 }, anchors: [] });
  assert.doesNotThrow(() => new Function(`return ${anchorSource}`));
  assert.match(anchorSource, /elementsFromPoint/);
  assert.match(anchorSource, /pointer-events:none/);
});
