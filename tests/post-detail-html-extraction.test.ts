import assert from "node:assert/strict";
import test from "node:test";
import { buildPostDetailExtractAboveJs, parsePostDetailHtmlSnapshot } from "../src/main/post-detail-html-extractor.js";

test("HTML extraction snapshot is offline-reprocessable", () => {
  const parsed = parsePostDetailHtmlSnapshot(`<article><p>Hello</p><script type="application/json" id="post-detail-parsed-json">{"post_id":"42","content":"Hello","images":[],"links":[]}</script></article>`);
  assert.equal(parsed.post_id, "42");
  assert.equal(parsed.content, "Hello");
});

test("generated live extractor is valid JavaScript and includes stale-anchor guards", () => {
  const source = buildPostDetailExtractAboveJs({ runId: "run", expectedUrl: "https://www.facebook.com/groups/g/posts/42/", expectedWebContentsId: 1, frameId: "f", frameIndex: 1, screenshot: { width: 100, height: 100 }, anchors: [] });
  assert.doesNotThrow(() => new Function(`return ${source}`));
  assert.match(source, /STALE_VISUAL_ANCHOR/);
  assert.match(source, /elementsFromPoint/);
});
