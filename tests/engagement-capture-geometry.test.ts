import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ENGAGEMENT_CAPTURE_GEOMETRY_JS } from "../src/main/engagement-capture-geometry";

const main = () => readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8");

test("Engagement capture reuses BrowserCore capture and never VisualMatchLab page switch", () => {
  const source = main();
  assert.match(source, /ENGAGEMENT_CAPTURE_GEOMETRY_JS/);
  assert.match(source, /browser\.capture\(\{\s*requireCanonical:\s*false\s*\}\)/);
  assert.doesNotMatch(source, /postDetailCaptureEngagement[\s\S]{0,1200}visualMatchLab\.capture\(/);
  assert.match(source, /browser\.view\.webContents\.id !== wc\.id/);
  assert.doesNotMatch(source, /capture\.webContentsId/);
});

test("Engagement geometry uses matched Parent DOM counts instead of fixed offsets", () => {
  assert.match(ENGAGEMENT_CAPTURE_GEOMETRY_JS, /__rpaPdcSavedParent/);
  assert.match(ENGAGEMENT_CAPTURE_GEOMETRY_JS, /__rpaPdcSavedActionRow/);
  assert.match(ENGAGEMENT_CAPTURE_GEOMETRY_JS, /previousElementSibling/);
  assert.match(ENGAGEMENT_CAPTURE_GEOMETRY_JS, /looksLikeCount/);
  assert.match(ENGAGEMENT_CAPTURE_GEOMETRY_JS, /ENGAGEMENT_OUTSIDE_VIEWPORT/);
  assert.match(ENGAGEMENT_CAPTURE_GEOMETRY_JS, /No reliable Engagement wrapper/);
  assert.doesNotMatch(ENGAGEMENT_CAPTURE_GEOMETRY_JS, /r\.top\s*-\s*160/);
  assert.doesNotMatch(ENGAGEMENT_CAPTURE_GEOMETRY_JS, /r\.top\s*-\s*96/);
});

type Rect = { x: number; y: number; width: number; height: number; left: number; right: number; top: number; bottom: number };
const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height, left: x, right: x + width, top: y, bottom: y + height });

class FakeEl {
  tagName: string;
  children: FakeEl[] = [];
  childNodes: Array<{ nodeType: number; textContent: string }> = [];
  parentElement: FakeEl | null = null;
  previousElementSibling: FakeEl | null = null;
  nextElementSibling: FakeEl | null = null;
  isConnected = true;
  private attrs = new Map<string, string>();
  private box: Rect;
  constructor(tag: string, box: Rect, text = "") {
    this.tagName = tag.toUpperCase();
    this.box = box;
    if (text) this.childNodes = [{ nodeType: 3, textContent: text }];
  }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  getAttribute(name: string) { return this.attrs.has(name) ? this.attrs.get(name)! : null; }
  getBoundingClientRect() { return { ...this.box }; }
  matches(selector: string) {
    const parts = selector.split(",").map((part) => part.trim());
    return parts.some((part) => {
      if (part === "svg" && this.tagName === "SVG") return true;
      if (part === "img" && this.tagName === "IMG") return true;
      if (part === "video" && this.tagName === "VIDEO") return true;
      if (part === "canvas" && this.tagName === "CANVAS") return true;
      if (part === "[role='img']" && this.getAttribute("role") === "img") return true;
      if (part.startsWith("[data-visualcompletion") && this.getAttribute("data-visualcompletion") === "media-vc-image") return true;
      return false;
    });
  }
  querySelectorAll(selector: string) {
    const all = this.collect();
    if (selector === "*") return all.slice(1);
    if (selector === "img,video,canvas") return all.filter((el) => ["IMG", "VIDEO", "CANVAS"].includes(el.tagName));
    if (selector.includes("aria-label")) return all.filter((el) => el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("data-count") || el.tagName === "SPAN" || el.tagName === "A");
    if (selector.includes("svg")) return all.filter((el) => ["SVG", "IMG", "BUTTON"].includes(el.tagName) || el.getAttribute("role") === "img" || el.getAttribute("role") === "button");
    return [];
  }
  querySelector() { return null; }
  contains(other: FakeEl) { return this.collect().includes(other); }
  private collect(acc: FakeEl[] = []): FakeEl[] {
    acc.push(this);
    for (const child of this.children) child.collect(acc);
    return acc;
  }
}

const append = (parent: FakeEl, child: FakeEl) => {
  child.parentElement = parent;
  const prev = parent.children[parent.children.length - 1] || null;
  if (prev) {
    prev.nextElementSibling = child;
    child.previousElementSibling = prev;
  }
  parent.children.push(child);
  return child;
};

const runGeometry = (parent: FakeEl, row: FakeEl) => {
  const run = new Function("window", "innerWidth", "innerHeight", "Element", "Array", "Math", "Boolean", "String", "Number", `return ${ENGAGEMENT_CAPTURE_GEOMETRY_JS};`);
  return run({ __rpaPdcSavedParent: parent, __rpaPdcSavedActionRow: row }, 1024, 560, FakeEl, Array, Math, Boolean, String, Number);
};

test("Engagement geometry crops the smallest wrapper and excludes post media", () => {
  const parent = new FakeEl("div", rect(40, 20, 520, 420));
  const media = append(parent, new FakeEl("img", rect(40, 20, 520, 240)));
  media.setAttribute("alt", "post photo");
  const wrap = append(parent, new FakeEl("div", rect(40, 280, 520, 100)));
  const summary = append(wrap, new FakeEl("div", rect(56, 288, 220, 28)));
  const icon = append(summary, new FakeEl("img", rect(56, 292, 18, 18)));
  icon.setAttribute("alt", "Like");
  const likes = append(summary, new FakeEl("span", rect(80, 292, 28, 16), "128"));
  likes.setAttribute("aria-label", "128 likes");
  const comments = append(summary, new FakeEl("span", rect(140, 292, 70, 16), "12 comments"));
  comments.setAttribute("aria-label", "12 comments");
  const row = append(wrap, new FakeEl("div", rect(40, 330, 520, 48)));
  const likeBtn = append(row, new FakeEl("button", rect(60, 338, 40, 32)));
  likeBtn.setAttribute("role", "button");
  const likeIcon = append(likeBtn, new FakeEl("svg", rect(70, 346, 18, 18)));
  likeIcon.setAttribute("role", "img");

  const result = runGeometry(parent, row);
  assert.equal(result.ok, true);
  assert.ok(result.rect.y >= 270, "crop must start at Engagement wrapper, not media");
  assert.ok(result.rect.height < 140, "crop must stay in Engagement band");
  assert.ok(result.rect.y + result.rect.height <= 390);
  assert.ok(result.actionRects.length >= 1);
});

test("Engagement geometry refuses Parent-sized crop when media pollutes the only wrapper", () => {
  const parent = new FakeEl("div", rect(40, 20, 520, 420));
  const media = append(parent, new FakeEl("img", rect(40, 20, 520, 240)));
  media.setAttribute("alt", "post photo");
  const summary = append(parent, new FakeEl("div", rect(56, 288, 220, 28)));
  const likes = append(summary, new FakeEl("span", rect(80, 292, 28, 16), "128"));
  likes.setAttribute("aria-label", "128 likes");
  const row = append(parent, new FakeEl("div", rect(40, 330, 520, 48)));
  const result = runGeometry(parent, row);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NO_COUNT_REGION");
  assert.match(String(result.diagnostics?.join(" ") || ""), /No reliable Engagement wrapper/);
});
