export type ExtractedDataContext = "post" | "comment" | "unknown";
export type ExtractedDataKind = "text" | "link" | "image" | "datetime" | "content" | "attribute";
export type ExtractedOutput = { key: "text" | "href" | "src" | "raw_display" | "normalized_value" | "content_text" | "content_html" | "attribute"; label: string; value: string; method: "DOM_TEXT" | "DOM_ATTRIBUTE"; attribute?: string };
export type ExtractedDataItem = {
  id: string; kind: ExtractedDataKind; value: string; label?: string; attribute?: string;
  predictedType?: "text" | "url" | "image" | "datetime"; semanticField?: "created_at" | "content";
  context: ExtractedDataContext; confidence: "high" | "medium" | "low"; extractionStatus: "verified" | "needs_attention";
  sourceAttribute?: string; normalizedValue?: string; contentHtml?: string; hiddenByDefault?: boolean; hiddenReason?: string;
  outputs: ExtractedOutput[]; sourcePaths: number[][]; relativeXPath?: string;
};

type ExtractionOptions = { postId?: string; currentUrl?: string };
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
const referencedElement = (root: Element, id: string | null) => id ? Array.from(root.querySelectorAll("[id]")).find(element => element.id === id) || null : null;

function findPrimaryTimestampAnchor(root: Element, options: ExtractionOptions) {
  const candidates = Array.from(root.querySelectorAll("a[href]")).filter(anchor => {
    const href = anchor.getAttribute("href") || "";
    if (/([?&])(comment_id|reply_comment_id)=/.test(href)) return false;
    const described = referencedElement(root, anchor.getAttribute("aria-describedby"));
    const labelled = referencedElement(root, anchor.getAttribute("aria-labelledby"));
    const hasPostIdentity = Boolean(options.postId && href.includes(options.postId));
    return Boolean(described && labelled && (hasPostIdentity || href.startsWith("?") || href.includes("/posts/")));
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
function firstPostControlCluster(root: Element, after: Element) {
  const controls = Array.from(root.querySelectorAll("button,[role='button']")).filter(control => !isComment(control, root) && Boolean(after.compareDocumentPosition(control) & 4));
  for (const control of controls) for (let node: Element | null = control.parentElement; node && node !== root; node = node.parentElement) if (!node.querySelector("[role='article'],article") && node.querySelectorAll("button,[role='button']").length >= 3) return node;
  return null;
}
function findPostContentRoot(root: Element, timestampAnchor: Element) {
  const boundary = root.querySelector("[role='article'],article") || firstPostControlCluster(root, timestampAnchor); if (!boundary) return null;
  const scope = commonAncestor(timestampAnchor, boundary, root); if (!scope) return null;
  const headerBranch = branchUnder(timestampAnchor, scope), boundaryBranch = branchUnder(boundary, scope); if (!headerBranch || !boundaryBranch) return null;
  const children = Array.from(scope.children), start = children.indexOf(headerBranch), end = children.indexOf(boundaryBranch); if (start < 0 || end <= start) return null;
  const candidates = children.slice(start + 1, end).filter(element => !element.querySelector("[role='article'],article") && !element.querySelector("button,[role='button']") && meaningfulText(clean(element.textContent)));
  return candidates.length === 1 ? candidates[0] : null;
}
function contentText(root: Element) {
  const chunks: string[] = [], blockTags = new Set(["DIV", "P", "H1", "H2", "H3", "H4", "LI", "UL", "OL", "SECTION", "ARTICLE"]);
  const newline = () => { if (chunks.length && chunks[chunks.length - 1] !== "\n") chunks.push("\n"); };
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { const value = clean(node.textContent); if (value) chunks.push(value); return; }
    if (!(node instanceof Element) || structurallyHidden(node) || ["SCRIPT", "STYLE", "SVG", "BUTTON"].includes(node.tagName) || node.getAttribute("role") === "button" || isComment(node, root)) return;
    if (node.tagName === "BR") { newline(); return; }
    const block = blockTags.has(node.tagName); if (block) newline(); if (node.tagName === "LI") chunks.push("• ");
    Array.from(node.childNodes).forEach(walk); if (block) newline();
  };
  Array.from(root.childNodes).forEach(walk);
  return chunks.join(" ").replace(/ *\n */g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
function limitedContentHtml(element: Element) { const clone = element.cloneNode(true) as Element; clone.querySelectorAll("script,style,svg,button,[role='button'],[role='article'],article,[aria-hidden='true'],[hidden]").forEach(node => node.remove()); return clone.innerHTML.trim(); }

/** One DFS pass for generic values, plus verified semantic header/body boundaries. */
export function extractParentData(root: Element, options: ExtractionOptions = {}): ExtractedDataItem[] {
  const grouped = new Map<string, ExtractedDataItem>(), excludedRoots = new Set<Element>();
  const add = (item: Omit<ExtractedDataItem, "id" | "sourcePaths" | "relativeXPath">, path: number[]) => {
    const key = `${item.context}\u0000${item.semanticField || ""}\u0000${item.kind}\u0000${item.attribute || ""}\u0000${item.value}`, existing = grouped.get(key);
    if (existing) { if (!existing.sourcePaths.some(candidate => pathKey(candidate) === pathKey(path))) existing.sourcePaths.push(path); existing.relativeXPath = undefined; if (!existing.semanticField) { existing.hiddenByDefault = true; existing.hiddenReason = "duplicate"; } return; }
    grouped.set(key, { ...item, id: `${item.semanticField || item.kind}:${pathKey(path)}:${grouped.size}`, sourcePaths: [path], relativeXPath: relativeXPathForPath(path) });
  };
  const timestampAnchor = findPrimaryTimestampAnchor(root, options);
  if (timestampAnchor) {
    const path = elementPath(timestampAnchor, root), described = referencedElement(root, timestampAnchor.getAttribute("aria-describedby")), rawDisplay = clean(described?.textContent);
    if (path && rawDisplay) { add({ kind: "datetime", value: rawDisplay, label: "Created at", predictedType: "datetime", semanticField: "created_at", context: "post", confidence: "high", extractionStatus: "needs_attention", sourceAttribute: "aria-describedby", outputs: [{ key: "raw_display", label: "Raw display", value: rawDisplay, method: "DOM_ATTRIBUTE", attribute: "aria-describedby" }] }, path); if (timestampAnchor.parentElement) excludedRoots.add(timestampAnchor.parentElement); }
    const contentRoot = findPostContentRoot(root, timestampAnchor), contentPath = contentRoot ? elementPath(contentRoot, root) : null;
    if (contentRoot && contentPath) { const text = contentText(contentRoot), html = limitedContentHtml(contentRoot); if (text) add({ kind: "content", value: text, label: "Content", predictedType: "text", semanticField: "content", context: "post", confidence: "high", extractionStatus: "verified", contentHtml: html, outputs: [{ key: "content_text", label: "Plain text", value: text, method: "DOM_TEXT" }, { key: "content_html", label: "Limited HTML", value: html, method: "DOM_TEXT" }] }, contentPath); excludedRoots.add(contentRoot); }
  }
  const visit = (element: Element, path: number[], insideSemantic = false) => {
    if (excludedRoots.has(element)) return; const tag = element.tagName.toLowerCase(); if (structurallyHidden(element) || ["script", "style", "noscript", "svg"].includes(tag)) return;
    const context = contextFor(element, root), directText = clean(Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(" "));
    const control = tag === "button" || element.getAttribute("role") === "button", semantic = tag === "a" || tag === "img" || tag === "time" || control;
    if (tag === "a") {
      const href = clean(element.getAttribute("href")), rawLabel = element.textContent || "", label = rawLabel.includes("\u034f") ? "" : clean(rawLabel), absoluteHref = href && options.currentUrl ? (() => { try { return new URL(href, options.currentUrl).href; } catch { return href; } })() : href;
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
