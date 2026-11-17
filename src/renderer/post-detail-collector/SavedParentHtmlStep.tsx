import React, { useEffect, useMemo, useRef, useState } from "react";
import { usePostProcessingToolbar } from "./PostProcessingToolbar";
import type { EngagementFieldName, PostDetailEngagementOcrResult, PostDetailParentConfig, PostDetailSavedParentResolution } from "../../shared/post-detail-collector/types";
import type { CollectorValueType, CollectorVariable } from "../../shared/collectors/types";
import { collectorReportBrowserHost, collectorSetBrowserVisible } from "../collectors/browser-capture";
import { claimCollectorHostOwner, isCollectorHostOwner, releaseCollectorHostOwner } from "../collectors/collector-host-owner";
import { UiPopover } from "../ui-popover";
import {
  createRafHostPublishScheduler,
  publishPostDetailBrowserHost,
} from "./publish-browser-host";
import { doesExpandedDrawerOverlapHost } from "../collectors/publish-collector-host";
import {
  BrowserHost,
  BrowserScrollArea,
  BrowserWorkspace,
  SidebarDrawer,
} from "../components/BrowserWorkspace";
import { canonicalPostUrl } from "./batch-validation";
import { executeVariableMapping, extractParentData, relativeXPathForPath, type ExtractedDataItem, type ExtractedOutput } from "./extract-parent-data";
import {
  COLLECTOR_VALUE_TYPES,
  addRegistryVariable,
  countMappingsForVariable,
  deleteRegistryVariable,
  ensureDefaultCollector,
  listRegistryVariables,
  loadRegistryEnvelope,
  updateRegistryVariable,
  type RegistryVariableOption,
} from "./variable-registry";
import type { BatchValidationRow, Invoke, PostDetailDomVariableMapping } from "./types";

export type Step4DetailReviewProps = {
  row: BatchValidationRow;
  rowIndex: number;
  totalRows: number;
  canPrev: boolean;
  canNext: boolean;
  staleDomWarning?: string;
  onBackToResults: () => void;
  onPrevPost: () => void;
  onNextPost: () => void;
  onCustomizeInStep3: () => void;
};

type ExplorerNode = { element: Element; tagName: string; directText: string; textPreview: string; childCount: number; path: number[]; attrs: Record<string, string> };
type VariableOption = RegistryVariableOption;
const pathKey = (path: number[]) => path.join("/");
const short = (value: string, max = 120) => value.replace(/\s+/g, " ").trim().slice(0, max);
const relativeXPath = (path: number[]) => `.${path.map(index => `/*[${index + 1}]`).join("")}`;
const relativeSelector = (path: number[]) => path.map(index => `:scope > :nth-child(${index + 1})`).join(" ");

function toNode(element: Element, path: number[]): ExplorerNode {
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(element.attributes)) attrs[attr.name] = attr.value;
  const directText = Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent || "").join(" ");
  return { element, tagName: element.tagName.toLowerCase(), directText: short(directText, 100), textPreview: short(element.textContent || "", 180), childCount: element.children.length, path, attrs };
}
function nodeKind(node: ExplorerNode) {
  if (node.tagName === "img" || node.attrs.src) return "▧ image";
  if (node.tagName === "a" || node.attrs.href) return "↗ link";
  if (node.tagName === "button" || node.attrs.role === "button") return "◉ control";
  return node.directText ? "¶ text" : "◇ node";
}
function TreeNode({ node, expanded, selected, onToggle, onSelect, onFocus, onHover }: { node: ExplorerNode; expanded: Set<string>; selected: string; onToggle: (key: string) => void; onSelect: (node: ExplorerNode) => void; onFocus: (node: ExplorerNode) => void; onHover: (node: ExplorerNode | null) => void }) {
  const key = pathKey(node.path), open = expanded.has(key);
  const children = open ? Array.from(node.element.children).map((child, index) => toNode(child, [...node.path, index])) : [];
  return <li><div className={`pdc-dom-row ${selected === key ? "selected" : ""}`} onClick={() => onSelect(node)} onDoubleClick={() => onFocus(node)} onMouseEnter={() => onHover(node)} onMouseLeave={() => onHover(null)}>
    <button type="button" className="pdc-dom-toggle" disabled={!node.childCount} onClick={event => { event.stopPropagation(); onToggle(key); }}>{node.childCount ? open ? "▾" : "▸" : "·"}</button>
    <code>&lt;{node.tagName}&gt;</code><span>{node.directText || node.textPreview || "—"}</span><small>{nodeKind(node)} · {node.childCount}</small>
  </div>{open && <ul>{children.map(child => <TreeNode key={pathKey(child.path)} node={child} expanded={expanded} selected={selected} onToggle={onToggle} onSelect={onSelect} onFocus={onFocus} onHover={onHover} />)}</ul>}</li>;
}
function loadVariables(): VariableOption[] {
  return listRegistryVariables();
}

export function SavedParentHtmlStep({ invoke, result, currentUrl, runId, engagementResult, onEngagementResult, parentConfig, variableMappings, onVariableMappings, hiddenExtractedData, onHiddenExtractedData, onVariablesChanged, onBackToLibrary, onRematch, onRetryAutoMatch, onNextBatchValidation, reviewMode }: { invoke: Invoke; result: PostDetailSavedParentResolution | null; currentUrl: string; runId: string | null; engagementResult?: PostDetailEngagementOcrResult; onEngagementResult: (result: PostDetailEngagementOcrResult) => void; parentConfig?: PostDetailParentConfig; variableMappings: PostDetailDomVariableMapping[]; onVariableMappings: (mappings: PostDetailDomVariableMapping[]) => void; hiddenExtractedData: Record<string, string[]>; onHiddenExtractedData: (hidden: Record<string, string[]>) => void; onVariablesChanged?: () => void; onBackToLibrary?: () => void; onRematch: () => void; onRetryAutoMatch?: () => void; onNextBatchValidation?: () => void; reviewMode?: Step4DetailReviewProps }) {
  const status = result?.status || "NOT_CONFIGURED";
  const hostRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"explorer" | "raw">("explorer");
  const [selectedDataId, setSelectedDataId] = useState("");
  const [selectedOutputKey, setSelectedOutputKey] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<ExplorerNode | null>(null);
  const [focusPath, setFocusPath] = useState<number[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [browserCollapsed, setBrowserCollapsed] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarOccludesBrowser, setSidebarOccludesBrowser] = useState(false);
  const [treeRatio, setTreeRatio] = useState(55);
  const [variableId, setVariableId] = useState("");
  const [method, setMethod] = useState<"DOM_TEXT" | "DOM_ATTRIBUTE">("DOM_TEXT");
  const [attribute, setAttribute] = useState("href");
  const [variables, setVariables] = useState<VariableOption[]>(loadVariables);
  const [variablesOpen, setVariablesOpen] = useState(false);
  const [activeCollectorId, setActiveCollectorId] = useState(() => loadRegistryEnvelope()?.collectors[0]?.id || "");
  const [draftVars, setDraftVars] = useState<CollectorVariable[]>([]);
  const [varError, setVarError] = useState("");
  const [failedThumbUrls, setFailedThumbUrls] = useState<Set<string>>(() => new Set());
  const [copiedThumbUrl, setCopiedThumbUrl] = useState("");
  const [engagementBusy, setEngagementBusy] = useState(false);
  const [engagementError, setEngagementError] = useState("");
  const [engagementPreview, setEngagementPreview] = useState(engagementResult?.previewDataUrl || "");
  const engagementJobEpochRef = useRef(0);
  const autoCaptureDoneKeyRef = useRef("");
  useEffect(() => {
    engagementJobEpochRef.current += 1;
    autoCaptureDoneKeyRef.current = "";
    setSelectedDataId("");
    setSelectedOutputKey("");
    setSelected(null);
    setFocusPath([]);
    setFailedThumbUrls(new Set());
  }, [reviewMode?.row.url, currentUrl]);
  const refreshVariables = (targetCollectorId?: string) => {
    const next = listRegistryVariables();
    setVariables(next);
    const envelope = loadRegistryEnvelope();
    const resolvedId = targetCollectorId || activeCollectorId || envelope?.collectors[0]?.id || "";
    if (resolvedId && resolvedId !== activeCollectorId) setActiveCollectorId(resolvedId);
    const collector = envelope?.collectors.find(c => c.id === resolvedId) || envelope?.collectors[0] || null;
    setDraftVars(collector ? collector.variables.map(v => ({ ...v })) : []);
  };
  const collectors = useMemo(() => loadRegistryEnvelope()?.collectors || [], [variables, variablesOpen]);
  const activeCollector = collectors.find(c => c.id === activeCollectorId) || collectors[0] || null;
  const openVariablesDrawer = () => {
    const first = ensureDefaultCollector();
    const targetId = activeCollectorId || first?.id || "";
    refreshVariables(targetId);
    setVarError("");
    setVariablesOpen(value => !value);
  };
  const handleAddVariable = () => {
    const target = activeCollector || ensureDefaultCollector();
    if (!target) return;
    addRegistryVariable(target.id, { label: "Custom Variable", valueType: "string" });
    setVarError("");
    refreshVariables(target.id);
    onVariablesChanged?.();
  };
  const patchDraftVar = (targetVarId: string, patch: Partial<Pick<CollectorVariable, "label" | "key" | "valueType" | "required">>) => {
    setDraftVars(current => current.map(v => (v.id === targetVarId ? { ...v, ...patch } : v)));
  };
  const commitVariable = (collectorId: string, targetVarId: string, overridePatch?: Partial<Pick<CollectorVariable, "label" | "key" | "valueType" | "required">>) => {
    const draft = draftVars.find(v => v.id === targetVarId);
    if (!draft) return;
    const merged = { ...draft, ...overridePatch };
    const stored = activeCollector?.variables.find(v => v.id === targetVarId);
    const keyChanged = Boolean(stored && merged.key.trim() !== stored.key);
    const typeChanged = Boolean(stored && merged.valueType !== stored.valueType);
    const mappedCount = countMappingsForVariable(variableMappings, collectorId, targetVarId);
    if (mappedCount > 0 && (keyChanged || typeChanged)) {
      const ok = typeof window === "undefined" || typeof window.confirm !== "function" || window.confirm(`Variable đang được map tới ${mappedCount} output. Thay đổi key/type có thể ảnh hưởng mapping hiện tại. Tiếp tục?`);
      if (!ok) { refreshVariables(collectorId); return; }
    }
    const res = updateRegistryVariable(collectorId, targetVarId, {
      label: merged.label,
      key: merged.key,
      valueType: merged.valueType,
      required: merged.required,
    }, variableMappings);
    if (!res.ok) { setVarError(res.error || "Không thể cập nhật variable."); return; }
    setVarError("");
    if (res.mappings !== variableMappings) onVariableMappings(res.mappings);
    refreshVariables(collectorId);
    onVariablesChanged?.();
  };
  const handleDeleteVariable = (collectorId: string, targetVarId: string) => {
    const mappedCount = countMappingsForVariable(variableMappings, collectorId, targetVarId);
    if (mappedCount > 0) {
      const ok = typeof window === "undefined" || typeof window.confirm !== "function" || window.confirm(`Variable đang được map tới ${mappedCount} output. Xóa variable sẽ gỡ các mapping liên quan. Tiếp tục?`);
      if (!ok) return;
    }
    const res = deleteRegistryVariable(collectorId, targetVarId, variableMappings);
    if (variableId === `${collectorId}:${targetVarId}`) setVariableId("");
    onVariableMappings(res.mappings);
    setVarError("");
    refreshVariables(collectorId);
    onVariablesChanged?.();
  };
  const parsed = useMemo(() => {
    if (status !== "PARENT_MATCHED" || !result?.innerHTML || typeof DOMParser === "undefined") return null;
    const doc = new DOMParser().parseFromString("<!doctype html><body></body>", "text/html"), root = doc.createElement("div"); root.innerHTML = result.innerHTML; return root;
  }, [result?.innerHTML, status]);
  const atPath = React.useCallback((path: number[]) => { let node: Element | null = parsed; for (const index of path) node = node?.children.item(index) || null; return node; }, [parsed]);
  const postId = String(result?.diagnosticMeta?.postId || currentUrl.match(/\/posts\/(\d+)/)?.[1] || "current-post");
  useEffect(() => {
    let cancelled = false;
    setEngagementError("");
    setEngagementPreview(engagementResult?.postId === postId ? (engagementResult.previewDataUrl || "") : "");
    if (!engagementResult?.cropPath || engagementResult.postId !== postId || engagementResult.previewDataUrl) return () => { cancelled = true; };
    void invoke<{ dataUrl: string; cropPath: string } | null>({ type: "postDetailLoadEngagementCrop", runId: engagementResult.runId, postId }).then(loaded => {
      if (!cancelled && loaded?.dataUrl) setEngagementPreview(loaded.dataUrl);
    }).catch(() => { /* Evidence may have been pruned by lifecycle cleanup. */ });
    return () => { cancelled = true; };
  }, [invoke, postId, engagementResult?.postId, engagementResult?.runId, engagementResult?.captureId, engagementResult?.capturedAt, engagementResult?.cropPath, engagementResult?.previewDataUrl]);
  const extractedData = useMemo(() => {
    const domItems = parsed ? extractParentData(parsed, { postId, currentUrl, domAnchors: parentConfig?.domAnchors }).filter(item => item.kind !== "engagement") : [];
    const labels: Record<EngagementFieldName, string> = { like_count: "Likes", comment_count: "Comments", share_count: "Shares" };
    const fields: EngagementFieldName[] = ["like_count", "comment_count", "share_count"];
    const ocrItems: ExtractedDataItem[] = fields.map(field => {
      const evidence = engagementResult?.fields[field];
      const value = evidence?.value == null ? "" : String(evidence.value);
      return { id: `engagement-ocr:${postId}:${field}`, kind: "engagement", value, label: labels[field], predictedType: "number", semanticField: field, context: "post", confidence: evidence?.confidence != null && evidence.confidence >= 70 ? "high" : evidence?.confidence != null ? "medium" : "low", extractionStatus: evidence?.status === "verified" ? "verified" : "needs_attention", normalizedValue: value, outputs: [{ key: "count", label: labels[field], value, method: "VISUAL_OCR" }], sourcePaths: [], engagementEvidence: { actionAnchorStatus: result?.status === "PARENT_MATCHED" ? "VERIFIED" : "MISSING", countSourceStatus: evidence?.status === "verified" ? "VERIFIED" : "MISSING", method: "NONE", reason: evidence?.status === "verified" ? `VISUAL_OCR · ${evidence.rawText}` : evidence?.failureReason || engagementResult?.status || "NOT_EXTRACTED" } };
    });
    return [...ocrItems, ...domItems];
  }, [parsed, postId, currentUrl, parentConfig?.domAnchors, engagementResult, result?.status]);
  const manuallyHidden = hiddenExtractedData[postId] || [];
  const hiddenCount = extractedData.filter(item => item.hiddenByDefault || manuallyHidden.includes(item.id)).length;
  const visibleData = showHidden ? extractedData : extractedData.filter(item => !item.hiddenByDefault && !manuallyHidden.includes(item.id));
  const selectedData = extractedData.find(item => item.id === selectedDataId) || null;
  const selectedOutput = selectedData?.outputs.find(output => output.key === selectedOutputKey) || selectedData?.outputs[0] || null;
  const focusElement = atPath(focusPath);
  const nodes = useMemo(() => focusElement ? [toNode(focusElement, focusPath)] : [], [focusElement, focusPath]);

  const hostOwnerRef = useRef<string | null>(null);
  const initialAutoCollapseDoneRef = useRef(false);
  const sidebarCollapsedRef = useRef(sidebarCollapsed);
  sidebarCollapsedRef.current = sidebarCollapsed;
  const hostMounted = status !== "NOT_CONFIGURED" && !browserCollapsed;
  useEffect(() => {
    const { ownerId } = claimCollectorHostOwner("pdc-step3");
    hostOwnerRef.current = ownerId;
    if (!hostMounted) {
      void collectorReportBrowserHost(invoke, null);
      void collectorSetBrowserVisible(invoke, false);
      return () => {
        if (hostOwnerRef.current === ownerId) hostOwnerRef.current = null;
        releaseCollectorHostOwner(ownerId, () => void collectorReportBrowserHost(invoke, null));
      };
    }
    let cancelled = false;
    const rafIds = new Set<number>();
    const publish = () => {
      if (cancelled || !isCollectorHostOwner(ownerId)) return false;
      const host = hostRef.current;
      if (!host) return false;
      const rect = host.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return false;
      const overlaps = doesExpandedDrawerOverlapHost(host);
      if (!initialAutoCollapseDoneRef.current) {
        initialAutoCollapseDoneRef.current = true;
        if (overlaps && !sidebarCollapsedRef.current) {
          sidebarCollapsedRef.current = true;
          setSidebarCollapsed(true);
          publishPostDetailBrowserHost(invoke, host);
          return true;
        }
      }
      const occluded = !sidebarCollapsedRef.current && overlaps;
      setSidebarOccludesBrowser((prev) => (prev === occluded ? prev : occluded));
      if (occluded) {
        void collectorReportBrowserHost(invoke, null);
        void collectorSetBrowserVisible(invoke, false);
        return true;
      }
      publishPostDetailBrowserHost(invoke, host);
      return true;
    };
    const attachWhenMeasured = (remaining = 8) => {
      if (publish() || remaining <= 0 || cancelled) return;
      const id = requestAnimationFrame(() => { rafIds.delete(id); attachWhenMeasured(remaining - 1); });
      rafIds.add(id);
    };
    attachWhenMeasured();
    const first = requestAnimationFrame(() => { rafIds.delete(first); attachWhenMeasured(); });
    rafIds.add(first);
    const scheduler = createRafHostPublishScheduler(() => { void publish(); });
    const observer = new ResizeObserver(() => scheduler.schedule());
    if (hostRef.current) observer.observe(hostRef.current);
    window.addEventListener("resize", scheduler.schedule);
    window.addEventListener("scroll", scheduler.schedule, true);
    if (!variablesOpen && (sidebarCollapsedRef.current || !doesExpandedDrawerOverlapHost(hostRef.current))) {
      void collectorSetBrowserVisible(invoke, true).then(() => {
        if (!cancelled && isCollectorHostOwner(ownerId)) attachWhenMeasured();
      });
    }
    return () => {
      cancelled = true;
      scheduler.cancel();
      rafIds.forEach(id => cancelAnimationFrame(id));
      observer.disconnect();
      window.removeEventListener("resize", scheduler.schedule);
      window.removeEventListener("scroll", scheduler.schedule, true);
      void invoke({ type: "postDetailClearParentNodeHighlight" });
      if (hostOwnerRef.current === ownerId) hostOwnerRef.current = null;
      releaseCollectorHostOwner(ownerId, () => { void collectorReportBrowserHost(invoke, null); void collectorSetBrowserVisible(invoke, false); });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostMounted, invoke]);
  useEffect(() => {
    const ownerId = hostOwnerRef.current;
    if (!ownerId || !isCollectorHostOwner(ownerId)) return;
    const occluded = !sidebarCollapsed && doesExpandedDrawerOverlapHost(hostRef.current);
    setSidebarOccludesBrowser(occluded);
    const visible = status !== "NOT_CONFIGURED" && !browserCollapsed && !variablesOpen && !occluded;
    void collectorSetBrowserVisible(invoke, visible);
    if (!visible) {
      void collectorReportBrowserHost(invoke, null);
      return;
    }
    let cancelled = false;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (!cancelled && isCollectorHostOwner(ownerId)) {
          publishPostDetailBrowserHost(invoke, hostRef.current);
        }
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [hostMounted, variablesOpen, sidebarCollapsed, invoke]);
  useEffect(() => { if (!isExpanded) return; const close = (event: KeyboardEvent) => { if (event.key === "Escape") setIsExpanded(false); }; window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); }, [isExpanded]);

  const highlight = (node: ExplorerNode | null) => void invoke(node ? { type: "postDetailHighlightParentNode", path: node.path } : selected ? { type: "postDetailHighlightParentNode", path: selected.path } : { type: "postDetailClearParentNodeHighlight" });
  const choose = (node: ExplorerNode) => { setSelected(node); highlight(node); };
  const focus = (node: ExplorerNode) => { setFocusPath(node.path); setSelected(node); setExpanded(new Set([pathKey(node.path)])); };
  const resetFocus = () => setFocusPath([]);
  const copy = (value: string) => void navigator.clipboard.writeText(value);
  const selectedValue = selected ? method === "DOM_ATTRIBUTE" ? selected.attrs[attribute] || "" : short(selected.element.textContent || "", 2000) : "";
  const selectedMatchCount = selected && parsed ? (() => { const snapshot = parsed.ownerDocument.evaluate(relativeXPath(selected.path), parsed, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); return snapshot.snapshotLength; })() : 0;
  const saveMapping = () => {
    if (!selected || !variableId) return; const variable = variables.find(item => `${item.collectorId}:${item.id}` === variableId); if (!variable) return;
    const mapping: PostDetailDomVariableMapping = { collectorId: variable.collectorId, variableId: variable.id, variableKey: variable.key, variableLabel: variable.label, method, attribute: method === "DOM_ATTRIBUTE" ? attribute : undefined, relativePath: selected.path, relativeXPath: relativeXPath(selected.path), preview: selectedValue, confirmed: true, updatedAt: new Date().toISOString() };
    onVariableMappings([...variableMappings.filter(item => !(item.collectorId === mapping.collectorId && item.variableId === mapping.variableId)), mapping]);
  };
  const samePath = (left: number[], right: number[]) => left.length === right.length && left.every((value, index) => value === right[index]);
  const isEngagementOcrItem = (item: ExtractedDataItem) => item.kind === "engagement" && (item.semanticField === "like_count" || item.semanticField === "comment_count" || item.semanticField === "share_count");
  const mappingsForItem = (item: ExtractedDataItem) => variableMappings.filter(mapping =>
    isEngagementOcrItem(item)
      ? mapping.method === "VISUAL_OCR" && mapping.sourceSemantic === item.semanticField
      : item.semanticField === "post_images" || item.semanticField === "content"
        ? mapping.sourceSemantic === item.semanticField
        : item.sourcePaths.some(path => samePath(path, mapping.relativePath)) &&
          (!mapping.sourceContext || mapping.sourceContext === item.context) &&
          (!mapping.sourceSemantic || mapping.sourceSemantic === item.semanticField));
  const mappingForOutput = (item: ExtractedDataItem, output: ExtractedOutput) => mappingsForItem(item).find(mapping =>
    isEngagementOcrItem(item)
      ? (mapping.outputKey || "count") === output.key
      : mapping.outputKey ? mapping.outputKey === output.key : mapping.preview === output.value);
  const engagementVariableCompatible = (valueType: string) => valueType === "number" || valueType === "string" || valueType === "text";
  const engagementVariableBlockReason = (valueType: string) =>
    engagementVariableCompatible(valueType) ? "" : `incompatible type (${valueType}; use number or string)`;
  const suggestedVariable = (item: ExtractedDataItem) => {
    if (item.context !== "post" || !item.semanticField) return undefined;
    const exact = variables.find(variable => variable.key === item.semanticField);
    if (exact && (!isEngagementOcrItem(item) || engagementVariableCompatible(exact.valueType))) return exact;
    if (isEngagementOcrItem(item)) {
      return variables.find(variable => engagementVariableCompatible(variable.valueType) && /(?:like|comment|share|reaction|engagement|count)/i.test(`${variable.key} ${variable.label}`));
    }
    if (item.semanticField === "post_images") {
      return variables.find(variable => variable.valueType === "array" && /(?:image|media|photo)/i.test(variable.key));
    }
    return undefined;
  };
  const selectOutput = (item: ExtractedDataItem, output: ExtractedOutput) => {
    setSelectedOutputKey(output.key);
    const mapping = mappingForOutput(item, output), suggestion = suggestedVariable(item);
    setVariableId(mapping ? `${mapping.collectorId}:${mapping.variableId}` : suggestion ? `${suggestion.collectorId}:${suggestion.id}` : "");
    setMethod(output.method === "DOM_ATTRIBUTE" ? "DOM_ATTRIBUTE" : "DOM_TEXT"); setAttribute(output.attribute || "href");
  };
  const selectData = (item: ExtractedDataItem) => {
    setSelectedDataId(item.id);
    const output = item.outputs[0]; if (output) selectOutput(item, output);
  };
  const canMapSelectedData = (item: ExtractedDataItem | null, output: ExtractedOutput | null) => {
    if (!variableId || !item || !output) return false;
    const variable = variables.find(entry => `${entry.collectorId}:${entry.id}` === variableId);
    if (!variable) return false;
    // Engagement Visual OCR mapping is configuration — independent of current OCR success.
    if (isEngagementOcrItem(item) && output.method === "VISUAL_OCR") {
      return engagementVariableCompatible(variable.valueType);
    }
    if (item.semanticField === "post_images" || item.semanticField === "content") {
      return item.extractionStatus === "verified" && Boolean(output.value || item.semanticField === "post_images");
    }
    return Boolean(output.value) && item.sourcePaths.length === 1;
  };
  const applyDataMapping = () => {
    if (!selectedData || !selectedOutput || !canMapSelectedData(selectedData, selectedOutput)) return;
    const variable = variables.find(item => `${item.collectorId}:${item.id}` === variableId);
    if (!variable) return;
    const engagementOcr = isEngagementOcrItem(selectedData) && selectedOutput.method === "VISUAL_OCR";
    if (engagementOcr && !engagementVariableCompatible(variable.valueType)) return;
    const path = engagementOcr ? [] : (selectedData.sourcePaths[0] || []);
    const verifiedPreview = engagementOcr
      ? (selectedData.extractionStatus === "verified" && selectedOutput.value.trim() ? selectedOutput.value.trim() : "")
      : selectedOutput.value;
    const mapping: PostDetailDomVariableMapping = {
      collectorId: variable.collectorId, variableId: variable.id, variableKey: variable.key, variableLabel: variable.label,
      method: engagementOcr ? "VISUAL_OCR" : selectedOutput.method, attribute: engagementOcr ? undefined : selectedOutput.attribute,
      relativePath: path, relativeXPath: engagementOcr ? "" : (path.length ? relativeXPathForPath(path) : ""),
      preview: verifiedPreview,
      sourceContext: selectedData.context, sourceSemantic: selectedData.semanticField, outputKey: selectedOutput.key, confirmed: true, updatedAt: new Date().toISOString(),
    };
    onVariableMappings([
      ...variableMappings.filter(item =>
        !(item.collectorId === mapping.collectorId && item.variableId === mapping.variableId) &&
        (engagementOcr || selectedData.semanticField === "post_images" || selectedData.semanticField === "content"
          ? item.sourceSemantic !== selectedData.semanticField
          : !(samePath(item.relativePath, path) && (item.outputKey || "") === selectedOutput.key))),
      mapping,
    ]);
  };
  const unmapData = () => {
    if (!selectedData || !selectedOutput) return;
    if (isEngagementOcrItem(selectedData) || selectedData.semanticField === "post_images" || selectedData.semanticField === "content") {
      onVariableMappings(variableMappings.filter(mapping => mapping.sourceSemantic !== selectedData.semanticField));
    } else {
      onVariableMappings(variableMappings.filter(mapping => !(selectedData.sourcePaths.some(path => samePath(path, mapping.relativePath)) && (mapping.outputKey ? mapping.outputKey === selectedOutput.key : mapping.preview === selectedOutput.value))));
    }
    setVariableId("");
  };
  const hideData = (item: ExtractedDataItem) => { onHiddenExtractedData({ ...hiddenExtractedData, [postId]: Array.from(new Set([...manuallyHidden, item.id])) }); if (selectedDataId === item.id) setSelectedDataId(""); };
  const restoreHidden = () => onHiddenExtractedData({ ...hiddenExtractedData, [postId]: [] });
  const mappingRows = variableMappings.map(mapping => {
    const executed = executeVariableMapping(parsed, mapping, { postId, currentUrl, engagementResult: engagementResult?.postId === postId ? engagementResult : undefined });
    const mappingStatus = executed.status === "mapped" ? "Mapped" : executed.status === "needs_attention" ? "Needs Attention" : "Missing";
    return { mapping, value: executed.value, mappingStatus };
  });
  const breadcrumbs = focusPath.map((_, index) => focusPath.slice(0, index + 1));
  const rematch = () => { void invoke({ type: "postDetailClearParentNodeHighlight" }); onRematch(); };
  const engagementBusyRef = useRef(false);
  const captureEngagement = async (_opts?: { reason?: "manual" | "auto-after-match" }) => {
    if (status !== "PARENT_MATCHED" || !parentConfig || engagementBusyRef.current) return;
    const epoch = ++engagementJobEpochRef.current;
    engagementBusyRef.current = true;
    setEngagementBusy(true); setEngagementError("");
    try {
      const activeRunId = runId || `pd_${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}_engagement`;
      const captured = await invoke<PostDetailEngagementOcrResult>({ type: "postDetailCaptureEngagement", runId: activeRunId, postId, config: parentConfig });
      if (epoch !== engagementJobEpochRef.current) return;
      setEngagementPreview(captured.previewDataUrl || "");
      onEngagementResult(captured);
    } catch (error) {
      if (epoch !== engagementJobEpochRef.current) return;
      setEngagementError(String(error));
    } finally {
      if (epoch === engagementJobEpochRef.current) {
        engagementBusyRef.current = false;
        setEngagementBusy(false);
      }
    }
  };
  // Step 3: after Parent Match, auto-scroll (inside capture) then Capture/OCR once.
  // Detail Review / cached-only opens must not auto-scroll or auto-capture.
  useEffect(() => {
    if (reviewMode) return;
    if (status !== "PARENT_MATCHED" || !parentConfig) return;
    const key = `${postId}:${runId || "norun"}`;
    if (autoCaptureDoneKeyRef.current === key) return;
    if (engagementResult?.postId === postId && engagementResult.status === "VERIFIED") {
      autoCaptureDoneKeyRef.current = key;
      return;
    }
    autoCaptureDoneKeyRef.current = key;
    void captureEngagement({ reason: "auto-after-match" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, postId, runId, reviewMode, parentConfig]);
  const reprocessSavedEngagementCrop = async () => {
    if (engagementBusy || !engagementResult?.runId || engagementResult.postId !== postId) return;
    setEngagementBusy(true); setEngagementError("");
    try {
      const captured = await invoke<PostDetailEngagementOcrResult>({
        type: "postDetailReprocessEngagementCrop",
        runId: engagementResult.runId,
        postId,
      });
      setEngagementPreview(captured.previewDataUrl || "");
      onEngagementResult(captured);
    } catch (error) { setEngagementError(String(error)); }
    finally { setEngagementBusy(false); }
  };

  const engagementData = visibleData.filter(item => item.kind === "engagement");
  const generalData = visibleData.filter(item => item.kind !== "engagement");
  const highlightBlocked = Boolean(reviewMode?.staleDomWarning && !reviewMode.staleDomWarning.startsWith("Live data value changed"));
  const highlightNodePath = (path: number[]) => {
    if (highlightBlocked) return;
    void invoke({ type: "postDetailHighlightParentNode", path });
  };
  const renderDataTag = (item: ExtractedDataItem) => {
    const mappings = mappingsForItem(item);
    const mappingStatus = isEngagementOcrItem(item)
      ? mappings.length ? "Auto Mapped" : suggestedVariable(item) ? "Suggested" : "Unmapped"
      : (item.sourcePaths.length > 1 && item.semanticField !== "content") || item.extractionStatus === "needs_attention" ? "Needs Attention" : mappings.length ? "Auto Mapped" : suggestedVariable(item) ? "Suggested" : "Unmapped";
    const displayLabel = item.kind === "engagement"
      ? item.value
        ? `${item.label || item.semanticField}: ${item.value}`
        : `${item.label || item.semanticField}: unresolved`
      : item.semanticField === "post_images"
        ? `Post Images (${item.mediaItems?.length ?? 0})`
        : (item.label || item.value);
    return <span key={item.id} className="pdc-data-tag-wrap" onMouseEnter={() => { if (item.sourcePaths.length === 1) highlightNodePath(item.sourcePaths[0]); }} onMouseLeave={() => { void invoke({ type: "postDetailClearParentNodeHighlight" }); }}><button type="button" title={item.value || displayLabel} className={`pdc-data-tag status-${mappingStatus.toLowerCase().replace(/\s+/g, "-")} ${selectedDataId === item.id ? "selected" : ""}`} onClick={() => selectData(item)}>
      <span className="pdc-data-value">{displayLabel}</span>{item.engagementEvidence && <small className="pdc-engagement-evidence">Anchor: {item.engagementEvidence.actionAnchorStatus} · Count: {item.engagementEvidence.countSourceStatus} · {item.engagementEvidence.method} · {item.engagementEvidence.reason}</small>}
    </button><button type="button" className="pdc-data-hide" aria-label={`Hide ${displayLabel}`} onClick={() => hideData(item)}>×</button></span>;
  };

  const reviewFieldForSelected = useMemo(() => {
    if (!reviewMode || !selectedData) return null;
    const mapped = selectedOutput ? mappingForOutput(selectedData, selectedOutput) : mappingsForItem(selectedData)[0];
    if (!mapped) return null;
    return reviewMode.row.fields.find(f => f.variableId === mapped.variableId) || null;
  }, [reviewMode, selectedData, selectedOutput, variableMappings]);
  const reviewCanonicalUrl = reviewMode ? canonicalPostUrl(reviewMode.row.url, reviewMode.row.postId) : "";

  usePostProcessingToolbar(
    !reviewMode
      ? {
          statusLabel:
            status === "PARENT_MATCHED"
              ? "AUTO · Parent Matched"
              : status === "RESOLVING"
                ? "AUTO · Resolving Parent..."
                : `Needs Attention · ${result?.failureCode || status}`,
          statusTone: status === "PARENT_MATCHED" ? "live" : "frozen",
          primaryAction: onNextBatchValidation
            ? {
                id: "batch-validation",
                label: "Batch Validation →",
                tone: "primary",
                onClick: onNextBatchValidation,
              }
            : {
                id: "rematch-parent",
                label: "Customize · Rematch Parent",
                tone: "primary",
                onClick: rematch,
              },
          directActions: [
            ...(onBackToLibrary
              ? [
                  {
                    id: "post-library",
                    label: "← Post Library",
                    tone: "secondary" as const,
                    onClick: onBackToLibrary,
                  },
                ]
              : []),
            {
              id: "manage-variables",
              label: "Manage Variables",
              active: variablesOpen,
              tone: "secondary",
              onClick: openVariablesDrawer,
            },
            ...(onNextBatchValidation
              ? [
                  {
                    id: "rematch-parent",
                    label: "Customize · Rematch Parent",
                    tone: "secondary" as const,
                    onClick: rematch,
                  },
                ]
              : []),
            ...(status !== "NOT_CONFIGURED"
              ? [
                  {
                    id: "toggle-panel",
                    label: sidebarCollapsed ? "Show Panel" : "Hide Panel",
                    active: !sidebarCollapsed,
                    tone: "secondary" as const,
                    onClick: () => setSidebarCollapsed((value) => !value),
                  },
                ]
              : []),
          ],
          moreActions: [
            {
              id: "toggle-expand",
              label: isExpanded ? "Restore" : "Expand",
              active: isExpanded,
              onClick: () => setIsExpanded((value) => !value),
            },
          ],
        }
      : null,
  );

  return <div className={`pdc-step pdc-step3 ${isExpanded ? "pdc-explorer-expanded" : ""}`}>
    {reviewMode ? (
      <div className="pdc-compact-toolbar">
        <div className="pdc-review-compact-meta">
          <span className="pdc-toolbar-title">Detail Review ({reviewMode.rowIndex + 1}/{reviewMode.totalRows})</span>
          <span>{reviewMode.row.postId ? `Post #${reviewMode.row.postId}` : "Post identity unavailable"}</span>
          <span className={`pdc-batch-pill status-${reviewMode.row.status.toLowerCase()}`}>{reviewMode.row.status}</span>
          <button type="button" className="pdc-btn pdc-btn-tiny" onClick={() => copy(reviewCanonicalUrl)}>Copy Link</button>
          <details className="pdc-review-url-details"><summary>View URL Details</summary><code>{reviewMode.row.url}</code>{reviewMode.row.resolvedUrl && reviewMode.row.resolvedUrl !== reviewMode.row.url ? <code>{reviewMode.row.resolvedUrl}</code> : null}</details>
        </div>
        <div className="pdc-btn-row">
          <button type="button" className="pdc-btn pdc-btn-secondary pdc-btn-compact" onClick={reviewMode.onBackToResults}>← Back to Results</button>
          <button type="button" className="pdc-btn pdc-btn-secondary pdc-btn-compact" disabled={!reviewMode.canPrev} onClick={reviewMode.onPrevPost}>← Previous Post</button>
          <button type="button" className="pdc-btn pdc-btn-secondary pdc-btn-compact" disabled={!reviewMode.canNext} onClick={reviewMode.onNextPost}>Next Post →</button>
          <button type="button" className="pdc-btn pdc-btn-primary pdc-btn-compact" onClick={reviewMode.onCustomizeInStep3}>Customize in Step 3</button>
        </div>
      </div>
    ) : null}
    {reviewMode?.staleDomWarning && <div className="pdc-alert pdc-alert-warn" role="status">{reviewMode.staleDomWarning}</div>}
    {variablesOpen && <UiPopover variant="drawer" label="Manage Variables" close={() => setVariablesOpen(false)} className="variables-drawer pdc-variables-drawer">
      <div className="popover-heading pdc-variables-drawer-header"><div><b>Variables</b><p className="pdc-panel-desc">Shared Collector Variable schema · edits do not overwrite source mappings.</p></div><button type="button" className="icon-button" aria-label="Close Variables" onClick={() => setVariablesOpen(false)}>×</button></div>
      <div className="pdc-variables-drawer-toolbar">
        {collectors.length > 1 && <select aria-label="Target Collector" value={activeCollector?.id || ""} onChange={event => refreshVariables(event.target.value)}>{collectors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
        <button type="button" className="pdc-btn pdc-btn-primary pdc-btn-tiny" onClick={handleAddVariable}>+ Add Variable</button>
      </div>
      {varError && <p className="pdc-alert pdc-alert-warn" role="alert">{varError}</p>}
      <div className="pdc-variables-drawer-list">
        {activeCollector && draftVars.length ? draftVars.map(v => {
          const mappedCount = countMappingsForVariable(variableMappings, activeCollector.id, v.id);
          return <div key={v.id} className="pdc-variable-row">
            <input aria-label={`Label for ${v.key}`} value={v.label} placeholder="Label" onChange={event => patchDraftVar(v.id, { label: event.target.value })} onBlur={() => commitVariable(activeCollector.id, v.id)} />
            <input aria-label={`Key for ${v.key}`} value={v.key} placeholder="key" onChange={event => patchDraftVar(v.id, { key: event.target.value })} onBlur={() => commitVariable(activeCollector.id, v.id)} />
            <select aria-label={`Type for ${v.key}`} value={v.valueType} onChange={event => { const nextType = event.target.value as CollectorValueType; patchDraftVar(v.id, { valueType: nextType }); commitVariable(activeCollector.id, v.id, { valueType: nextType }); }}>{COLLECTOR_VALUE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select>
            <label className="pdc-var-req"><input type="checkbox" checked={v.required} onChange={event => { const nextReq = event.target.checked; patchDraftVar(v.id, { required: nextReq }); commitVariable(activeCollector.id, v.id, { required: nextReq }); }} />Req</label>
            <span className="pdc-var-mapped">{mappedCount ? `${mappedCount} mapped` : "—"}</span>
            <button type="button" className="pdc-btn pdc-btn-tiny" aria-label={`Delete ${v.key}`} onClick={() => handleDeleteVariable(activeCollector.id, v.id)}>×</button>
          </div>;
        }) : <p className="pdc-panel-desc">No variables yet. Click + Add Variable to create one.</p>}
      </div>
    </UiPopover>}
    {status !== "NOT_CONFIGURED" && <BrowserWorkspace className={`pdc-dom-workspace ${browserCollapsed ? "browser-collapsed" : ""}`}><BrowserScrollArea sidebarCollapsed={sidebarCollapsed}><div className="pdc-dom-browser-wrap"><button className="pdc-btn pdc-btn-tiny" onClick={() => setBrowserCollapsed(value => !value)}>{browserCollapsed ? "Show Browser Preview" : "Collapse Browser Preview"}</button>{!browserCollapsed && <div className="rpa-browser-stage"><BrowserHost hostRef={hostRef} className="pdc-dom-browser">{sidebarOccludesBrowser && <div className="pdc-browser-occluded-notice" role="status"><strong>Preview Mode · BrowserCore tạm ẩn</strong><p>Panel Extracted Data đang mở đè lên vùng 1024×560 trên cửa sổ hẹp. Thu gọn panel để hiện lại live BrowserCore 1024×560.</p><button type="button" className="pdc-btn pdc-btn-primary pdc-btn-compact" onClick={() => setSidebarCollapsed(true)}>Thu gọn Panel → Xem Live 1024×560</button></div>}</BrowserHost></div>}</div></BrowserScrollArea><SidebarDrawer title="Extracted Data" collapsed={sidebarCollapsed} onToggleCollapse={() => { setSidebarCollapsed(value => !value); if (!browserCollapsed) requestAnimationFrame(() => publishPostDetailBrowserHost(invoke, hostRef.current)); }} className="pdc-dom-panel">
      {status === "PARENT_MATCHED" ? <><div className={`pdc-data-review ${selectedData ? "has-detail" : ""}`}>
        <div className="pdc-data-list" aria-label="Extracted values">
          <div className="pdc-data-list-header"><h3>Extracted values</h3><div className="pdc-btn-row"><span>{visibleData.length} shown · {hiddenCount} hidden</span><button className="pdc-btn pdc-btn-tiny" onClick={() => setShowHidden(value => !value)}>{showHidden ? "Hide Noise" : "Show Hidden"}</button><button className="pdc-btn pdc-btn-tiny" disabled={!manuallyHidden.length} onClick={restoreHidden}>Restore</button></div></div>
          {engagementData.length > 0 && <div className="pdc-engagement-group" aria-label="Engagement"><div className="pdc-data-list-header"><h4>Engagement · Visual OCR</h4><div className="pdc-btn-row">{engagementResult?.runId && engagementResult.postId === postId && <button type="button" className="pdc-btn pdc-btn-tiny" disabled={engagementBusy} onClick={() => void reprocessSavedEngagementCrop()} title="Re-run current OCR pipeline on the saved crop bytes">{engagementBusy ? "Reprocessing…" : "Reprocess saved crop"}</button>}<button type="button" className="pdc-btn pdc-btn-primary pdc-btn-tiny" disabled={engagementBusy || status !== "PARENT_MATCHED" || !parentConfig} onClick={() => void captureEngagement()}>{engagementBusy ? "Capturing…" : engagementResult ? "Recapture Engagement" : "Capture Engagement"}</button></div></div>{engagementError && <p className="pdc-alert pdc-alert-warn" role="alert"><strong>Capture failed</strong> · {engagementError}</p>}{engagementPreview ? <figure className="pdc-engagement-preview"><img src={engagementPreview} alt={`Engagement crop for post ${postId}`} /><figcaption>Engagement crop · Post #{postId}</figcaption></figure> : engagementResult?.status === "NO_COUNT_REGION" ? <div className="pdc-alert pdc-alert-warn pdc-engagement-geometry" role="status"><strong>{engagementResult.diagnostics[0] || "NO_COUNT_REGION"}</strong><span>{engagementResult.diagnostics.slice(1).join(" · ") || "No visible Engagement count region."}</span><code>Action Row: {engagementResult.rowRect ? `x=${Math.round(engagementResult.rowRect.x)}, y=${Math.round(engagementResult.rowRect.y)}, ${Math.round(engagementResult.rowRect.width)}×${Math.round(engagementResult.rowRect.height)}` : "geometry unavailable"} · viewport 1024×560</code></div> : <p className="pdc-panel-desc">No Engagement crop captured for this post.</p>}<div className="pdc-engagement-tags">{engagementData.map(renderDataTag)}</div>{engagementResult && <p className="pdc-panel-desc">Coverage {Object.values(engagementResult.fields).filter(field => field.status === "verified").length}/3 · {engagementResult.status} · {engagementResult.capturedAt}</p>}</div>}
          {generalData.length ? generalData.map(renderDataTag) : !engagementData.length ? <p className="pdc-panel-desc">No meaningful DOM values were extracted from this Parent.</p> : null}
        </div>
        {selectedData && <div className="pdc-extracted-detail"><div className="pdc-detail-header"><h3>Value detail</h3><button type="button" className="pdc-btn pdc-btn-secondary pdc-btn-tiny" onClick={() => { setSelectedDataId(""); setSelectedOutputKey(""); }}>← Back to Extracted Values</button></div>
          <dl className="pdc-kv pdc-kv-compact">
            <div className="pdc-kv-item"><dt>Field</dt><dd>{selectedData.semanticField || selectedData.kind}</dd></div>
            <div className="pdc-kv-item"><dt>Type</dt><dd>{selectedData.predictedType || selectedData.kind}</dd></div>
            <div className="pdc-kv-item"><dt>Context</dt><dd>{selectedData.context}</dd></div>
            <div className="pdc-kv-item"><dt>Confidence</dt><dd>{selectedData.confidence} · {selectedData.extractionStatus}</dd></div>
            {selectedData.sourceAttribute && <div className="pdc-kv-item"><dt>Attr</dt><dd>{selectedData.sourceAttribute}</dd></div>}
            <div className="pdc-kv-item"><dt>Source</dt><dd>{isEngagementOcrItem(selectedData) ? "Visual OCR" : selectedData.sourcePaths.length === 1 ? "Unique DOM node" : selectedData.semanticField === "content" ? `${selectedData.sourcePaths.length} ordered body nodes` : `${selectedData.sourcePaths.length} nodes · Needs Attention`}</dd></div>
            <div className="pdc-kv-item pdc-kv-wide"><dt>Value</dt><dd className="pdc-preserve-lines">{selectedOutput?.value || selectedData.value || (isEngagementOcrItem(selectedData) ? "unresolved" : "")}</dd></div>
          </dl>
          {selectedData.semanticField === "post_images" && (
            <div className="pdc-media-preview-list" aria-label="Post Images Preview">
              <div className="pdc-media-preview-head">
                <b>Post Media ({selectedData.mediaItems?.length ?? 0} images)</b>
                {selectedData.extractionStatus === "needs_attention" && <span className="pdc-data-warning">Lazy-loaded or unresolved media</span>}
              </div>
              {selectedData.mediaItems?.length ? (
                <div className="pdc-media-grid">
                  {selectedData.mediaItems.map((media, idx) => (
                    <div
                      key={`${media.url}:${idx}`}
                      className="pdc-media-card"
                      onMouseEnter={() => highlightNodePath(media.sourcePath)}
                      onMouseLeave={() => { void invoke({ type: "postDetailClearParentNodeHighlight" }); }}
                    >
                      {failedThumbUrls.has(media.url) ? (
                        <div className="pdc-media-fallback">Image preview unavailable</div>
                      ) : (
                        <img
                          src={media.url}
                          alt={`Post image ${idx + 1}`}
                          loading="lazy"
                          onError={() => setFailedThumbUrls(prev => new Set(prev).add(media.url))}
                        />
                      )}
                      <div className="pdc-media-meta">
                        <span className="pdc-media-quality">{media.quality} · {media.sourceAttr}</span>
                        <button
                          type="button"
                          className="pdc-btn pdc-btn-tiny"
                          onClick={() => {
                            copy(media.url);
                            setCopiedThumbUrl(media.url);
                            setTimeout(() => setCopiedThumbUrl(""), 1500);
                          }}
                        >
                          {copiedThumbUrl === media.url ? "Copied!" : "Copy URL"}
                        </button>
                      </div>
                      <code className="pdc-media-url" title={media.url}>{media.url}</code>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="pdc-panel-desc">No post media detected (valid empty array [] for text-only post).</p>
              )}
            </div>
          )}
          {reviewFieldForSelected && (
            <div className="pdc-review-field-badge">
              <span className={`pdc-batch-pill status-${reviewFieldForSelected.status.toLowerCase()}`}>
                {reviewFieldForSelected.fieldStatus || reviewFieldForSelected.status}
              </span>
              {reviewFieldForSelected.reason && <span className="pdc-data-warning">{reviewFieldForSelected.reason}</span>}
            </div>
          )}
          {selectedData.outputs.length > 1 && <label>Output<select value={selectedOutput?.key || ""} onChange={event => { const output = selectedData.outputs.find(item => item.key === event.target.value); if (output) selectOutput(selectedData, output); }}>{selectedData.outputs.map(output => <option key={output.key} value={output.key}>{output.label}</option>)}</select></label>}
          <p className="pdc-data-detail-status">{(() => {
            const mapped = selectedOutput ? mappingForOutput(selectedData, selectedOutput) : undefined;
            if (mapped && isEngagementOcrItem(selectedData)) {
              return selectedData.extractionStatus === "verified" && selectedData.value
                ? `Mapping Saved · OCR verified → ${mapped.variableLabel}`
                : `Mapping Saved · OCR Pending → ${mapped.variableLabel}`;
            }
            if (mapped) return `Mapped → ${mapped.variableLabel}`;
            if (suggestedVariable(selectedData)) return `Suggested → ${suggestedVariable(selectedData)?.label}`;
            if (isEngagementOcrItem(selectedData)) return "Unmapped · OCR Pending";
            return selectedData.extractionStatus === "needs_attention" ? "Needs Attention" : "Unmapped";
          })()}</p>
          {mappingsForItem(selectedData).length > 0 && <div className="pdc-output-mappings"><b>Output mappings</b>{mappingsForItem(selectedData).map(mapping => <span key={`${mapping.variableId}:${mapping.outputKey || mapping.preview}`}>{mapping.outputKey || "legacy"} → {mapping.variableLabel}</span>)}</div>}
          {variables.length ? <><select value={variableId} onChange={event => setVariableId(event.target.value)}><option value="">Select existing variable…</option>{variables.map(variable => {
            const blocked = isEngagementOcrItem(selectedData) ? engagementVariableBlockReason(variable.valueType) : "";
            return <option key={`${variable.collectorId}:${variable.id}`} value={`${variable.collectorId}:${variable.id}`} disabled={Boolean(blocked)}>{variable.collectorName} · {variable.label} ({variable.key}){blocked ? ` · ${blocked}` : ""}</option>;
          })}</select>{isEngagementOcrItem(selectedData) && variableId && (() => {
            const selectedVar = variables.find(entry => `${entry.collectorId}:${entry.id}` === variableId);
            const blocked = selectedVar ? engagementVariableBlockReason(selectedVar.valueType) : "";
            return blocked ? <p className="pdc-alert pdc-alert-warn" role="status">{blocked}</p> : null;
          })()}<p>Preview: <span className="pdc-preserve-lines">{selectedOutput?.value || selectedData.value || (isEngagementOcrItem(selectedData) ? "(null · unresolved)" : "")}</span></p><div className="pdc-btn-row pdc-detail-actions"><button className="pdc-btn pdc-btn-primary" disabled={!canMapSelectedData(selectedData, selectedOutput)} onClick={applyDataMapping}>Save Mapping</button><button className="pdc-btn pdc-btn-secondary" disabled={!selectedOutput || !mappingForOutput(selectedData, selectedOutput)} onClick={unmapData}>Unmap Output</button></div></> : <p className="pdc-panel-desc">No existing Collector variables. Create schema in Collectors first.</p>}
        </div>}
      </div><details className="pdc-advanced-debug"><summary>Advanced Debug</summary>{result?.diagnostics.map(item => <p key={item} className="pdc-panel-desc">{item}</p>)}<p className="pdc-panel-desc">Strategy {String(result?.diagnosticMeta?.strategyId || "platform fallback")} · version {String(result?.diagnosticMeta?.strategyVersion || parentConfig?.version || "legacy")}</p>
        {engagementResult?.postId === postId && <div className="pdc-engagement-ocr-debug" aria-label="Engagement OCR evidence">
          <h4>Engagement OCR evidence</h4>
          {engagementPreview && <figure className="pdc-engagement-preview"><img src={engagementPreview} alt={`Engagement crop debug for post ${postId}`} /><figcaption>Engagement crop · Post #{postId}</figcaption></figure>}
          <p className="pdc-panel-desc">Status {engagementResult.status} · confidence {Math.round(engagementResult.ocrConfidence || 0)} · coverage {Object.values(engagementResult.fields).filter(field => field.status === "verified").length}/3</p>
          <p className="pdc-panel-desc">Crop identity: <code>{engagementResult.cropSha256 || "(missing sha256 — recapture with current build)"}</code></p>
          <p className="pdc-panel-desc">Preprocess variant: <code>{engagementResult.preprocessVariant || engagementResult.diagnostics.find(item => item.startsWith("ocr_preprocess:")) || "(unknown)"}</code></p>
          <p className="pdc-panel-desc">Auto-scroll: <code>{engagementResult.diagnostics.filter(item => /^(engagement_auto_scroll|scroll_adjustments|saved_scroll_hint|scrollable_ancestor|action_row_rect_|scroll_after|visibility|adjust:)/i.test(item)).join(" · ") || "(none)"}</code></p>
          <p className="pdc-panel-desc">Persisted: run <code>{engagementResult.runId}</code> · post <code>{engagementResult.postId}</code> · capture <code>{engagementResult.captureId || "—"}</code> · evidence <code>{engagementResult.evidencePath || "—"}</code></p>
          <p className="pdc-panel-desc">Raw OCR: <code>{engagementResult.rawOcrText || "(empty)"}</code></p>
          <p className="pdc-panel-desc">Numeric segments: <code>{(engagementResult.segments || []).filter(segment => /\d/.test(segment.text)).map(segment => `${segment.text}@${Math.round(segment.bbox.x)},${Math.round(segment.bbox.y)}(${Math.round(segment.confidence)})`).join(" · ") || "(none)"}</code></p>
          <div className="pdc-parent-table-wrap"><table className="pdc-parent-table"><thead><tr><th>Role</th><th>Value</th><th>Status</th><th>Failure reason</th><th>Assigned segments</th></tr></thead><tbody>{(["like_count", "comment_count", "share_count"] as const).map(field => { const evidence = engagementResult.fields[field]; return <tr key={field}><td>{field}</td><td>{evidence.value == null ? "null" : evidence.value}</td><td>{evidence.status}</td><td>{evidence.failureReason || (evidence.status === "verified" ? "—" : "UNRESOLVED_ROLE")}</td><td>{evidence.segmentIds?.join(", ") || "—"}</td></tr>; })}</tbody></table></div>
          <div className="pdc-parent-table-wrap"><table className="pdc-parent-table"><thead><tr><th>Seg</th><th>Text</th><th>Conf</th><th>BBox</th><th>Kind</th></tr></thead><tbody>{(engagementResult.segments || []).map(segment => <tr key={segment.id}><td>{segment.id}</td><td>{segment.text}</td><td>{Math.round(segment.confidence)}</td><td>{Math.round(segment.bbox.x)},{Math.round(segment.bbox.y)} {Math.round(segment.bbox.width)}×{Math.round(segment.bbox.height)}</td><td>{segment.kind}</td></tr>)}</tbody></table></div>
          {engagementResult.diagnostics.filter(item => /reject/i.test(item)).length > 0 && <div className="pdc-panel-desc"><b>Rejected segments:</b><ul>{engagementResult.diagnostics.filter(item => /reject/i.test(item)).map((item, index) => <li key={`rej-${index}`}>{item}</li>)}</ul></div>}
          {engagementResult.diagnostics.length > 0 && <p className="pdc-panel-desc">Diagnostics: {engagementResult.diagnostics.join(" · ")}</p>}
          {/ocr_preprocess:normalize\b/i.test(engagementResult.diagnostics.join(" ")) && <p className="pdc-alert pdc-alert-warn" role="status">This result was produced by the legacy normalize preprocess. Recapture Engagement to run the current left-focus pipeline.</p>}
        </div>}
        <div className="pdc-parent-table-wrap"><table className="pdc-parent-table"><thead><tr><th>Field</th><th>Saved Anchor</th><th>Live Anchor</th><th>Count Source</th><th>Value</th><th>Source / failure</th></tr></thead><tbody>{(["like_count", "comment_count", "share_count"] as const).map(field => { const item = engagementData.find(candidate => candidate.semanticField === field); const role = field.replace("_count", "_anchor") as "like_anchor" | "comment_anchor" | "share_anchor"; const saved = parentConfig?.domAnchors?.[role]; return <tr key={field}><td>{field.replace("_count", "").toUpperCase()}</td><td>{saved ? `${saved.verificationStatus} · ${saved.parentRelativePath.join("/")}` : "MISSING"}</td><td>{item?.engagementEvidence?.actionAnchorStatus || "MISSING"}</td><td>{item?.engagementEvidence?.countSourceStatus || "MISSING"}</td><td>{item?.value || "—"}</td><td>{item?.sourcePaths.map(path => path.join("/")).join(", ") || item?.engagementEvidence?.reason || "NO_SOURCE"}</td></tr>; })}</tbody></table></div><div className="pdc-btn-row"><button className={`pdc-btn pdc-btn-tiny ${tab === "explorer" ? "active" : ""}`} onClick={() => setTab("explorer")}>DOM Explorer</button><button className={`pdc-btn pdc-btn-tiny ${tab === "raw" ? "active" : ""}`} onClick={() => setTab("raw")}>Raw HTML</button><button className="pdc-btn pdc-btn-tiny" disabled={!focusPath.length} onClick={resetFocus}>Reset Focus</button></div>
      {tab === "raw" ? <pre className="pdc-code-preview">{result?.innerHTML}</pre> : <><div className="pdc-dom-breadcrumb"><button onClick={resetFocus}>Root</button>{breadcrumbs.map(path => <button key={pathKey(path)} onClick={() => setFocusPath(path)}>› {atPath(path)?.tagName.toLowerCase()}</button>)}</div><label className="pdc-split-control">Tree width <input type="range" min="30" max="75" value={treeRatio} onChange={event => setTreeRatio(Number(event.target.value))} /></label><div className="pdc-dom-columns" style={{ gridTemplateColumns: `${treeRatio}fr ${100 - treeRatio}fr` }}><div className="pdc-dom-tree"><ul>{nodes.map(node => <TreeNode key={pathKey(node.path)} node={node} expanded={expanded} selected={selected ? pathKey(selected.path) : ""} onToggle={key => setExpanded(current => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next; })} onSelect={choose} onFocus={focus} onHover={highlight} />)}</ul></div><div className="pdc-dom-inspector"><h3>Inspector</h3>{selected ? <>
        <section><h4>Attributes</h4><dl className="pdc-kv">{Object.entries(selected.attrs).map(([name, value]) => <React.Fragment key={name}><dt>{name}</dt><dd>{value}</dd></React.Fragment>)}</dl></section>
        <section><h4>Text</h4><p>{selected.directText || selected.textPreview || "—"}</p><button className="pdc-btn pdc-btn-tiny" onClick={() => copy(selected.element.textContent || "")}>Copy Text</button><details><summary>Full text</summary><pre>{selected.element.textContent}</pre></details><details><summary>outerHTML</summary><pre>{selected.element.outerHTML}</pre></details></section>
        <section><h4>Selector</h4><code>{relativeXPath(selected.path)}</code><div className="pdc-btn-row"><button className="pdc-btn pdc-btn-tiny" onClick={() => copy(relativeXPath(selected.path))}>Copy XPath</button><button className="pdc-btn pdc-btn-tiny" onClick={() => copy(relativeSelector(selected.path))}>Copy Selector</button></div></section>
        <section><h4>Variables</h4>{variables.length ? <><select value={variableId} onChange={event => setVariableId(event.target.value)}><option value="">Select existing variable…</option>{variables.map(variable => <option key={`${variable.collectorId}:${variable.id}`} value={`${variable.collectorId}:${variable.id}`}>{variable.collectorName} · {variable.label} ({variable.key})</option>)}</select><select value={method} onChange={event => setMethod(event.target.value as typeof method)}><option value="DOM_TEXT">text</option><option value="DOM_ATTRIBUTE">attribute</option></select>{method === "DOM_ATTRIBUTE" && <input value={attribute} onChange={event => setAttribute(event.target.value)} placeholder="href" />}<p>Preview: {selectedValue || "Missing / Needs Attention"}</p><p>Locator matches: {selectedMatchCount} {selectedMatchCount === 1 ? "· verified" : "· Needs Attention"}</p><button className="pdc-btn pdc-btn-primary" disabled={!variableId || !selectedValue || selectedMatchCount !== 1} onClick={saveMapping}>Confirm Mapping</button></> : <p className="pdc-panel-desc">No existing Collector variables. Create schema in Collectors first.</p>}</section>
      </> : <p className="pdc-panel-desc">Chọn một node. Double-click để Focus Root.</p>}</div></div><section className="pdc-variable-status"><h3>Confirmed mappings</h3>{mappingRows.length ? mappingRows.map(({ mapping, value, mappingStatus }) => <div key={`${mapping.collectorId}:${mapping.variableId}`}><b>{mapping.variableLabel}</b> · <span>{mappingStatus}</span> · {value || "—"}</div>) : <p className="pdc-panel-desc">Unmapped · chưa có mapping đã xác nhận.</p>}</section></>}</details></> : status === "RESOLVING" ? <div><h3>Resolving Parent...</h3><p className="pdc-panel-desc">{result?.diagnostics?.[result.diagnostics.length - 1] || "Verifying post identity, Action Row ownership, and Parent stability..."}</p><p className="pdc-panel-desc">Strategy: {String(result?.diagnosticMeta?.strategyId || "selecting")} · Attempt: {String(result?.diagnosticMeta?.attempt ?? 0)}/{String(result?.diagnosticMeta?.maxAttempts ?? 10)} · Elapsed: {String(result?.diagnosticMeta?.elapsedMs ?? 0)}ms</p><details className="pdc-advanced-debug"><summary>Advanced Debug</summary><p className="pdc-panel-desc">Strategy {String(result?.diagnosticMeta?.strategyId || "pending")} ({String(result?.diagnosticMeta?.strategyIndex ?? 0)}/{String(result?.diagnosticMeta?.totalStrategies ?? 0)}) · Attempt {String(result?.diagnosticMeta?.attempt ?? 0)}/{String(result?.diagnosticMeta?.maxAttempts ?? 10)} · Elapsed {String(result?.diagnosticMeta?.elapsedMs ?? 0)}ms</p>{result?.diagnostics?.map((item, idx) => <p key={`${idx}:${item}`} className="pdc-panel-desc">{item}</p>)}{result?.diagnosticMeta && <pre className="pdc-code-preview">{JSON.stringify(result.diagnosticMeta, null, 2)}</pre>}</details></div> : <div><h3>{status === "CANCELLED" ? "Auto Match cancelled" : "Parent resolution failed"}</h3><p className="pdc-panel-desc">AUTO did not accept a Parent without identity, Action Row ownership, and Parent validation.</p><p className="pdc-panel-desc">Failure: <b>{result?.failureCode || status}</b> · Strategy: <code>{String(result?.diagnosticMeta?.strategyId || "platform fallback")}</code></p>{result?.diagnostics?.map((item, idx) => <p key={`${idx}:${item}`} className="pdc-panel-desc">{item}</p>)}<div className="pdc-btn-row">{onRetryAutoMatch && <button type="button" className="pdc-btn pdc-btn-primary" onClick={onRetryAutoMatch}>Retry Auto Match</button>}<button type="button" className="pdc-btn pdc-btn-secondary" onClick={rematch}>Customize · Rematch Parent</button></div><details className="pdc-advanced-debug"><summary>Advanced Debug</summary><p className="pdc-panel-desc">Strategy {String(result?.diagnosticMeta?.strategyId || "platform fallback")} · Attempt {String(result?.diagnosticMeta?.attempt ?? 0)}/{String(result?.diagnosticMeta?.maxAttempts ?? 10)} · Elapsed {String(result?.diagnosticMeta?.elapsedMs ?? 0)}ms</p>{result?.diagnosticMeta && <pre className="pdc-code-preview">{JSON.stringify(result.diagnosticMeta, null, 2)}</pre>}</details></div>}
    </SidebarDrawer></BrowserWorkspace>}
  </div>;
}
