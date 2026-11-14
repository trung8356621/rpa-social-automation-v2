export type ExtractedDataContext = "post" | "comment" | "unknown";
export type ExtractedDataKind = "text" | "link" | "image" | "datetime" | "attribute";

export type ExtractedDataItem = {
  id: string;
  kind: ExtractedDataKind;
  value: string;
  label?: string;
  attribute?: string;
  predictedType?: "text" | "url" | "image" | "datetime";
  context: ExtractedDataContext;
  sourcePaths: number[][];
  relativeXPath?: string;
};

const clean = (value: string | null | undefined) => (value || "").replace(/[\u034f\u200b-\u200f\u2060\ufeff]/g, "").replace(/\s+/g, " ").trim();
const pathKey = (path: number[]) => path.join("/");
export const relativeXPathForPath = (path: number[]) => `.${path.map(index => `/*[${index + 1}]`).join("")}`;
const meaningfulText = (value: string) => /^\d+$/.test(value) || value.replace(/[^\p{L}\p{N}]/gu, "").length >= 2;
const structurallyHidden = (element: Element) => {
  const style = (element.getAttribute("style") || "").replace(/\s+/g, "").toLowerCase();
  return element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true" || style.includes("display:none") || style.includes("visibility:hidden");
};

function contextFor(element: Element, root: Element): ExtractedDataContext {
  let current: Element | null = element;
  while (current && current !== root) {
    if (current.getAttribute("role") === "article" || current.tagName.toLowerCase() === "article") return "comment";
    current = current.parentElement;
  }
  return root.contains(element) ? "post" : "unknown";
}

/** One DFS pass. Only direct text and semantic values are emitted, never ancestor textContent. */
export function extractParentData(root: Element): ExtractedDataItem[] {
  const grouped = new Map<string, ExtractedDataItem>();
  const add = (item: Omit<ExtractedDataItem, "id" | "sourcePaths" | "relativeXPath">, path: number[]) => {
    const key = `${item.context}\u0000${item.kind}\u0000${item.attribute || ""}\u0000${item.value}`;
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.sourcePaths.some(candidate => pathKey(candidate) === pathKey(path))) existing.sourcePaths.push(path);
      existing.relativeXPath = undefined;
      return;
    }
    grouped.set(key, {
      ...item,
      id: `${item.kind}:${pathKey(path)}:${grouped.size}`,
      sourcePaths: [path],
      relativeXPath: relativeXPathForPath(path),
    });
  };
  const visit = (element: Element, path: number[], insideSemantic = false) => {
    const tag = element.tagName.toLowerCase();
    if (structurallyHidden(element) || ["script", "style", "noscript", "svg"].includes(tag)) return;
    const context = contextFor(element, root);
    const directText = clean(Array.from(element.childNodes)
      .filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent)
      .join(" "));
    const semantic = tag === "a" || tag === "img" || tag === "time" || tag === "button" || element.getAttribute("role") === "button";
    if (tag === "a") {
      const href = clean(element.getAttribute("href"));
      const rawLabel = element.textContent || "";
      const label = rawLabel.includes("\u034f") ? "" : clean(rawLabel);
      if (href) add({ kind: "link", value: href, label, attribute: "href", predictedType: "url", context }, path);
    } else if (tag === "img") {
      const src = clean(element.getAttribute("src"));
      const alt = clean(element.getAttribute("alt"));
      const usableSrc = src.startsWith("data:") ? "" : src;
      if (usableSrc || alt) add({ kind: "image", value: usableSrc || alt, label: alt, attribute: usableSrc ? "src" : "alt", predictedType: "image", context }, path);
    } else if (tag === "time") {
      const datetime = clean(element.getAttribute("datetime"));
      const value = datetime || directText;
      if (value) add({ kind: "datetime", value, label: directText, attribute: datetime ? "datetime" : undefined, predictedType: "datetime", context }, path);
    }
    if (!insideSemantic && !semantic && directText && meaningfulText(directText)) add({ kind: "text", value: directText, predictedType: "text", context }, path);
    if (!insideSemantic && semantic && tag !== "a" && tag !== "img" && tag !== "time") {
      const aria = clean(element.getAttribute("aria-label"));
      const title = clean(element.getAttribute("title"));
      const value = aria || title || directText;
      if (value && meaningfulText(value)) {
        add({ kind: aria || title ? "attribute" : "text", value, attribute: aria ? "aria-label" : title ? "title" : undefined, predictedType: "text", context }, path);
      }
    }
    Array.from(element.children).forEach((child, index) => visit(child, [...path, index], insideSemantic || semantic));
  };
  Array.from(root.children).forEach((child, index) => visit(child, [index]));
  return Array.from(grouped.values());
}
