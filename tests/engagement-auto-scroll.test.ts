import test from "node:test";
import assert from "node:assert/strict";
import { buildEngagementAutoScrollJs } from "../src/main/engagement-auto-scroll";

test("Engagement auto-scroll script embeds saved hint and safety limits", () => {
  const js = buildEngagementAutoScrollJs({
    frameIndex: 4,
    deltaY: -100,
    observedScrollPx: 300,
    scrollTop: 240,
    maxScroll: 1200,
    tag: "DIV",
    role: "dialog",
  });
  assert.match(js, /frameIndex":4/);
  assert.match(js, /"scrollTop":240/);
  assert.match(js, /"tag":"DIV"/);
  assert.match(js, /maxAdjustments = 10/);
  assert.match(js, /ENGAGEMENT_OUTSIDE_VIEWPORT/);
  assert.match(js, /ALREADY_VISIBLE/);
  assert.match(js, /__rpaPdcSavedActionRow/);
});

test("Engagement auto-scroll script works without hint", () => {
  const js = buildEngagementAutoScrollJs(null);
  assert.match(js, /saved_scroll_hint:none/);
  assert.match(js, /findScrollAncestor/);
});
