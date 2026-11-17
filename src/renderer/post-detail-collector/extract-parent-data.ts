import type { PostDetailDomVariableMapping, PostDetailExtractionMethod, PostImageEntry } from "./types";
import type { PostDetailDomAnchorRecord, PostDetailEngagementOcrResult } from "../../shared/post-detail-collector/types";

export type ExtractedDataContext = "post" | "comment" | "unknown";
export type ExtractedDataKind = "text" | "link" | "image" | "media" | "datetime" | "content" | "engagement" | "attribute";
export type ExtractedOutput = { key: "text" | "href" | "src" | "raw_display" | "normalized_value" | "content_text" | "content_html" | "count" | "images" | "attribute"; label: string; value: string; method: PostDetailExtractionMethod; attribute?: string };
export type ExtractedDataItem = {
  id: string; kind: ExtractedDataKind; value: string; label?: string; attribute?: string;
  predictedType?: "text" | "url" | "image" | "datetime" | "number" | "array"; semanticField?: "created_at" | "content" | "like_count" | "comment_count" | "share_count" | "post_images";
  context: ExtractedDataContext; confidence: "high" | "medium" | "low"; extractionStatus: "verified" | "needs_attention";
  sourceAttribute?: string; normalizedValue?: string; contentHtml?: string; hiddenByDefault?: boolean; hiddenReason?: string;
  mediaItems?: PostImageEntry[];
  outputs: ExtractedOutput[]; sourcePaths: number[][]; relativeXPath?: string;
  engagementEvidence?: {
    actionAnchorStatus: "VERIFIED" | "MISSING" | "STALE";
    countSourceStatus: "VERIFIED" | "AMBIGUOUS" | "MISSING";
    method: "DOM_TEXT" | "DOM_ATTRIBUTE" | "STRUCTURAL_RELATION" | "NONE";
    reason: string;
  };
};
export type ExecutedVariableMapping = {
  mapping: PostDetailDomVariableMapping;
  value: string;
  status: "mapped" | "needs_attention" | "missing";
  reason?: string;
};

type ExtractionOptions = {
  postId?: string;
  currentUrl?: string;
  domAnchors?: Partial<Record<"like_anchor" | "comment_anchor" | "share_anchor", PostDetailDomAnchorRecord>>;
  engagementResult?: PostDetailEngagementOcrResult;
};
const clean = (value: string | null | undefined) => (value || "").replace(/[\u034f\u200b-\u200f\u2060\ufeff]/g, "").replace(/\s+/g, " ").trim();
const pathKey = (path: number[]) => path.join("/");
export const relativeXPathForPath = (path: number[]) => `.${path.map(index => `/*[${index + 1}]`).join("")}`;
const meaningfulText = (value: string) => /^\d+$/.test(value) || value.replace(/[^\p{L}\p{N}]/gu, "").length >= 2;
const structurallyHidden = (element: Element) => {
  const style = (element.getAttribute("style") || "").replace(/\s+/g, "").toLowerCase();
  return element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true" || style.includes("display:none") || style.includes("visibility:hidden");
};
const isComment = (element: Element, root: Element) => {
  for (let current: Element | null = element; current && current !== root; current = current.parentElement) if (current.getAttribute("role") === "article" || current.tagName.toLowerCase() === "article") return true;
  return false;
};
const contextFor = (element: Element, root: Element): ExtractedDataContext => isComment(element, root) ? "comment" : root.contains(element) ? "post" : "unknown";
const elementPath = (element: Element, root: Element) => {
  const path: number[] = [];
  for (let current: Element | null = element; current && current !== root; current = current.parentElement) {
    const parent: Element | null = current.parentElement; if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.children, current));
  }
  return path;
};
const elementAtPath = (root: Element, path: number[]): Element | null => {
  let node: Element | null = root;
  for (const index of path) node = node?.children.item(index) || null;
  return node;
};
const resolveUrl = (href: string, currentUrl?: string) => {
  if (!href || !currentUrl) return href;
  try { return new URL(href, currentUrl).href; } catch { return href; }
};
const resolveDescribedBy = (root: Element, idAttr: string | null): { status: "ok"; text: string } | { status: "missing" | "ambiguous" } => {
  const ids = (idAttr || "").trim().split(/\s+/).filter(Boolean);
  if (!ids.length) return { status: "missing" };
  const allWithId = Array.from(root.querySelectorAll("[id]"));
  const texts: string[] = [];
  for (const id of ids) {
    const matches = allWithId.filter(element => element.id === id);
    if (matches.length === 0) return { status: "missing" };
    if (matches.length > 1) return { status: "ambiguous" };
    if (isComment(matches[0], root)) return { status: "missing" };
    const text = clean(matches[0].textContent);
    if (text) texts.push(text);
  }
  const combined = texts.join(" ").trim();
  return combined ? { status: "ok", text: combined } : { status: "missing" };
};

function findPrimaryTimestampAnchor(root: Element, options: ExtractionOptions) {
  const candidates = Array.from(root.querySelectorAll("a[href]")).filter(anchor => {
    if (isComment(anchor, root)) return false;
    const href = anchor.getAttribute("href") || "";
    if (/([?&])(comment_id|reply_comment_id)=/.test(href)) return false;
    const hasPostIdentity = Boolean(options.postId && href.includes(options.postId));
    const isPermalink = hasPostIdentity || href.startsWith("?") || href.includes("/posts/") || href.includes("/permalink/");
    return Boolean(anchor.hasAttribute("aria-describedby") && isPermalink);
  });
  return candidates.length === 1 ? candidates[0] : null;
}
function commonAncestor(left: Element, right: Element, root: Element) {
  const rightAncestors = new Set<Element>();
  for (let node: Element | null = right; node; node = node.parentElement) rightAncestors.add(node);
  for (let node: Element | null = left; node; node = node.parentElement) if (rightAncestors.has(node) && root.contains(node)) return node;
  return null;
}
function branchUnder(node: Element, ancestor: Element) { let branch = node; while (branch.parentElement && branch.parentElement !== ancestor) branch = branch.parentElement; return branch.parentElement === ancestor ? branch : null; }
function directControlBranches(node: Element) {
  return Array.from(node.children).filter(child =>
    child.tagName.toLowerCase() === "button" || child.getAttribute("role") === "button" || Boolean(child.querySelector("button,[role='button']")),
  );
}
function firstPostControlCluster(root: Element, after: Element) {
  const controls = Array.from(root.querySelectorAll("button,[role='button']")).filter(control => !isComment(control, root) && Boolean(after.compareDocumentPosition(control) & 4));
  const candidates = new Set<Element>();
  for (const control of controls) {
    for (let node: Element | null = control.parentElement; node && node !== root; node = node.parentElement) {
      if (node.querySelector("[role='article'],article") || node.querySelector("[role='toolbar']") || node.getAttribute("role") === "toolbar") continue;
      if (directControlBranches(node).length >= 3) candidates.add(node);
    }
  }
  return Array.from(candidates).sort((left, right) =>
    left.querySelectorAll("*").length - right.querySelectorAll("*").length,
  )[0] || null;
}
function findPostContentRoots(root: Element, timestampAnchor: Element) {
  const boundary = firstPostControlCluster(root, timestampAnchor) || root.querySelector("[role='article'],article"); if (!boundary) return null;
  const scope = commonAncestor(timestampAnchor, boundary, root); if (!scope) return null;
  const headerBranch = branchUnder(timestampAnchor, scope), boundaryBranch = branchUnder(boundary, scope); if (!headerBranch || !boundaryBranch) return null;
  const children = Array.from(scope.children), start = children.indexOf(headerBranch), end = children.indexOf(boundaryBranch); if (start < 0 || end <= start) return null;
  const candidates = children.slice(start + 1, end).filter(element => !element.querySelector("[role='article'],article") && !element.querySelector("button,[role='button']") && meaningfulText(clean(element.textContent)));
  return candidates.length ? candidates : null;
}
function contentText(root: Element) {
  const chunks: string[] = [], blockTags = new Set(["DIV", "P", "H1", "H2", "H3", "H4", "LI", "UL", "OL", "SECTION", "ARTICLE"]);
  const newline = () => { if (chunks.length && chunks[chunks.length - 1] !== "\n") chunks.push("\n"); };
  const walk = (node: Node) => {
    if (node.nodeType === 3) { const value = clean(node.textContent); if (value) chunks.push(value); return; }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = element.tagName.toUpperCase();
    if (structurallyHidden(element) || ["SCRIPT", "STYLE", "SVG", "BUTTON"].includes(tag) || element.getAttribute("role") === "button" || isComment(element, root)) return;
    if (tag === "BR") { newline(); return; }
    const block = blockTags.has(tag); if (block) newline(); if (tag === "LI") chunks.push("• ");
    Array.from(element.childNodes).forEach(walk); if (block) newline();
  };
  Array.from(root.childNodes).forEach(walk);
  return chunks.join(" ").replace(/ *\n */g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
function limitedContentHtml(element: Element) {
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll("script,style,svg,button,[role='button'],[role='article'],article,[aria-hidden='true'],[hidden]").forEach(node => node.remove());
  Array.from(clone.querySelectorAll("*")).forEach(node => { if (structurallyHidden(node)) node.remove(); });
  return clone.innerHTML.trim();
}
function contentRangeText(elements: Element[]) {
  return elements.map(contentText).filter(Boolean).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
function contentRangeHtml(elements: Element[]) {
  return elements.map(element => limitedContentHtml(element)).filter(Boolean).join("\n").trim();
}

type EngagementField = "like_count" | "comment_count" | "share_count";
type EngagementCandidate = { field: EngagementField; value: string; method: "DOM_TEXT_NUMBER" | "DOM_ATTRIBUTE_NUMBER"; attribute?: string; element: Element };
const ENGAGEMENT_LABELS: Record<EngagementField, string> = { like_count: "Likes", comment_count: "Comments", share_count: "Shares" };
const ENGAGEMENT_ANCHOR_ROLE: Record<EngagementField, "like_anchor" | "comment_anchor" | "share_anchor"> = {
  like_count: "like_anchor",
  comment_count: "comment_anchor",
  share_count: "share_anchor",
};

export function parseEngagementNumber(raw: string | null | undefined): number | null {
  const text = clean(raw);
  if (!text) return null;
  const match = text.match(/(?:^|[^\d])(\d+(?:[.,]\d+)?)\s*(k|m|b|nghìn|ngàn|triệu|tỷ)?(?=$|[^\p{L}\d])/iu);
  if (!match) return null;
  const numStr = match[1];
  const suffix = (match[2] || "").toLowerCase();
  const multiplier = suffix === "k" || suffix === "nghìn" || suffix === "ngàn" ? 1_000 : suffix === "m" || suffix === "triệu" ? 1_000_000 : suffix === "b" || suffix === "tỷ" ? 1_000_000_000 : 1;
  let numeric: number;
  if (multiplier === 1 && /^\d{1,3}(?:[.,]\d{3})+$/.test(numStr)) {
    numeric = Number(numStr.replace(/[.,]/g, ""));
  } else {
    numeric = Number(numStr.replace(",", ".")) * multiplier;
  }
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric);
}

function findActionRowCluster(root: Element, timestampAnchor: Element | null): Element | null {
  if (timestampAnchor) return firstPostControlCluster(root, timestampAnchor);
  const firstComment = root.querySelector("[role='article'],article");
  const controls = Array.from(root.querySelectorAll("button,[role='button']")).filter(control =>
    !isComment(control, root) &&
    (!firstComment || Boolean(control.compareDocumentPosition(firstComment) & 4)),
  );
  let lastValidRow: Element | null = null;
  for (const control of controls) {
    for (let node: Element | null = control.parentElement; node && node !== root; node = node.parentElement) {
      if (node.querySelector("[role='article'],article") || node.querySelector("[role='toolbar']") || node.getAttribute("role") === "toolbar") continue;
      if (directControlBranches(node).length >= 3) {
        lastValidRow = node;
        break;
      }
    }
  }
  return lastValidRow;
}

const SHARE_RE = /(?:^|\P{L})(shares?|chia\s*sẻ|reposts?)(?=\P{L}|$)/iu;
const COMMENT_RE = /(?:^|\P{L})(comments?|bình\s*luận|phản\s*hồi|replies|reply)(?=\P{L}|$)/iu;
const LIKE_RE = /(?:^|\P{L})(likes?|reacts?|reactions?|thích|cảm\s*xúc|người\s*khác|others?)(?=\P{L}|$)/iu;

function isInsideToolbar(el: Element, root: Element): boolean {
  for (let cur: Element | null = el; cur && cur !== root; cur = cur.parentElement) {
    if (cur.getAttribute("role") === "toolbar") return true;
  }
  return false;
}

function isToolbarReactionTotalSibling(el: Element, root: Element): boolean {
  let cur: Element | null = el;
  for (let depth = 0; depth < 3 && cur && cur !== root; depth++, cur = cur.parentElement) {
    const curLabel = `${clean(cur.getAttribute("aria-label"))} ${clean(cur.textContent)}`;
    if (SHARE_RE.test(curLabel) || COMMENT_RE.test(curLabel)) return false;
    const container = cur.parentElement;
    if (!container || container === root) break;
    const containerLabel = `${clean(container.getAttribute("aria-label"))} ${clean(container.textContent)}`;
    const hasDirectSiblingToolbar = Array.from(container.children).some(
      child => child !== cur && child.getAttribute("role") === "toolbar",
    );
    if (hasDirectSiblingToolbar) return true;
    if (SHARE_RE.test(containerLabel) || COMMENT_RE.test(containerLabel)) return false;
  }
  return false;
}

function classifyEngagementField(el: Element, root: Element): EngagementField | null {
  const aria = clean(el.getAttribute("aria-label"));
  const text = clean(el.textContent);
  const combined = `${aria} ${text}`.trim();
  if (SHARE_RE.test(combined)) return "share_count";
  if (COMMENT_RE.test(combined)) return "comment_count";
  if (LIKE_RE.test(combined)) return "like_count";
  if (isInsideToolbar(el, root) || isToolbarReactionTotalSibling(el, root)) return "like_count";
  return null;
}

const ENGAGEMENT_NUMBER_TOKEN = String.raw`\d+(?:[.,]\d+)?\s*(?:k|m|b|nghìn|ngàn|triệu|tỷ)?`;
const ENGAGEMENT_FIELD_LABEL: Record<EngagementField, string> = {
  like_count: String.raw`likes?|reacts?|reactions?|thích|cảm\s*xúc|người\s*khác|others?`,
  comment_count: String.raw`comments?|bình\s*luận|phản\s*hồi|replies|reply`,
  share_count: String.raw`shares?|chia\s*sẻ|reposts?`,
};
function parseSemanticEngagementNumber(raw: string | null | undefined, field: EngagementField): number | null {
  const text = clean(raw);
  if (!text) return null;
  const label = ENGAGEMENT_FIELD_LABEL[field];
  const before = new RegExp(`(?:^|\\P{L})(${ENGAGEMENT_NUMBER_TOKEN})\\s*(?:lượt\\s*)?(?:${label})(?=\\P{L}|$)`, "iu").exec(text);
  const after = new RegExp(`(?:^|\\P{L})(?:${label})(?=\\P{L}|$)[^\\d]{0,12}(${ENGAGEMENT_NUMBER_TOKEN})`, "iu").exec(text);
  return parseEngagementNumber(before?.[1] || after?.[1]);
}

function candidatePriority(item: EngagementCandidate): number {
  const tag = item.element.tagName.toLowerCase();
  const interactive = tag === "button" || tag === "a" || item.element.getAttribute("role") === "button";
  return (interactive ? 4 : 0) + (item.attribute ? 2 : 0);
}

function collapseEngagementCandidates(field: EngagementField, rawList: EngagementCandidate[], root: Element): EngagementCandidate[] {
  if (rawList.length <= 1) return rawList;
  let list = rawList;
  // For like_count: if a total summary exists outside [role="toolbar"] (e.g. sibling "5" next to reaction icons),
  // prefer the total summary over individual reaction icons inside [role="toolbar"].
  if (field === "like_count") {
    const insideToolbar = list.filter(c => isInsideToolbar(c.element, root));
    const outsideToolbar = list.filter(c => !isInsideToolbar(c.element, root));
    const outsideValues = new Set(outsideToolbar.map(c => c.value));
    if (outsideValues.size === 1 && insideToolbar.length > 0 && (insideToolbar.length >= 2 || outsideToolbar[0].value === insideToolbar[0].value)) {
      list = outsideToolbar;
    }
  }
  // Collapse nested ancestor/descendant duplicates with the same value, and same-value summary siblings.
  const byValue = new Map<string, EngagementCandidate[]>();
  for (const item of list) {
    const group = byValue.get(item.value) || [];
    group.push(item);
    byValue.set(item.value, group);
  }
  const collapsed: EngagementCandidate[] = [];
  for (const group of byValue.values()) {
    const best = group.slice().sort((a, b) => candidatePriority(b) - candidatePriority(a))[0];
    collapsed.push(best);
  }
  return collapsed;
}

function anchorMatchesRecord(element: Element, record: PostDetailDomAnchorRecord): boolean {
  const signature = record.structuralSignature || {};
  return (
    (!signature.tag || element.tagName === signature.tag) &&
    (!signature.role || element.getAttribute("role") === signature.role) &&
    (!Number.isInteger(signature.childCount) || element.children.length === signature.childCount) &&
    (!Number.isInteger(signature.svgCount) || element.querySelectorAll("svg").length === signature.svgCount)
  );
}

function numericSourcesWithin(element: Element): Array<{ element: Element; value: string; method: "DOM_TEXT_NUMBER" | "DOM_ATTRIBUTE_NUMBER"; attribute?: string }> {
  const nodes = [element, ...Array.from(element.querySelectorAll("[aria-label],[title],[data-count],span"))];
  const out: Array<{ element: Element; value: string; method: "DOM_TEXT_NUMBER" | "DOM_ATTRIBUTE_NUMBER"; attribute?: string }> = [];
  for (const node of nodes) {
    if (structurallyHidden(node)) continue;
    for (const attribute of ["aria-label", "title", "data-count"] as const) {
      const raw = node.getAttribute(attribute);
      const value = parseEngagementNumber(raw);
      if (value !== null) out.push({ element: node, value: String(value), method: "DOM_ATTRIBUTE_NUMBER", attribute });
    }
    const direct = clean(Array.from(node.childNodes).filter(child => child.nodeType === 3).map(child => child.textContent).join(" "));
    const value = parseEngagementNumber(direct);
    if (value !== null) out.push({ element: node, value: String(value), method: "DOM_TEXT_NUMBER" });
  }
  const unique = new Map<string, (typeof out)[number]>();
  for (const item of out) unique.set(`${elementPath(item.element, element)?.join("/") || "root"}:${item.attribute || "text"}:${item.value}`, item);
  return Array.from(unique.values());
}

function resolveSavedCountSource(root: Element, record: PostDetailDomAnchorRecord) {
  const saved = record.countSource;
  if (saved.verificationStatus !== "VERIFIED" || !saved.parentRelativePath) return null;
  const element = elementAtPath(root, saved.parentRelativePath);
  if (!element || isComment(element, root)) return { status: "STALE" as const };
  const raw = saved.method === "DOM_ATTRIBUTE_NUMBER"
    ? element.getAttribute(saved.attribute || "aria-label")
    : element.textContent;
  const value = parseEngagementNumber(raw);
  return value === null
    ? { status: "STALE" as const }
    : { status: "VERIFIED" as const, element, value: String(value), method: saved.method || "DOM_TEXT_NUMBER", attribute: saved.attribute, relationship: saved.relationship };
}

function extractAnchorFirstEngagements(root: Element, options: ExtractionOptions): Map<EngagementField, ExtractedDataItem> {
  const results = new Map<EngagementField, ExtractedDataItem>();
  const anchors = options.domAnchors || {};
  const resolvedAnchors = new Map<EngagementField, Element>();
  for (const field of ["like_count", "comment_count", "share_count"] as EngagementField[]) {
    const record = anchors[ENGAGEMENT_ANCHOR_ROLE[field]];
    const element = record ? elementAtPath(root, record.parentRelativePath) : null;
    if (record && element && !isComment(element, root) && record.verificationStatus === "VERIFIED" && anchorMatchesRecord(element, record)) resolvedAnchors.set(field, element);
  }
  const resolvedNodes = new Set(resolvedAnchors.values());
  const resolvedList = Array.from(resolvedAnchors.values());
  const anchorRow = resolvedList.length >= 2
    ? resolvedList.slice(1).reduce<Element | null>((common, element) => common ? commonAncestor(common, element, root) : null, resolvedList[0])
    : null;
  const precedingSummaryRegions: Element[] = [];
  for (let node = anchorRow; node && node !== root; node = node.parentElement) {
    const siblings = node.parentElement ? Array.from(node.parentElement.children) : [];
    const index = siblings.indexOf(node);
    if (index > 0) precedingSummaryRegions.push(siblings[index - 1]);
    if (precedingSummaryRegions.length >= 3) break;
  }
  for (const field of ["like_count", "comment_count", "share_count"] as EngagementField[]) {
    const role = ENGAGEMENT_ANCHOR_ROLE[field];
    const record = anchors[role];
    if (!record) continue;
    const anchor = elementAtPath(root, record.parentRelativePath);
    const anchorVerified = resolvedAnchors.get(field) === anchor;
    const anchorStatus = !anchor ? "MISSING" as const : anchorVerified ? "VERIFIED" as const : "STALE" as const;
    const saved = resolveSavedCountSource(root, record);
    const local = anchorVerified && anchor ? numericSourcesWithin(anchor) : [];
    const sibling = anchorVerified && anchor?.parentElement
      ? Array.from(anchor.parentElement.children)
          .filter(element => element !== anchor && !resolvedNodes.has(element) && !Array.from(resolvedNodes).some(other => element.contains(other)))
          .flatMap(numericSourcesWithin)
      : [];
    const semanticSummary = precedingSummaryRegions.flatMap(region => Array.from(region.querySelectorAll("[aria-label],[title],button,[role='button'],span"))).flatMap(element => {
      if (classifyEngagementField(element, root) !== field) return [];
      const value = parseSemanticEngagementNumber(element.getAttribute("aria-label"), field) ?? parseSemanticEngagementNumber(element.textContent, field);
      return value === null ? [] : [{ element, value: String(value), method: element.getAttribute("aria-label") ? "DOM_ATTRIBUTE_NUMBER" as const : "DOM_TEXT_NUMBER" as const, attribute: element.getAttribute("aria-label") ? "aria-label" : undefined }];
    });
    const fieldIndex = (["like_count", "comment_count", "share_count"] as EngagementField[]).indexOf(field);
    const structuralSummary = precedingSummaryRegions.flatMap(region => {
      if (region.children.length !== 3) return [];
      const branches = Array.from(region.children).map(numericSourcesWithin);
      if (branches.some(items => new Set(items.map(item => item.value)).size !== 1)) return [];
      return branches[fieldIndex]?.slice(0, 1) || [];
    });
    const discovered = local.length ? local : sibling.length ? sibling : semanticSummary.length ? semanticSummary : structuralSummary;
    const values = new Set(discovered.map(item => item.value));
    const winner = saved?.status === "VERIFIED"
      ? saved
      : discovered.length && values.size === 1
        ? { status: "VERIFIED" as const, ...discovered[0], relationship: local.length ? "SAME_ELEMENT" as const : sibling.length ? "SIBLING" as const : "SUMMARY_REGION" as const }
        : null;
    const ambiguous = anchorVerified && !winner && values.size > 1;
    const source = winner?.element || anchor;
    const sourcePath = source ? elementPath(source, root) : null;
    const value = winner?.value || "";
    const countSourceStatus = winner ? "VERIFIED" as const : ambiguous ? "AMBIGUOUS" as const : "MISSING" as const;
    const reason = anchorStatus !== "VERIFIED"
      ? `Saved ${role} did not resolve uniquely with its structural signature.`
      : winner
        ? `Count resolved from the verified ${role} using ${winner.relationship}.`
        : ambiguous
          ? `Verified ${role} contains conflicting numeric sources: ${Array.from(values).join(", ")}.`
          : `Verified ${role} has no explicit numeric count source.`;
    results.set(field, {
      id: `${field}:anchor:${sourcePath?.join("/") || anchorStatus.toLowerCase()}`,
      kind: "engagement",
      value,
      label: ENGAGEMENT_LABELS[field],
      attribute: winner?.attribute,
      predictedType: "number",
      semanticField: field,
      context: "post",
      confidence: winner ? "high" : "low",
      extractionStatus: winner ? "verified" : "needs_attention",
      sourceAttribute: winner?.attribute,
      hiddenByDefault: false,
      outputs: [{ key: "count", label: "Count (number)", value, method: winner?.method || "DOM_TEXT_NUMBER", attribute: winner?.attribute }],
      sourcePaths: sourcePath ? [sourcePath] : [],
      relativeXPath: sourcePath ? relativeXPathForPath(sourcePath) : undefined,
      engagementEvidence: {
        actionAnchorStatus: anchorStatus,
        countSourceStatus,
        method: winner ? (winner.relationship === "SAME_ELEMENT" ? (winner.attribute ? "DOM_ATTRIBUTE" : "DOM_TEXT") : "STRUCTURAL_RELATION") : "NONE",
        reason,
      },
    });
  }
  return results;
}

function extractPostEngagements(root: Element, timestampAnchor: Element | null, contentRoots: Element[] | null, excludedRoots: Set<Element>, options: ExtractionOptions): ExtractedDataItem[] {
  const anchorFirst = extractAnchorFirstEngagements(root, options);
  const actionRow = findActionRowCluster(root, timestampAnchor);
  const firstComment = root.querySelector("[role='article'],article");
  const afterNode = contentRoots?.[contentRoots.length - 1] || timestampAnchor;
  if (!actionRow && !afterNode) return Array.from(anchorFirst.values());

  const isInEngagementZone = (el: Element): boolean => {
    if (isComment(el, root) || structurallyHidden(el)) return false;
    if (contentRoots?.some(contentRoot => el === contentRoot || contentRoot.contains(el))) return false;
    if (timestampAnchor?.parentElement && (el === timestampAnchor.parentElement || timestampAnchor.parentElement.contains(el))) return false;
    if (afterNode && !(afterNode.compareDocumentPosition(el) & 4)) return false;
    if (firstComment && !(el.compareDocumentPosition(firstComment) & 4)) return false;
    if (actionRow && !(actionRow.contains(el) || (el.compareDocumentPosition(actionRow) & 4))) return false;
    return true;
  };

  const candidatesByField: Record<EngagementField, EngagementCandidate[]> = { like_count: [], comment_count: [], share_count: [] };
  const unclassifiedActionCounts: Array<{ element: Element; value: string }> = [];
  const allElements = Array.from(root.querySelectorAll("*")).filter(isInEngagementZone);

  for (const el of allElements) {
    const isInteractive = el.tagName.toLowerCase() === "button" || el.tagName.toLowerCase() === "a" || el.getAttribute("role") === "button" || el.hasAttribute("aria-label");
    const isLeafText = el.children.length === 0 && Boolean(clean(el.textContent));
    if (!isInteractive && !isLeafText) continue;

    const field = classifyEngagementField(el, root);
    if (!field) {
      if (actionRow?.contains(el)) {
        const raw = parseEngagementNumber(el.getAttribute("aria-label")) ?? parseEngagementNumber(el.textContent);
        if (raw !== null) unclassifiedActionCounts.push({ element: el, value: String(raw) });
      }
      continue;
    }

    const structuralLikeTotal = field === "like_count" && (isInsideToolbar(el, root) || isToolbarReactionTotalSibling(el, root));
    const ariaNum = parseSemanticEngagementNumber(el.getAttribute("aria-label"), field);
    if (ariaNum !== null) {
      candidatesByField[field].push({ field, value: String(ariaNum), method: "DOM_ATTRIBUTE_NUMBER", attribute: "aria-label", element: el });
      continue;
    }
    const textNum = parseSemanticEngagementNumber(el.textContent, field) ?? (structuralLikeTotal ? parseEngagementNumber(el.textContent) : null);
    if (textNum !== null) {
      candidatesByField[field].push({ field, value: String(textNum), method: "DOM_TEXT_NUMBER", element: el });
    }
  }

  const results: ExtractedDataItem[] = [];
  for (const field of ["like_count", "comment_count", "share_count"] as EngagementField[]) {
    const deduped = collapseEngagementCandidates(field, candidatesByField[field], root);
    if (deduped.length === 0) {
      const unknownPaths = unclassifiedActionCounts.map(candidate => elementPath(candidate.element, root)).filter((path): path is number[] => Boolean(path));
      if (unknownPaths.length) {
        results.push({
          id: `${field}:unclassified:${unknownPaths.length}`,
          kind: "engagement",
          value: "",
          label: `${ENGAGEMENT_LABELS[field]} (Needs Attention: unlabeled numeric sources)`,
          predictedType: "number",
          semanticField: field,
          context: "post",
          confidence: "low",
          extractionStatus: "needs_attention",
          hiddenByDefault: false,
          outputs: [{ key: "count", label: "Count (number)", value: "", method: "DOM_TEXT_NUMBER" }],
          sourcePaths: unknownPaths,
        });
      }
      continue;
    }

    if (deduped.length === 1) {
      const winner = deduped[0];
      const path = elementPath(winner.element, root);
      if (!path) continue;
      excludedRoots.add(winner.element);
      results.push({
        id: `${field}:${pathKey(path)}`,
        kind: "engagement",
        value: winner.value,
        label: ENGAGEMENT_LABELS[field],
        attribute: winner.attribute,
        predictedType: "number",
        semanticField: field,
        context: "post",
        confidence: "high",
        extractionStatus: "verified",
        sourceAttribute: winner.attribute,
        hiddenByDefault: false,
        outputs: [{ key: "count", label: "Count (number)", value: winner.value, method: winner.method, attribute: winner.attribute }],
        sourcePaths: [path],
        relativeXPath: relativeXPathForPath(path),
      });
    } else {
      const paths = deduped.map(c => elementPath(c.element, root)).filter((p): p is number[] => Boolean(p));
      const conflictValues = deduped.map(c => c.value).join(", ");
      results.push({
        id: `${field}:ambiguous:${paths.length}`,
        kind: "engagement",
        value: "",
        label: `${ENGAGEMENT_LABELS[field]} (Needs Attention: ${conflictValues})`,
        predictedType: "number",
        semanticField: field,
        context: "post",
        confidence: "low",
        extractionStatus: "needs_attention",
        hiddenByDefault: false,
        outputs: [{ key: "count", label: "Count (number)", value: "", method: deduped[0].method, attribute: deduped[0].attribute }],
        sourcePaths: paths,
      });
    }
  }
  for (const [field, item] of anchorFirst) {
    const legacyIndex = results.findIndex(candidate => candidate.semanticField === field);
    if (legacyIndex >= 0) results.splice(legacyIndex, 1, item);
    else results.push(item);
  }
  return results;
}

function parseSrcsetHighest(srcset: string | null | undefined, currentUrl?: string): { url: string; width: number } | null {
  if (!srcset) return null;
  let best: { url: string; width: number } | null = null;
  for (const part of srcset.split(",")) {
    const tokens = part.trim().split(/\s+/);
    const rawUrl = tokens[0];
    if (!rawUrl || rawUrl.startsWith("data:")) continue;
    const descriptor = tokens[1] || "";
    const wMatch = /^(\d+)w$/i.exec(descriptor);
    const xMatch = /^(\d+(?:\.\d+)?)x$/i.exec(descriptor);
    const score = wMatch ? Number(wMatch[1]) : xMatch ? Number(xMatch[1]) * 1000 : 1;
    const resolved = resolveUrl(rawUrl, currentUrl);
    if (!best || score > best.width) best = { url: resolved, width: score };
  }
  return best;
}

function extractCssBgUrl(style: string | null | undefined, currentUrl?: string): string {
  if (!style) return "";
  const match = /background-image\s*:\s*url\(\s*(['"]?)(.*?)\1\s*\)/i.exec(style);
  const raw = clean(match?.[2]);
  if (!raw || raw.startsWith("data:")) return "";
  return resolveUrl(raw, currentUrl);
}

function canonicalImageKey(url: string): string {
  try {
    const parsed = new URL(url, "https://www.facebook.com");
    const base = parsed.pathname.split("/").pop() || parsed.pathname;
    if (/(?:fbcdn\.net|scontent|fbsbx\.com)$/i.test(parsed.hostname) || /\.(?:jpe?g|png|webp|gif|avif)$/i.test(base)) {
      return base.toLowerCase();
    }
    return `${parsed.origin}${parsed.pathname}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function findAncestor(el: Element, root: Element, predicate: (node: Element) => boolean): Element | null {
  for (let cur: Element | null = el; cur && cur !== root; cur = cur.parentElement) {
    if (predicate(cur)) return cur;
  }
  return null;
}

function isNonPostImageUrlOrNode(el: Element, url: string, root: Element, actionRow: Element | null): boolean {
  if (!url || url.startsWith("data:image/svg+xml")) return true;
  if (/(?:rsrc\.php|emoji\.php|\/images\/emoji|\/reaction\/|\/stickers\/|\/images\/assets_DO_NOT_USE\/)/i.test(url)) return true;
  if (isComment(el, root) || structurallyHidden(el)) return true;
  if (actionRow && actionRow.contains(el)) return true;
  for (let cur: Element | null = el; cur && cur !== root; cur = cur.parentElement) {
    const tag = cur.tagName.toLowerCase();
    if (tag === "svg" || tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4") return true;
    const role = cur.getAttribute("role");
    if (role === "toolbar") return true;
    const meta = `${clean(cur.getAttribute("aria-label"))} ${clean(cur.getAttribute("data-testid"))} ${clean(cur.getAttribute("alt"))}`;
    if (/(?:avatar|profile\s*picture|ảnh\s*đại\s*diện|sticker|emoji|reaction)/i.test(meta)) return true;
  }
  const w = Number(el.getAttribute("width") || "");
  const h = Number(el.getAttribute("height") || "");
  const isPhotoLink = Boolean(
    findAncestor(el, root, (n) => n.tagName.toLowerCase() === "a" && /(?:\/photo|set=pcb|fbid=)/i.test(n.getAttribute("href") || "")),
  );
  if (((w > 0 && w <= 40) || (h > 0 && h <= 40)) && !isPhotoLink) {
    return true;
  }
  return false;
}

function resolveImageElementUrl(img: Element, currentUrl?: string): { url: string; quality: PostImageEntry["quality"]; sourceAttr: string } | null {
  const currentSrc = clean((img as HTMLImageElement).currentSrc);
  const picture = img.parentElement?.tagName.toLowerCase() === "picture" ? img.parentElement : null;
  let pictureBest: { url: string; width: number } | null = null;
  if (picture) {
    for (const source of Array.from(picture.querySelectorAll("source"))) {
      const candidate = parseSrcsetHighest(source.getAttribute("srcset"), currentUrl);
      if (candidate && (!pictureBest || candidate.width > pictureBest.width)) pictureBest = candidate;
    }
  }
  const srcsetBest = parseSrcsetHighest(img.getAttribute("srcset"), currentUrl);
  const bestSrcset = pictureBest && (!srcsetBest || pictureBest.width >= srcsetBest.width) ? pictureBest : srcsetBest;

  if (bestSrcset) {
    return { url: bestSrcset.url, quality: "high", sourceAttr: pictureBest === bestSrcset ? "picture/source" : "srcset" };
  }
  if (currentSrc && !currentSrc.startsWith("data:")) {
    return { url: resolveUrl(currentSrc, currentUrl), quality: "high", sourceAttr: "currentSrc" };
  }
  for (const attr of ["data-src", "data-lazy-src", "data-original", "src"]) {
    const raw = clean(img.getAttribute(attr));
    if (raw && !raw.startsWith("data:")) {
      return {
        url: resolveUrl(raw, currentUrl),
        quality: attr === "src" ? "standard" : "fallback",
        sourceAttr: attr,
      };
    }
  }
  return null;
}

function extractPostImages(root: Element, timestampAnchor: Element | null, contentRoots: Element[] | null, actionRow: Element | null, currentUrl?: string): ExtractedDataItem {
  const firstComment = root.querySelector("[role='article'],article");
  const isInPostMediaZone = (el: Element): boolean => {
    if (isComment(el, root) || structurallyHidden(el)) return false;
    if (timestampAnchor?.parentElement && (el === timestampAnchor.parentElement || timestampAnchor.parentElement.contains(el))) return false;
    if (actionRow && (actionRow.contains(el) || !(el.compareDocumentPosition(actionRow) & 4))) return false;
    if (timestampAnchor && !(timestampAnchor.compareDocumentPosition(el) & 4)) return false;
    if (firstComment && !(el.compareDocumentPosition(firstComment) & 4)) return false;
    return true;
  };

  const mediaItems: PostImageEntry[] = [];
  const seenKeys = new Set<string>();
  let hasUnresolvedMedia = false;

  const tryAddMedia = (el: Element, url: string, quality: PostImageEntry["quality"], sourceAttr: string) => {
    if (isNonPostImageUrlOrNode(el, url, root, actionRow)) return;
    const key = canonicalImageKey(url);
    if (seenKeys.has(key)) return;
    const path = elementPath(el, root);
    if (!path) return;
    const linkAncestor = findAncestor(el, root, (n) => n.tagName.toLowerCase() === "a" && Boolean(n.getAttribute("href")));
    const rawHref = clean(linkAncestor?.getAttribute("href"));
    const permalink = rawHref && /(?:\/photo|pcb\.|fbid=)/i.test(rawHref) ? resolveUrl(rawHref, currentUrl) : undefined;
    seenKeys.add(key);
    mediaItems.push({ url, sourcePath: path, quality, sourceAttr, permalink });
  };

  const allNodes = Array.from(root.querySelectorAll("*")).filter(isInPostMediaZone);
  for (const el of allNodes) {
    const tag = el.tagName.toLowerCase();
    if (tag === "img") {
      const resolved = resolveImageElementUrl(el, currentUrl);
      if (resolved) {
        tryAddMedia(el, resolved.url, resolved.quality, resolved.sourceAttr);
      } else if (
        el.hasAttribute("data-src") ||
        el.hasAttribute("data-lazy-src") ||
        Boolean(findAncestor(el, root, (n) => n.tagName.toLowerCase() === "a" && /(?:\/photo|set=pcb|fbid=)/i.test(n.getAttribute("href") || "")))
      ) {
        hasUnresolvedMedia = true;
      }
      continue;
    }
    const bgUrl = extractCssBgUrl(el.getAttribute("style"), currentUrl);
    if (bgUrl) {
      tryAddMedia(el, bgUrl, "standard", "background-image");
    } else if (
      tag === "a" &&
      /(?:\/photo|set=pcb|fbid=)/i.test(el.getAttribute("href") || "") &&
      !el.querySelector("img") &&
      !isComment(el, root)
    ) {
      hasUnresolvedMedia = true;
    }
  }

  const urls = mediaItems.map((m) => m.url);
  const paths = mediaItems.map((m) => m.sourcePath);
  const rootPath = contentRoots?.[0] ? elementPath(contentRoots[0], root) : [];
  const primaryPaths = paths.length > 0 ? paths : rootPath && rootPath.length ? [rootPath] : [[0]];
  const jsonValue = JSON.stringify(urls);

  if (mediaItems.length === 0 && hasUnresolvedMedia) {
    return {
      id: "post_images:needs_attention",
      kind: "media",
      value: "",
      label: "Post Images (Needs Attention)",
      predictedType: "array",
      semanticField: "post_images",
      context: "post",
      confidence: "low",
      extractionStatus: "needs_attention",
      hiddenByDefault: false,
      mediaItems: [],
      outputs: [{ key: "images", label: "Image URLs (array)", value: "", method: "POST_IMAGES" }],
      sourcePaths: [],
    };
  }

  return {
    id: "post_images:verified",
    kind: "media",
    value: jsonValue,
    label: `Post Images (${mediaItems.length})`,
    predictedType: "array",
    semanticField: "post_images",
    context: "post",
    confidence: "high",
    extractionStatus: "verified",
    hiddenByDefault: false,
    mediaItems,
    outputs: [{ key: "images", label: "Image URLs (array)", value: jsonValue, method: "POST_IMAGES" }],
    sourcePaths: primaryPaths,
    relativeXPath: paths.length === 1 ? relativeXPathForPath(paths[0]) : undefined,
  };
}

/** One DFS pass for generic values, plus verified semantic header/body boundaries. */
export function extractParentData(root: Element, options: ExtractionOptions = {}): ExtractedDataItem[] {
  const grouped = new Map<string, ExtractedDataItem>(), excludedRoots = new Set<Element>();
  const add = (item: Omit<ExtractedDataItem, "id" | "sourcePaths" | "relativeXPath">, path: number[]) => {
    const key = `${item.context}\u0000${item.semanticField || ""}\u0000${item.kind}\u0000${item.attribute || ""}\u0000${item.value}`, existing = grouped.get(key);
    if (existing) { if (!existing.sourcePaths.some(candidate => pathKey(candidate) === pathKey(path))) existing.sourcePaths.push(path); existing.relativeXPath = undefined; if (!existing.semanticField) { existing.hiddenByDefault = true; existing.hiddenReason = "duplicate"; } return; }
    grouped.set(key, { ...item, id: `${item.semanticField || item.kind}:${pathKey(path)}:${grouped.size}`, sourcePaths: path.length ? [path] : [], relativeXPath: path.length ? relativeXPathForPath(path) : undefined });
  };
  const timestampAnchor = findPrimaryTimestampAnchor(root, options);
  let contentRoots: Element[] | null = null;
  if (timestampAnchor) {
    const path = elementPath(timestampAnchor, root);
    const described = resolveDescribedBy(root, timestampAnchor.getAttribute("aria-describedby"));
    const tsHref = clean(timestampAnchor.getAttribute("href"));
    const tsAbsoluteHref = tsHref ? resolveUrl(tsHref, options.currentUrl) : "";
    const tsHrefOutput: ExtractedOutput[] = tsAbsoluteHref
      ? [{ key: "href", label: "URL", value: tsAbsoluteHref, method: "DOM_ATTRIBUTE", attribute: "href" }]
      : [];
    if (path && described.status === "ok") {
      add({ kind: "datetime", value: described.text, label: "Created at", predictedType: "datetime", semanticField: "created_at", context: "post", confidence: "high", extractionStatus: "verified", sourceAttribute: "aria-describedby", outputs: [{ key: "raw_display", label: "Raw display", value: described.text, method: "DOM_ATTRIBUTE_REF_TEXT", attribute: "aria-describedby" }, ...tsHrefOutput] }, path);
      if (timestampAnchor.parentElement) excludedRoots.add(timestampAnchor.parentElement);
    } else if (path) {
      add({ kind: "datetime", value: "", label: described.status === "ambiguous" ? "Created at (non-unique reference)" : "Created at (missing reference)", predictedType: "datetime", semanticField: "created_at", context: "post", confidence: "low", extractionStatus: "needs_attention", sourceAttribute: "aria-describedby", outputs: [{ key: "raw_display", label: "Raw display", value: "", method: "DOM_ATTRIBUTE_REF_TEXT", attribute: "aria-describedby" }, ...tsHrefOutput] }, path);
    }
    contentRoots = findPostContentRoots(root, timestampAnchor);
    const contentPaths = (contentRoots || []).map(element => elementPath(element, root)).filter((path): path is number[] => Boolean(path));
    if (contentRoots?.length && contentPaths.length === contentRoots.length) {
      const text = contentRangeText(contentRoots), html = contentRangeHtml(contentRoots);
      if (text) {
        const firstPath = contentPaths[0];
        add({ kind: "content", value: text, label: "Content", predictedType: "text", semanticField: "content", context: "post", confidence: "high", extractionStatus: "verified", contentHtml: html, outputs: [{ key: "content_text", label: "Plain text", value: text, method: "CONTENT_TEXT" }, { key: "content_html", label: "Limited HTML", value: html, method: "CONTENT_HTML" }] }, firstPath);
        const item = Array.from(grouped.values()).find(candidate => candidate.semanticField === "content");
        if (item) { item.sourcePaths = contentPaths; item.relativeXPath = contentPaths.length === 1 ? relativeXPathForPath(firstPath) : undefined; }
      }
      contentRoots.forEach(element => excludedRoots.add(element));
    } else {
      add({ kind: "content", value: "", label: "Content (Needs Attention)", predictedType: "text", semanticField: "content", context: "post", confidence: "low", extractionStatus: "needs_attention", outputs: [{ key: "content_text", label: "Plain text", value: "", method: "CONTENT_TEXT" }] }, []);
    }
  }
  for (const engagementItem of extractPostEngagements(root, timestampAnchor, contentRoots, excludedRoots, options)) {
    grouped.set(engagementItem.id, engagementItem);
  }
  const actionRowForMedia = findActionRowCluster(root, timestampAnchor);
  const postImagesItem = extractPostImages(root, timestampAnchor, contentRoots, actionRowForMedia, options.currentUrl);
  grouped.set(postImagesItem.id, postImagesItem);
  const visit = (element: Element, path: number[], insideSemantic = false) => {
    if (excludedRoots.has(element)) return; const tag = element.tagName.toLowerCase(); if (structurallyHidden(element) || ["script", "style", "noscript", "svg"].includes(tag)) return;
    const context = contextFor(element, root), directText = clean(Array.from(element.childNodes).filter(node => node.nodeType === 3).map(node => node.textContent).join(" "));
    const control = tag === "button" || element.getAttribute("role") === "button", semantic = tag === "a" || tag === "img" || tag === "time" || control;
    if (tag === "a") {
      const href = clean(element.getAttribute("href")), rawLabel = element.textContent || "", label = rawLabel.includes("\u034f") ? "" : clean(rawLabel), absoluteHref = resolveUrl(href, options.currentUrl);
      if (href) { const outputs: ExtractedOutput[] = []; if (label) outputs.push({ key: "text", label: "Link text", value: label, method: "DOM_TEXT" }); outputs.push({ key: "href", label: "URL", value: absoluteHref, method: "DOM_ATTRIBUTE", attribute: "href" }); add({ kind: "link", value: label || absoluteHref, label, attribute: "href", predictedType: "url", context, confidence: label ? "high" : "medium", extractionStatus: label ? "verified" : "needs_attention", outputs }, path); }
    } else if (tag === "img") {
      const src = clean(element.getAttribute("src")), alt = clean(element.getAttribute("alt")), usableSrc = src.startsWith("data:") ? "" : src;
      if (usableSrc || alt) add({ kind: "image", value: usableSrc || alt, label: alt, attribute: usableSrc ? "src" : "alt", predictedType: "image", context, confidence: "medium", extractionStatus: "needs_attention", outputs: [{ key: usableSrc ? "src" : "attribute", label: usableSrc ? "Image URL" : "Alt text", value: usableSrc || alt, method: "DOM_ATTRIBUTE", attribute: usableSrc ? "src" : "alt" }] }, path);
    } else if (tag === "time") {
      const datetime = clean(element.getAttribute("datetime")), value = datetime || directText;
      if (value) add({ kind: "datetime", value, label: directText, attribute: datetime ? "datetime" : undefined, predictedType: "datetime", context, confidence: datetime ? "high" : "medium", extractionStatus: datetime ? "verified" : "needs_attention", sourceAttribute: datetime ? "datetime" : undefined, normalizedValue: datetime || undefined, outputs: [{ key: datetime ? "normalized_value" : "raw_display", label: datetime ? "Normalized value" : "Raw display", value, method: datetime ? "DOM_ATTRIBUTE" : "DOM_TEXT", attribute: datetime ? "datetime" : undefined }] }, path);
    }
    if (!insideSemantic && !semantic && directText && meaningfulText(directText)) add({ kind: "text", value: directText, predictedType: "text", context, confidence: "medium", extractionStatus: "needs_attention", outputs: [{ key: "text", label: "Text", value: directText, method: "DOM_TEXT" }] }, path);
    if (!insideSemantic && control) { const aria = clean(element.getAttribute("aria-label")), title = clean(element.getAttribute("title")), value = aria || title || directText; if (value && meaningfulText(value)) add({ kind: aria || title ? "attribute" : "text", value, attribute: aria ? "aria-label" : title ? "title" : undefined, predictedType: "text", context, confidence: "low", extractionStatus: "needs_attention", hiddenByDefault: true, hiddenReason: "control", outputs: [{ key: aria || title ? "attribute" : "text", label: "Control label", value, method: aria || title ? "DOM_ATTRIBUTE" : "DOM_TEXT", attribute: aria ? "aria-label" : title ? "title" : undefined }] }, path); }
    Array.from(element.children).forEach((child, index) => visit(child, [...path, index], insideSemantic || semantic));
  };
  Array.from(root.children).forEach((child, index) => visit(child, [index])); return Array.from(grouped.values());
}

/** Re-executes a saved mapping against a resolved Parent DOM without using preview values. */
export function executeVariableMapping(root: Element | null, mapping: PostDetailDomVariableMapping, options: ExtractionOptions = {}): ExecutedVariableMapping {
  if (!root) return { mapping, value: "", status: "missing", reason: "Parent root unavailable" };
  const engagementSemantic = mapping.sourceSemantic === "like_count" || mapping.sourceSemantic === "comment_count" || mapping.sourceSemantic === "share_count"
    ? mapping.sourceSemantic
    : null;
  if (mapping.method === "VISUAL_OCR") {
    // Semantic Visual OCR mappings never use relativePath or DOM numeric heuristics.
    if (!engagementSemantic) {
      return { mapping, value: "", status: "needs_attention", reason: "VISUAL_OCR mapping requires like/comment/share semantic" };
    }
    const ocr = options.engagementResult && (!options.postId || options.engagementResult.postId === options.postId)
      ? options.engagementResult
      : undefined;
    if (!ocr) {
      return { mapping, value: "", status: "missing", reason: "unresolved" };
    }
    const field = ocr.fields[engagementSemantic];
    if (field?.status === "verified" && field.value !== null) {
      return { mapping, value: String(field.value), status: "mapped" };
    }
    return {
      mapping,
      value: "",
      status: "needs_attention",
      reason: field?.failureReason || ocr.diagnostics?.[0] || "unresolved",
    };
  }
  if (engagementSemantic) {
    const semanticItem = extractParentData(root, options).find(item => item.semanticField === engagementSemantic);
    if (!semanticItem) return { mapping, value: "", status: "missing", reason: "Verified engagement source is missing" };
    if (semanticItem.extractionStatus !== "verified" || !semanticItem.value) {
      return { mapping, value: "", status: "needs_attention", reason: "Engagement source is ambiguous or lacks semantic evidence" };
    }
    return { mapping, value: semanticItem.value, status: "mapped" };
  }
  if (mapping.sourceSemantic === "content" && (mapping.method === "CONTENT_TEXT" || mapping.method === "CONTENT_HTML" || mapping.outputKey === "content_text" || mapping.outputKey === "content_html")) {
    const timestampAnchor = findPrimaryTimestampAnchor(root, options);
    const contentRoots = timestampAnchor ? findPostContentRoots(root, timestampAnchor) : null;
    if (!contentRoots?.length) return { mapping, value: "", status: "needs_attention", reason: "Semantic post body boundary unavailable" };
    const wantsHtml = mapping.method === "CONTENT_HTML" || mapping.outputKey === "content_html";
    const value = wantsHtml ? contentRangeHtml(contentRoots) : contentRangeText(contentRoots);
    return { mapping, value, status: value ? "mapped" : "needs_attention", reason: value ? undefined : "Empty semantic content" };
  }
  if (mapping.method === "POST_IMAGES" || mapping.sourceSemantic === "post_images") {
    const timestampAnchor = findPrimaryTimestampAnchor(root, options);
    const contentRoots = timestampAnchor ? findPostContentRoots(root, timestampAnchor) : null;
    const actionRow = findActionRowCluster(root, timestampAnchor);
    const mediaItem = extractPostImages(root, timestampAnchor, contentRoots, actionRow, options.currentUrl);
    return mediaItem.extractionStatus === "verified"
      ? { mapping, value: mediaItem.value, status: "mapped" }
      : { mapping, value: "", status: "needs_attention", reason: "Post media lazy-loaded or unresolved" };
  }
  const element = elementAtPath(root, mapping.relativePath);
  if (!element) return { mapping, value: "", status: "missing", reason: "Target element missing at locator" };
  if (mapping.sourceContext === "post" && isComment(element, root)) {
    return { mapping, value: "", status: "needs_attention", reason: "Locator resolved inside a comment" };
  }
  const effectiveMethod: PostDetailExtractionMethod =
    mapping.outputKey === "raw_display" && mapping.attribute === "aria-describedby" ? "DOM_ATTRIBUTE_REF_TEXT" :
    mapping.outputKey === "content_text" ? "CONTENT_TEXT" :
    mapping.outputKey === "content_html" ? "CONTENT_HTML" :
    mapping.method;

  if (effectiveMethod === "DOM_ATTRIBUTE_REF_TEXT") {
    const resolved = resolveDescribedBy(root, element.getAttribute(mapping.attribute || "aria-describedby"));
    if (resolved.status !== "ok") return { mapping, value: "", status: "needs_attention", reason: resolved.status === "ambiguous" ? "Referenced element not unique" : "Referenced element missing" };
    return { mapping, value: resolved.text, status: "mapped" };
  }
  if (effectiveMethod === "CONTENT_TEXT") {
    const value = contentText(element);
    return { mapping, value, status: value ? "mapped" : "needs_attention", reason: value ? undefined : "Empty semantic content" };
  }
  if (effectiveMethod === "CONTENT_HTML") {
    const value = limitedContentHtml(element);
    return { mapping, value, status: value ? "mapped" : "needs_attention", reason: value ? undefined : "Empty limited HTML" };
  }
  if (effectiveMethod === "DOM_ATTRIBUTE_NUMBER") {
    const rawAttr = element.getAttribute(mapping.attribute || "aria-label");
    const num = parseEngagementNumber(rawAttr);
    return num !== null
      ? { mapping, value: String(num), status: "mapped" }
      : { mapping, value: "", status: "needs_attention", reason: "Numeric engagement count missing in attribute" };
  }
  if (effectiveMethod === "DOM_TEXT_NUMBER") {
    const num = parseEngagementNumber(element.textContent);
    return num !== null
      ? { mapping, value: String(num), status: "mapped" }
      : { mapping, value: "", status: "needs_attention", reason: "Numeric engagement count missing in text" };
  }
  if (effectiveMethod === "DOM_ATTRIBUTE") {
    const raw = clean(element.getAttribute(mapping.attribute || ""));
    const value = mapping.attribute === "href" ? resolveUrl(raw, options.currentUrl) : raw;
    return { mapping, value, status: value ? "mapped" : "needs_attention", reason: value ? undefined : "Attribute missing or empty" };
  }
  if (element.tagName.toLowerCase() === "a") {
    const rawLabel = element.textContent || "";
    const value = rawLabel.includes("\u034f") ? "" : clean(rawLabel);
    return { mapping, value, status: value ? "mapped" : "needs_attention", reason: value ? undefined : "Empty link text" };
  }
  const value = clean(element.textContent);
  return { mapping, value, status: value ? "mapped" : "needs_attention", reason: value ? undefined : "Empty text" };
}
