import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { executeVariableMapping, extractParentData, parseEngagementNumber } from "../src/renderer/post-detail-collector/extract-parent-data";
import { evaluateMatchedParentDom, parseBatchUrls } from "../src/renderer/post-detail-collector/batch-validation";
import { getPostDetailCollectorState, setPostDetailCollectorState } from "../src/renderer/post-detail-collector/store";
import {
  addRegistryVariable,
  deleteRegistryVariable,
  ensureDefaultCollector,
  listRegistryVariables,
  updateRegistryVariable,
} from "../src/renderer/post-detail-collector/variable-registry";
import type { PostDetailDomVariableMapping } from "../src/renderer/post-detail-collector/types";

const explorer = () => readFileSync("src/renderer/post-detail-collector/SavedParentHtmlStep.tsx", "utf8");
const extraction = () => readFileSync("src/renderer/post-detail-collector/extract-parent-data.ts", "utf8");

test("Step 3 defaults to extracted values and keeps deep DOM under Advanced Debug", () => {
  const source = explorer();
  assert.match(source, /Step 3 — Extracted Data Review/);
  assert.match(source, /Extracted values/);
  assert.match(source, /<details className="pdc-advanced-debug"><summary>Advanced Debug<\/summary>/);
  assert.match(source, /Auto Mapped/);
  assert.match(source, /Unmapped/);
  assert.match(source, /Needs Attention/);
  assert.match(source, /className="pdc-extracted-detail"/);
  assert.doesNotMatch(source, /<aside className="pdc-data-mapper"/);
});

test("single-pass extraction emits direct text and semantic values without ancestor textContent", () => {
  const source = extraction();
  assert.match(source, /One DFS pass for generic values/);
  assert.match(source, /node\.nodeType === 3/);
  assert.match(source, /tag === "a"/);
  assert.match(source, /tag === "img"/);
  assert.match(source, /tag === "time"/);
  assert.doesNotMatch(source, /kind: "text"[^\n]*element\.textContent/);
});

test("semantic extraction uses post identity accessibility metadata and structural body boundaries", () => {
  const source = extraction();
  assert.match(source, /aria-describedby/);
  assert.match(source, /findPrimaryTimestampAnchor/);
  assert.match(source, /semanticField: "created_at"/);
  assert.match(source, /findPostContentRoot/);
  assert.match(source, /semanticField: "content"/);
  assert.match(source, /content_text/);
  assert.match(source, /content_html/);
  assert.match(source, /isComment/);
  assert.doesNotMatch(source, /OCR|parent\.textContent/);
});

test("links expose text and href outputs from one locator", () => {
  const source = extraction();
  assert.match(source, /outputs\.push\(\{ key: "text"/);
  assert.match(source, /outputs\.push\(\{ key: "href"/);
  assert.match(source, /sourcePaths: path\.length \? \[path\] : \[\]/);
});

test("Step 3 supports output mapping, persisted hide and hidden-noise review", () => {
  const source = explorer();
  const store = readFileSync("src/renderer/post-detail-collector/store.ts", "utf8");
  assert.match(source, /Save Mapping/);
  assert.match(source, /Unmap Output/);
  assert.match(source, /Show Hidden/);
  assert.match(source, /Restore/);
  assert.match(source, /pdc-data-hide/);
  assert.match(source, /outputKey: selectedOutput\.key/);
  assert.match(store, /hiddenExtractedData: state\.hiddenExtractedData/);
});

test("extraction preserves structural context and refuses ambiguous locators", () => {
  const extractSource = extraction();
  const uiSource = explorer();
  assert.match(extractSource, /getAttribute\("role"\) === "article"/);
  assert.match(extractSource, /isComment\(element, root\) \? "comment"/);
  assert.match(uiSource, /selectedData\.sourcePaths\.length !== 1/);
  assert.match(uiSource, /sourceContext: selectedData\.context/);
  assert.match(uiSource, /postDetailClearParentNodeHighlight/);
});

test("Step 3 DOM Explorer supports lazy focus, breadcrumb and expanded view", () => {
  const source = explorer();
  assert.match(source, /onDoubleClick=\{\(\) => onFocus\(node\)\}/);
  assert.match(source, /Reset Focus/);
  assert.match(source, /pdc-dom-breadcrumb/);
  assert.match(source, /isExpanded/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /Tree width/);
  assert.match(source, /Collapse Browser Preview/);
  assert.match(source, /const children = open \?/);
  assert.doesNotMatch(source, /children: ExplorerNode\[\]/);
});

test("Inspector separates readable content, selectors and live highlight", () => {
  const source = explorer();
  for (const label of ["Attributes", "Text", "Selector", "Variables", "Copy XPath", "Copy Selector", "Copy Text"]) assert.match(source, new RegExp(label));
  assert.match(source, /onMouseEnter=\{\(\) => onHover\(node\)\}/);
  assert.match(source, /Full text/);
  assert.match(source, /outerHTML/);
});

test("Step 3 reuses Collector variable schema and persists only verified mappings", () => {
  const source = explorer();
  const registry = readFileSync("src/renderer/post-detail-collector/variable-registry.ts", "utf8");
  const store = readFileSync("src/renderer/post-detail-collector/store.ts", "utf8");
  assert.match(registry, /loadCollectorStore/);
  assert.match(registry, /saveCollectorStore/);
  assert.match(source, /Manage Variables/);
  assert.match(source, /DOM_TEXT/);
  assert.match(source, /DOM_ATTRIBUTE/);
  assert.match(source, /selectedMatchCount !== 1/);
  assert.match(source, /Missing/);
  assert.match(source, /Needs Attention/);
  assert.match(store, /variableMappings: state\.variableMappings/);
  assert.doesNotMatch(source, /like_count|comment_count|share_count/);
});

test("AUTO remains strict and Customize does not run visual scan", () => {
  const source = explorer();
  assert.match(source, /AUTO · Parent Matched/);
  assert.match(source, /Customize · Rematch Parent/);
  assert.doesNotMatch(source, /runPostDetailAutoScan|Auto Scan|OpenCV/);
});

// --- Real DOM fixture tests ---

class FakeText {
  nodeType = 3;
  textContent: string;
  parentElement: FakeElement | null = null;
  constructor(text: string) {
    this.textContent = text;
  }
  cloneNode(): FakeText {
    return new FakeText(this.textContent);
  }
}

class FakeElement {
  nodeType = 1;
  tagName: string;
  attrs: Record<string, string>;
  childNodes: Array<FakeElement | FakeText> = [];
  parentElement: FakeElement | null = null;

  constructor(tagName: string, attrs: Record<string, string> = {}, children: Array<FakeElement | FakeText | string> = []) {
    this.tagName = tagName.toUpperCase();
    this.attrs = { ...attrs };
    for (const child of children) {
      const node = typeof child === "string" ? new FakeText(child) : child;
      node.parentElement = this;
      this.childNodes.push(node);
    }
  }

  get id(): string {
    return this.attrs.id || "";
  }

  get children(): FakeElement[] & { item: (i: number) => FakeElement | null } {
    const list = this.childNodes.filter((n): n is FakeElement => n.nodeType === 1) as FakeElement[] & {
      item: (i: number) => FakeElement | null;
    };
    list.item = (i: number) => list[i] ?? null;
    return list;
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  hasAttribute(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.attrs, name);
  }

  get textContent(): string {
    return this.childNodes.map((n) => n.textContent).join("");
  }

  get innerHTML(): string {
    return this.childNodes
      .map((n) => {
        if (n.nodeType === 3) return (n as FakeText).textContent;
        const el = n as FakeElement;
        const attrStr = Object.entries(el.attrs)
          .map(([k, v]) => ` ${k}="${v}"`)
          .join("");
        if (el.tagName === "BR") return `<br${attrStr}>`;
        return `<${el.tagName.toLowerCase()}${attrStr}>${el.innerHTML}</${el.tagName.toLowerCase()}>`;
      })
      .join("");
  }

  cloneNode(deep = false): FakeElement {
    const clonedChildren = deep ? this.childNodes.map((c) => c.cloneNode(true)) : [];
    return new FakeElement(this.tagName, this.attrs, clonedChildren);
  }

  remove(): void {
    if (!this.parentElement) return;
    this.parentElement.childNodes = this.parentElement.childNodes.filter((c) => c !== this);
    this.parentElement = null;
  }

  contains(other: FakeElement | null): boolean {
    for (let cur: FakeElement | null = other; cur; cur = cur.parentElement) {
      if (cur === this) return true;
    }
    return false;
  }

  compareDocumentPosition(other: FakeElement): number {
    let root: FakeElement = this;
    while (root.parentElement) root = root.parentElement;
    const order: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      order.push(el);
      for (const c of el.children) walk(c);
    };
    walk(root);
    const a = order.indexOf(this);
    const b = order.indexOf(other);
    if (a >= 0 && b > a) return 4; // DOCUMENT_POSITION_FOLLOWING
    if (a >= 0 && b >= 0 && b < a) return 2; // DOCUMENT_POSITION_PRECEDING
    return 0;
  }

  private matchesSimple(sel: string): boolean {
    const s = sel.trim();
    if (s === "*") return true;
    if (s === "a[href]") return this.tagName === "A" && this.hasAttribute("href");
    if (s === "[id]") return this.hasAttribute("id");
    if (s === "[role='button']") return this.getAttribute("role") === "button";
    if (s === "[role='article']") return this.getAttribute("role") === "article";
    if (s === "[aria-hidden='true']") return this.getAttribute("aria-hidden") === "true";
    if (s === "[hidden]") return this.hasAttribute("hidden");
    return this.tagName.toLowerCase() === s.toLowerCase();
  }

  querySelectorAll(selector: string): FakeElement[] {
    const parts = selector.split(",").map((s) => s.trim()).filter(Boolean);
    const results: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const child of el.children) {
        if (parts.some((p) => child.matchesSimple(p))) results.push(child);
        walk(child);
      }
    };
    walk(this);
    return results;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

const el = (tag: string, attrs: Record<string, string> = {}, children: Array<FakeElement | FakeText | string> = []) =>
  new FakeElement(tag, attrs, children);

function buildFacebookPostFixture(opts: {
  postId?: string;
  tsId?: string;
  tsText?: string;
  duplicateTsId?: boolean;
  omitTsTarget?: boolean;
  ambiguousBody?: boolean;
}) {
  const tsId = opts.tsId ?? "ts-full-1";
  const tsText = opts.tsText ?? "Thứ Sáu, 14 tháng 11, 2026 lúc 10:30";
  const postId = opts.postId ?? "29327016206983816";

  const headerSiblings: Array<FakeElement | string> = [
    el("a", { href: "/groups/seovamarketing/user/123/" }, ["Author Name"]),
    el("a", {
      href: `?__cft__[0]=abc&id=${postId}`,
      "aria-describedby": tsId,
      "aria-labelledby": "ts-lbl-1",
    }, ["2\u034fh\u200b"]),
    el("span", { id: "ts-lbl-1", hidden: "" }, ["2 giờ"]),
  ];
  if (!opts.omitTsTarget) {
    headerSiblings.push(el("span", { id: tsId, hidden: "" }, [tsText]));
  }
  if (opts.duplicateTsId) {
    headerSiblings.push(el("span", { id: tsId, hidden: "" }, ["Duplicate timestamp"]));
  }

  const bodyBranches = opts.ambiguousBody
    ? [
        el("div", {}, [el("span", {}, ["First ambiguous block"])]),
        el("div", {}, [el("span", {}, ["Second ambiguous block"])]),
      ]
    : [
        el("div", {}, [
          el("div", {}, [
            el("span", {}, ["Line one with "]),
            el("a", { href: "/hashtag/rpa" }, ["#rpa"]),
            el("br"),
            el("span", {}, ["Line two "]),
            el("a", { href: "https://example.com/docs?ref=fb" }, ["Read Docs"]),
          ]),
          el("ul", {}, [el("li", {}, ["Bullet one"]), el("li", {}, ["Bullet two"])]),
          el("span", { style: "display: none" }, ["Hidden noise"]),
        ]),
      ];

  const actionRow = el("div", {}, [
    el("div", { role: "button" }, ["Like"]),
    el("div", { role: "button" }, ["Comment"]),
    el("div", { role: "button" }, ["Share"]),
  ]);

  const comment = el("div", { role: "article" }, [
    el("a", { href: "/user/commenter/" }, ["Comment Author"]),
    el("a", { href: `?comment_id=999`, "aria-describedby": "c-ts-1" }, ["1h"]),
    el("span", { id: "c-ts-1", hidden: "" }, ["14 tháng 11 lúc 11:00"]),
    el("div", {}, ["Nice post!"]),
  ]);

  return el("div", {}, [
    el("div", {}, headerSiblings),
    ...bodyBranches,
    actionRow,
    comment,
  ]) as unknown as Element;
}

test("DOM fixture: created_at resolves aria-describedby at runtime and rejects missing/non-unique targets", () => {
  const post1 = buildFacebookPostFixture({ tsId: "ts-1", tsText: "14 tháng 11, 2026 lúc 10:30" });
  const items1 = extractParentData(post1, { postId: "29327016206983816", currentUrl: "https://www.facebook.com/groups/g/posts/29327016206983816/" });

  const createdAt = items1.find((i) => i.semanticField === "created_at");
  assert.ok(createdAt, "created_at item should be extracted");
  assert.equal(createdAt.extractionStatus, "verified");
  assert.equal(createdAt.value, "14 tháng 11, 2026 lúc 10:30");
  assert.equal(createdAt.outputs[0]?.key, "raw_display");
  assert.equal(createdAt.outputs[0]?.method, "DOM_ATTRIBUTE_REF_TEXT");
  assert.equal(createdAt.outputs[0]?.attribute, "aria-describedby");

  // Comment timestamp must remain in comment context, never mixed into post created_at
  const commentTs = items1.filter((i) => i.value.includes("11:00") && i.context === "post");
  assert.equal(commentTs.length, 0);

  // Re-execute saved mapping against a DIFFERENT post with a different timestamp and ID
  const savedMapping: PostDetailDomVariableMapping = {
    collectorId: "c1",
    variableId: "v_created",
    variableKey: "created_at",
    variableLabel: "Created at",
    method: createdAt.outputs[0].method,
    attribute: createdAt.outputs[0].attribute,
    relativePath: createdAt.sourcePaths[0],
    relativeXPath: createdAt.relativeXPath || "",
    preview: "STALE_PREVIEW_MUST_NOT_BE_USED",
    sourceContext: "post",
    sourceSemantic: "created_at",
    outputKey: "raw_display",
    confirmed: true,
    updatedAt: "2026-11-14T00:00:00Z",
  };

  const post2 = buildFacebookPostFixture({ tsId: "ts-other-99", tsText: "15 tháng 11, 2026 lúc 08:15" });
  const exec2 = executeVariableMapping(post2, savedMapping);
  assert.equal(exec2.status, "mapped");
  assert.equal(exec2.value, "15 tháng 11, 2026 lúc 08:15");
  assert.notEqual(exec2.value, "ts-other-99");
  assert.notEqual(exec2.value, savedMapping.preview);

  // Missing referenced element -> needs_attention
  const postMissing = buildFacebookPostFixture({ omitTsTarget: true });
  const missingItem = extractParentData(postMissing, { postId: "29327016206983816" }).find((i) => i.semanticField === "created_at");
  assert.equal(missingItem?.extractionStatus, "needs_attention");
  assert.equal(missingItem?.value, "");
  assert.equal(executeVariableMapping(postMissing, savedMapping).status, "needs_attention");

  // Non-unique referenced element -> needs_attention
  const postDup = buildFacebookPostFixture({ duplicateTsId: true });
  const dupItem = extractParentData(postDup, { postId: "29327016206983816" }).find((i) => i.semanticField === "created_at");
  assert.equal(dupItem?.extractionStatus, "needs_attention");
  assert.equal(dupItem?.value, "");
  assert.equal(executeVariableMapping(postDup, savedMapping).status, "needs_attention");
});

test("DOM fixture: content_text and content_html preserve structure, exclude noise, and flag ambiguous root", () => {
  const post = buildFacebookPostFixture({});
  const items = extractParentData(post, { postId: "29327016206983816", currentUrl: "https://www.facebook.com/groups/g/posts/29327016206983816/" });

  const contentItems = items.filter((i) => i.semanticField === "content");
  assert.equal(contentItems.length, 1, "should emit a single Content tag");
  const content = contentItems[0];
  assert.equal(content.extractionStatus, "verified");
  assert.match(content.value, /Line one with #rpa\nLine two Read Docs/);
  assert.match(content.value, /• Bullet one\n• Bullet two/);
  assert.doesNotMatch(content.value, /Author Name|Hidden noise|Like|Nice post/);

  const textOut = content.outputs.find((o) => o.key === "content_text");
  const htmlOut = content.outputs.find((o) => o.key === "content_html");
  assert.equal(textOut?.method, "CONTENT_TEXT");
  assert.equal(htmlOut?.method, "CONTENT_HTML");
  assert.ok(htmlOut && htmlOut.value.includes("#rpa") && !htmlOut.value.includes("Hidden noise") && !htmlOut.value.includes("Nice post"));

  const textMapping: PostDetailDomVariableMapping = {
    collectorId: "c1", variableId: "v_text", variableKey: "content", variableLabel: "Content",
    method: "CONTENT_TEXT", relativePath: content.sourcePaths[0], relativeXPath: content.relativeXPath || "",
    preview: "STALE_TEXT", sourceContext: "post", sourceSemantic: "content", outputKey: "content_text",
    confirmed: true, updatedAt: "2026-11-14T00:00:00Z",
  };
  const htmlMapping: PostDetailDomVariableMapping = {
    ...textMapping, variableId: "v_html", variableKey: "content_html", method: "CONTENT_HTML", outputKey: "content_html",
  };
  assert.equal(executeVariableMapping(post, textMapping).value, textOut?.value);
  assert.equal(executeVariableMapping(post, htmlMapping).value, htmlOut?.value);

  // Ambiguous content root -> Needs Attention, never whole Parent
  const ambiguousPost = buildFacebookPostFixture({ ambiguousBody: true });
  const ambItems = extractParentData(ambiguousPost, { postId: "29327016206983816" });
  const ambContent = ambItems.find((i) => i.semanticField === "content");
  assert.equal(ambContent?.extractionStatus, "needs_attention");
  assert.equal(ambContent?.sourcePaths.length, 0);
  assert.equal(ambContent?.value, "");
});

test("DOM fixture: link exposes independent text and href outputs sharing one locator", () => {
  const root = el("div", {}, [
    el("a", { href: "https://example.com/docs?ref=fb" }, ["Read Docs"]),
  ]) as unknown as Element;
  const items = extractParentData(root);
  const link = items.find((i) => i.kind === "link");
  assert.ok(link);
  assert.equal(link.sourcePaths.length, 1);
  const textOut = link.outputs.find((o) => o.key === "text");
  const hrefOut = link.outputs.find((o) => o.key === "href");
  assert.equal(textOut?.value, "Read Docs");
  assert.equal(textOut?.method, "DOM_TEXT");
  assert.equal(hrefOut?.value, "https://example.com/docs?ref=fb");
  assert.equal(hrefOut?.method, "DOM_ATTRIBUTE");

  const mapText: PostDetailDomVariableMapping = {
    collectorId: "c1", variableId: "v1", variableKey: "link_text", variableLabel: "Link Text",
    method: "DOM_TEXT", relativePath: link.sourcePaths[0], relativeXPath: link.relativeXPath || "",
    preview: "", outputKey: "text", confirmed: true, updatedAt: "2026-11-14T00:00:00Z",
  };
  const mapHref: PostDetailDomVariableMapping = {
    collectorId: "c1", variableId: "v2", variableKey: "link_url", variableLabel: "Link URL",
    method: "DOM_ATTRIBUTE", attribute: "href", relativePath: link.sourcePaths[0], relativeXPath: link.relativeXPath || "",
    preview: "", outputKey: "href", confirmed: true, updatedAt: "2026-11-14T00:00:00Z",
  };
  assert.equal(executeVariableMapping(root, mapText).value, "Read Docs");
  assert.equal(executeVariableMapping(root, mapHref).value, "https://example.com/docs?ref=fb");
});

test("DOM fixture: engagement extraction handles 5 likes, 4 comments, 2 shares, aria-label vs text, missing counts, and comment isolation", () => {
  const buildEngagementPost = (opts: {
    likeAria?: string | null;
    likeText?: string | null;
    commentText?: string | null;
    shareText?: string | null;
    extraLikeCandidate?: boolean;
  }) => {
    const summaryChildren: Array<FakeElement | string> = [];
    if (opts.likeAria || opts.likeText) {
      summaryChildren.push(
        el("div", { role: "toolbar" }, [
          el(
            "div",
            opts.likeAria ? { role: "button", "aria-label": opts.likeAria } : { role: "button" },
            opts.likeText ? [opts.likeText] : [],
          ),
        ]),
      );
    }
    if (opts.extraLikeCandidate) {
      summaryChildren.push(el("span", { "aria-label": "Likes: 99" }, ["99 likes"]));
    }
    if (opts.commentText) {
      summaryChildren.push(el("div", { role: "button" }, [opts.commentText]));
    }
    if (opts.shareText) {
      summaryChildren.push(el("div", { role: "button" }, [opts.shareText]));
    }

    return el("div", {}, [
      el("div", {}, [
        el("a", { href: "/user/1/" }, ["Author Name"]),
        el("a", { href: "?id=29327016206983816", "aria-describedby": "ts-1" }, ["2h"]),
        el("span", { id: "ts-1", hidden: "" }, ["14 tháng 11, 2026 lúc 10:30"]),
      ]),
      el("div", {}, [el("span", {}, ["Post body mentioning 99 things"])]),
      el("div", {}, summaryChildren),
      el("div", {}, [
        el("div", { role: "button" }, ["Like"]),
        el("div", { role: "button" }, ["Comment"]),
        el("div", { role: "button" }, ["Share"]),
      ]),
      el("div", { role: "article" }, [
        el("a", { href: "/user/c1/" }, ["Commenter"]),
        el("div", {}, ["4 bình luận trong comment text không được nhầm"]),
        el("div", { role: "button", "aria-label": "Thích: 12 người" }, ["12"]),
        el("div", { role: "button" }, ["Reply"]),
      ]),
    ]) as unknown as Element;
  };

  // 1 & 2 & 4 & 5: 5 likes (aria-label), 4 comments (text node), 2 shares (text node), comment isolation
  const post1 = buildEngagementPost({
    likeAria: "Thích: 5 người",
    commentText: "4 bình luận",
    shareText: "2 lượt chia sẻ",
  });
  const items1 = extractParentData(post1, { postId: "29327016206983816" });
  const likes = items1.find((i) => i.semanticField === "like_count");
  const comments = items1.find((i) => i.semanticField === "comment_count");
  const shares = items1.find((i) => i.semanticField === "share_count");

  assert.equal(likes?.value, "5");
  assert.equal(likes?.predictedType, "number");
  assert.equal(likes?.extractionStatus, "verified");
  assert.equal(likes?.hiddenByDefault, false);
  assert.equal(likes?.outputs[0]?.method, "DOM_ATTRIBUTE_NUMBER");
  assert.equal(likes?.outputs[0]?.attribute, "aria-label");

  assert.equal(comments?.value, "4");
  assert.equal(comments?.outputs[0]?.method, "DOM_TEXT_NUMBER");

  assert.equal(shares?.value, "2");
  assert.equal(shares?.outputs[0]?.method, "DOM_TEXT_NUMBER");

  // 8: Saved mapping re-execution on another post returns new count, never preview
  const likeMapping: PostDetailDomVariableMapping = {
    collectorId: "c1",
    variableId: "v_like",
    variableKey: "like_count",
    variableLabel: "Likes",
    method: likes!.outputs[0].method,
    attribute: likes!.outputs[0].attribute,
    relativePath: likes!.sourcePaths[0],
    relativeXPath: likes!.relativeXPath || "",
    preview: "5",
    sourceContext: "post",
    sourceSemantic: "like_count",
    outputKey: "count",
    confirmed: true,
    updatedAt: "2026-11-14T00:00:00Z",
  };
  const post2 = buildEngagementPost({
    likeAria: "Thích: 1.2K người",
    commentText: "10 comments",
    shareText: "3 shares",
  });
  const exec2 = executeVariableMapping(post2, likeMapping);
  assert.equal(exec2.status, "mapped");
  assert.equal(exec2.value, "1200");

  // 3: Missing like count never becomes 0 (both absent element -> missing, and label without number -> needs_attention)
  const postMissingLike = buildEngagementPost({
    likeAria: null,
    likeText: null,
    commentText: "4 bình luận",
  });
  const missingItems = extractParentData(postMissingLike, { postId: "29327016206983816" });
  assert.equal(missingItems.find((i) => i.semanticField === "like_count"), undefined);
  assert.equal(executeVariableMapping(postMissingLike, likeMapping).status, "missing");
  assert.equal(executeVariableMapping(postMissingLike, likeMapping).value, "");

  const postNoNumLike = buildEngagementPost({
    likeAria: "Thích",
    commentText: "4 bình luận",
  });
  assert.equal(executeVariableMapping(postNoNumLike, likeMapping).status, "needs_attention");
  assert.equal(executeVariableMapping(postNoNumLike, likeMapping).value, "");

  // 6: Conflicting engagement candidates -> Needs Attention with conflict diagnostics
  const postAmbiguous = buildEngagementPost({
    likeAria: "Thích: 5 người",
    extraLikeCandidate: true,
  });
  const ambItems = extractParentData(postAmbiguous, { postId: "29327016206983816" });
  const ambLike = ambItems.find((i) => i.semanticField === "like_count");
  assert.equal(ambLike?.extractionStatus, "needs_attention");
  assert.match(ambLike?.label || "", /5, 99/);
  assert.ok((ambLike?.sourcePaths.length ?? 0) > 1);
  assert.equal(parseEngagementNumber("no numbers here"), null);
});

test("DOM fixture: live-like Facebook nested wrappers & reaction toolbar + total sibling resolve uniquely (5/4/2)", () => {
  const liveLikePost = el("div", {}, [
    el("div", {}, [
      el("a", { href: "/user/1/" }, ["Author Name"]),
      el("a", { href: "?id=29327016206983816", "aria-describedby": "ts-live" }, ["2h"]),
      el("span", { id: "ts-live", hidden: "" }, ["14 tháng 11, 2026 lúc 10:30"]),
    ]),
    el("div", {}, [el("span", {}, ["Post content here"])]),
    // Engagement summary bar mirroring live Facebook DOM
    el("div", {}, [
      el("div", {}, [
        el("span", { role: "toolbar" }, [
          el("div", { role: "button", "aria-label": "Thích: 3 người" }, []),
          el("div", { role: "button", "aria-label": "Yêu thích: 2 người" }, []),
        ]),
        el("div", { role: "button" }, [el("span", {}, [el("span", {}, ["5"])])]),
      ]),
      el("div", { role: "button", "aria-label": "4 bình luận" }, [
        el("span", {}, [el("span", {}, ["4 bình luận"])]),
      ]),
      el("div", { role: "button" }, [
        el("span", {}, [el("span", {}, ["2 lượt chia sẻ"])]),
      ]),
    ]),
    el("div", {}, [
      el("div", { role: "button" }, ["Like"]),
      el("div", { role: "button" }, ["Comment"]),
      el("div", { role: "button" }, ["Share"]),
    ]),
    el("div", { role: "article" }, [
      el("div", {}, ["Comment body with 99 likes"]),
      el("div", { role: "button", "aria-label": "Thích: 10 người" }, ["10"]),
    ]),
  ]) as unknown as Element;

  const items = extractParentData(liveLikePost, { postId: "29327016206983816" });
  const likes = items.find((i) => i.semanticField === "like_count");
  const comments = items.find((i) => i.semanticField === "comment_count");
  const shares = items.find((i) => i.semanticField === "share_count");

  assert.equal(likes?.extractionStatus, "verified");
  assert.equal(likes?.value, "5");
  assert.equal(likes?.sourcePaths.length, 1);

  assert.equal(comments?.extractionStatus, "verified");
  assert.equal(comments?.value, "4");
  assert.equal(comments?.sourcePaths.length, 1);

  assert.equal(shares?.extractionStatus, "verified");
  assert.equal(shares?.value, "2");
  assert.equal(shares?.sourcePaths.length, 1);
});

test("Variable sidebar registry: always-visible Manage Variables, UiPopover drawer, BrowserCore hide/restore & CRUD", () => {
  const ui = explorer();
  // Always-visible Manage Variables button in header, independent of selectedData
  const headerLine = ui.split("\n").find((l) => l.includes("pdc-section-header")) || "";
  assert.match(headerLine, /Manage Variables/);
  assert.match(ui, /<UiPopover variant="drawer" label="Manage Variables"/);
  assert.match(ui, /className="variables-drawer pdc-variables-drawer"/);
  assert.match(ui, /!browserCollapsed && !variablesOpen/);

  const mem: Record<string, string> = {};
  const storage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => {
      mem[k] = v;
    },
  };

  const collector = ensureDefaultCollector(storage);
  assert.ok(collector);
  const created = addRegistryVariable(collector.id, { label: "Likes Count", key: "like_count", valueType: "number" }, storage);
  assert.ok(created);
  assert.equal(created.valueType, "number");
  assert.ok(listRegistryVariables(storage).some((v) => v.id === created.id && v.key === "like_count"));

  const mappings: PostDetailDomVariableMapping[] = [
    {
      collectorId: collector.id,
      variableId: created.id,
      variableKey: created.key,
      variableLabel: created.label,
      method: "DOM_ATTRIBUTE_NUMBER",
      attribute: "aria-label",
      relativePath: [2, 0, 0],
      relativeXPath: "./*[3]/*[1]/*[1]",
      preview: "5",
      confirmed: true,
      updatedAt: "2026-11-14T00:00:00Z",
    },
  ];

  // Renaming label preserves mapping
  const renamed = updateRegistryVariable(collector.id, created.id, { label: "Total Likes" }, mappings, storage);
  assert.equal(renamed.ok, true);
  assert.equal(renamed.mappings.length, 1);
  assert.equal(renamed.mappings[0].variableLabel, "Total Likes");

  // Deleting variable cleans up mappings
  const deleted = deleteRegistryVariable(collector.id, created.id, renamed.mappings, storage);
  assert.equal(deleted.ok, true);
  assert.equal(deleted.mappings.length, 0);
  assert.equal(listRegistryVariables(storage).some((v) => v.id === created.id), false);
});

test("like_count does not capture nested comment (4) or share (2) numeric leaves when toolbar sibling exists", () => {
  const root = el("div", {}, [
    el("div", {}, [
      el("a", { href: "?id=555", "aria-describedby": "ts-555" }, ["1h"]),
      el("span", { id: "ts-555", hidden: "" }, ["14 tháng 11, 2026 lúc 10:00"]),
    ]),
    el("div", { "data-ad-preview": "message" }, ["Post body"]),
    el("div", {}, [
      el("div", {}, [
        el("span", { role: "toolbar" }, [
          el("div", { role: "button", "aria-label": "Thích: 3 người" }, []),
          el("div", { role: "button", "aria-label": "Yêu thích: 2 người" }, []),
        ]),
        el("span", {}, [el("span", {}, ["5"])]),
      ]),
      el("div", {}, [
        el("div", { role: "button" }, [el("span", {}, ["4"]), el("span", {}, [" bình luận"])]),
        el("div", { role: "button" }, [el("span", {}, ["2"]), el("span", {}, [" lượt chia sẻ"])]),
      ]),
    ]),
    el("div", {}, [
      el("div", { role: "button", "aria-label": "Thích" }, ["Thích"]),
      el("div", { role: "button", "aria-label": "Bình luận" }, ["Bình luận"]),
      el("div", { role: "button", "aria-label": "Chia sẻ" }, ["Chia sẻ"]),
    ]),
  ]);

  const items = extractParentData(root as unknown as Element);
  const like = items.find((f) => f.semanticField === "like_count");
  const comment = items.find((f) => f.semanticField === "comment_count");
  const share = items.find((f) => f.semanticField === "share_count");

  assert.equal(like?.extractionStatus, "verified");
  assert.equal(like?.value, "5");
  assert.equal(comment?.extractionStatus, "verified");
  assert.equal(comment?.value, "4");
  assert.equal(share?.extractionStatus, "verified");
  assert.equal(share?.value, "2");
});

test("parseBatchUrls trims, deduplicates, accepts valid FB/Threads URLs, and flags invalid URLs", () => {
  const input = [
    "  https://www.facebook.com/groups/seovamarketing/posts/29327016206983816/  ",
    "https://www.facebook.com/groups/seovamarketing/posts/29327016206983816/",
    "https://www.facebook.com/permalink.php?story_fbid=123456&id=789",
    "https://www.threads.com/@user1/post/ABCdef123",
    "https://example.com/not-facebook",
    "not-a-url",
  ].join("\n");

  const parsed = parseBatchUrls(input);
  assert.equal(parsed.duplicateCount, 1);
  assert.equal(parsed.items.length, 5);
  assert.equal(parsed.items[0]?.valid, true);
  assert.equal(parsed.items[0]?.postId, "29327016206983816");
  assert.equal(parsed.items[1]?.valid, true);
  assert.equal(parsed.items[1]?.postId, "123456");
  assert.equal(parsed.items[2]?.valid, true);
  assert.equal(parsed.items[2]?.platform, "threads");
  assert.equal(parsed.items[3]?.valid, false);
  assert.equal(parsed.items[4]?.valid, false);
});

test("evaluateMatchedParentDom returns PASS, REVIEW, or FAILED without reusing preview values", () => {
  const root = el("div", {}, [
    el("div", {}, [
      el("h3", {}, [el("a", { href: "/anh.tho" }, ["Anh Tho"])]),
      el("a", { href: "?id=100", "aria-describedby": "ts-100" }, ["1h"]),
      el("span", { id: "ts-100", hidden: "" }, ["14 tháng 11, 2026 lúc 10:00"]),
    ]),
    el("div", { "data-ad-preview": "message" }, ["Hello world"]),
    el("div", {}, [
      el("div", {}, [
        el("span", {}, [el("span", {}, ["9"])]),
        el("div", {}, [el("div", { role: "button" }, ["3 bình luận"])]),
      ]),
      el("div", { role: "toolbar" }, [el("div", { role: "button", "aria-label": "Thích" }, ["Thích"])]),
    ]),
  ]);

  const mappings: PostDetailDomVariableMapping[] = [
    {
      collectorId: "post_detail_collector",
      variableId: "v_author",
      variableKey: "author",
      variableLabel: "Author",
      relativePath: [0, 0, 0],
      relativeXPath: ".//h3//a",
      method: "DOM_TEXT",
      preview: "OLD_SAMPLE_PREVIEW_AUTHOR",
      sourceSemantic: undefined,
      confirmed: true,
      updatedAt: "2026-11-14T00:00:00.000Z",
    },
    {
      collectorId: "post_detail_collector",
      variableId: "v_like",
      variableKey: "like",
      variableLabel: "Like",
      relativePath: [2, 0, 0, 0],
      relativeXPath: "",
      method: "DOM_TEXT_NUMBER",
      preview: "9999",
      sourceSemantic: "like_count",
      confirmed: true,
      updatedAt: "2026-11-14T00:00:00.000Z",
    },
  ];
  const registryVariables = [
    { collectorId: "post_detail_collector", collectorName: "Post Detail Collector", id: "v_author", key: "author", label: "Author", valueType: "string" as const, required: true },
    { collectorId: "post_detail_collector", collectorName: "Post Detail Collector", id: "v_like", key: "like", label: "Like", valueType: "number" as const, required: false },
  ];

  const passRow = evaluateMatchedParentDom({
    url: "https://www.facebook.com/groups/g/posts/100/",
    resolvedUrl: "https://www.facebook.com/groups/g/posts/100/",
    postId: "100",
    resolution: {
      status: "PARENT_MATCHED",
      innerHTML: "<div>...</div>",
      rect: null,
      diagnostics: [],
    },
    rootElement: root as unknown as Element,
    mappings,
    registryVariables,
  });
  assert.equal(passRow.status, "PASS");
  const authorField = passRow.fields.find((f) => f.variableKey === "author");
  const likeField = passRow.fields.find((f) => f.variableKey === "like");
  assert.equal(authorField?.value, "Anh Tho");
  assert.notEqual(authorField?.value, "OLD_SAMPLE_PREVIEW_AUTHOR");
  assert.equal(likeField?.value, "9");

  const failedRow = evaluateMatchedParentDom({
    url: "https://www.facebook.com/groups/g/posts/101/",
    resolvedUrl: "https://www.facebook.com/groups/g/posts/101/",
    postId: "101",
    resolution: {
      status: "REMATCH_REQUIRED",
      failureCode: "ACTION_ROW_SELECTOR_NOT_FOUND",
      innerHTML: "",
      rect: null,
      diagnostics: ["Action Row not found"],
    },
    rootElement: null,
    mappings,
    registryVariables,
  });
  assert.equal(failedRow.status, "FAILED");
  assert.equal(failedRow.passedCount, 0);

  const reviewRow = evaluateMatchedParentDom({
    url: "https://www.facebook.com/groups/g/posts/102/",
    resolvedUrl: "https://www.facebook.com/groups/g/posts/102/",
    postId: "102",
    resolution: {
      status: "PARENT_MATCHED",
      innerHTML: "<div>...</div>",
      rect: null,
      diagnostics: [],
    },
    rootElement: root as unknown as Element,
    mappings: [mappings[0]],
    registryVariables: [
      ...registryVariables,
      { collectorId: "post_detail_collector", collectorName: "Post Detail Collector", id: "v_req_content", key: "content", label: "Content", valueType: "string" as const, required: true },
    ],
  });
  assert.equal(reviewRow.status, "REVIEW");
  assert.equal(reviewRow.fields.some((f) => f.variableKey === "content" && f.status === "REVIEW"), true);
});

test("Step 3 Auto Save & Step 4 Batch Validation state persistence and UI controls", () => {
  setPostDetailCollectorState({ batchUrlsText: "https://www.facebook.com/groups/g/posts/1/" });
  setPostDetailCollectorState((prev) => ({
    batchConfigVersion: prev.batchConfigVersion + 1,
    step: 4,
  }));
  const state = getPostDetailCollectorState();
  assert.equal(state.batchUrlsText, "https://www.facebook.com/groups/g/posts/1/");
  assert.equal(state.step, 4);

  const pageSrc = readFileSync("src/renderer/post-detail-collector/PostDetailCollectorPage.tsx", "utf8");
  const step4Src = readFileSync("src/renderer/post-detail-collector/BatchValidationStep.tsx", "utf8");
  assert.match(pageSrc, /Batch Validation/);
  assert.match(pageSrc, /<BatchValidationStep/);
  assert.match(step4Src, /cancelRef/);
  assert.match(step4Src, /Copy JSON/);
  assert.match(step4Src, /Open in BrowserCore/);
  assert.match(step4Src, /Customize in Step 3/);
  assert.match(step4Src, /batchValidatedVersion !== batchConfigVersion/);
});

test("created_at permalink anchor exposes both raw_display and href outputs for multi-variable mapping", () => {
  const root = el("div", {}, [
    el("div", {}, [
      el("a", { href: "/groups/seo/posts/123456/", "aria-describedby": "ts-multi" }, ["2h"]),
      el("span", { id: "ts-multi", hidden: "" }, ["14 tháng 11, 2026 lúc 10:44"]),
    ]),
    el("div", {}, [el("span", {}, ["Body text"])]),
  ]) as unknown as Element;

  const items = extractParentData(root, {
    postId: "123456",
    currentUrl: "https://www.facebook.com/groups/seo/posts/123456/",
  });
  const created = items.find((i) => i.semanticField === "created_at");
  assert.ok(created);
  assert.equal(created.outputs.some((o) => o.key === "raw_display" && o.value === "14 tháng 11, 2026 lúc 10:44"), true);
  assert.equal(created.outputs.some((o) => o.key === "href" && o.value === "https://www.facebook.com/groups/seo/posts/123456/"), true);
});
