import React, { useEffect, useMemo, useRef, useState } from "react";
import type { PostDetailSavedParentResolution } from "../../shared/post-detail-collector/types";
import type { CollectorValueType, CollectorVariable } from "../../shared/collectors/types";
import { collectorReportBrowserHost, collectorSetBrowserVisible } from "../collectors/browser-capture";
import { claimCollectorHostOwner, releaseCollectorHostOwner } from "../collectors/collector-host-owner";
import { UiPopover } from "../ui-popover";
import { publishPostDetailBrowserHost } from "./publish-browser-host";
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
import type { Invoke, PostDetailDomVariableMapping } from "./types";

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

export function SavedParentHtmlStep({ invoke, result, currentUrl, variableMappings, onVariableMappings, hiddenExtractedData, onHiddenExtractedData, onVariablesChanged, onRematch, onNextBatchValidation }: { invoke: Invoke; result: PostDetailSavedParentResolution | null; currentUrl: string; variableMappings: PostDetailDomVariableMapping[]; onVariableMappings: (mappings: PostDetailDomVariableMapping[]) => void; hiddenExtractedData: Record<string, string[]>; onHiddenExtractedData: (hidden: Record<string, string[]>) => void; onVariablesChanged?: () => void; onRematch: () => void; onNextBatchValidation?: () => void }) {
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
  const [treeRatio, setTreeRatio] = useState(55);
  const [variableId, setVariableId] = useState("");
  const [method, setMethod] = useState<"DOM_TEXT" | "DOM_ATTRIBUTE">("DOM_TEXT");
  const [attribute, setAttribute] = useState("href");
  const [variables, setVariables] = useState<VariableOption[]>(loadVariables);
  const [variablesOpen, setVariablesOpen] = useState(false);
  const [activeCollectorId, setActiveCollectorId] = useState(() => loadRegistryEnvelope()?.collectors[0]?.id || "");
  const [draftVars, setDraftVars] = useState<CollectorVariable[]>([]);
  const [varError, setVarError] = useState("");
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
  const extractedData = useMemo(() => parsed ? extractParentData(parsed, { postId, currentUrl }) : [], [parsed, postId, currentUrl]);
  const manuallyHidden = hiddenExtractedData[postId] || [];
  const hiddenCount = extractedData.filter(item => item.hiddenByDefault || manuallyHidden.includes(item.id)).length;
  const visibleData = showHidden ? extractedData : extractedData.filter(item => !item.hiddenByDefault && !manuallyHidden.includes(item.id));
  const selectedData = extractedData.find(item => item.id === selectedDataId) || null;
  const selectedOutput = selectedData?.outputs.find(output => output.key === selectedOutputKey) || selectedData?.outputs[0] || null;
  const focusElement = atPath(focusPath);
  const nodes = useMemo(() => focusElement ? [toNode(focusElement, focusPath)] : [], [focusElement, focusPath]);

  useEffect(() => {
    const { ownerId } = claimCollectorHostOwner("pdc-step3"), publish = () => publishPostDetailBrowserHost(invoke, hostRef.current);
    void collectorSetBrowserVisible(invoke, true).then(publish);
    const observer = new ResizeObserver(publish); if (hostRef.current) observer.observe(hostRef.current); window.addEventListener("resize", publish);
    return () => { observer.disconnect(); window.removeEventListener("resize", publish); void invoke({ type: "postDetailClearParentNodeHighlight" }); releaseCollectorHostOwner(ownerId, () => { void collectorReportBrowserHost(invoke, null); void collectorSetBrowserVisible(invoke, false); }); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const visible = !browserCollapsed && !variablesOpen;
    void collectorSetBrowserVisible(invoke, visible);
    if (visible) {
      requestAnimationFrame(() => publishPostDetailBrowserHost(invoke, hostRef.current));
    }
  }, [browserCollapsed, variablesOpen, invoke]);
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
  const mappingsForItem = (item: ExtractedDataItem) => variableMappings.filter(mapping =>
    item.sourcePaths.some(path => samePath(path, mapping.relativePath)) &&
    (!mapping.sourceContext || mapping.sourceContext === item.context) &&
    (!mapping.sourceSemantic || mapping.sourceSemantic === item.semanticField));
  const mappingForOutput = (item: ExtractedDataItem, output: ExtractedOutput) => mappingsForItem(item).find(mapping => mapping.outputKey ? mapping.outputKey === output.key : mapping.preview === output.value);
  const suggestedVariable = (item: ExtractedDataItem) => item.context === "post" && item.semanticField ? variables.find(variable => variable.key === item.semanticField) : undefined;
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
  const applyDataMapping = () => {
    if (!selectedData || !selectedOutput || !selectedOutput.value || selectedData.sourcePaths.length !== 1 || !variableId) return;
    const variable = variables.find(item => `${item.collectorId}:${item.id}` === variableId);
    if (!variable) return;
    const path = selectedData.sourcePaths[0];
    const mapping: PostDetailDomVariableMapping = {
      collectorId: variable.collectorId, variableId: variable.id, variableKey: variable.key, variableLabel: variable.label,
      method: selectedOutput.method, attribute: selectedOutput.attribute,
      relativePath: path, relativeXPath: relativeXPathForPath(path), preview: selectedOutput.value,
      sourceContext: selectedData.context, sourceSemantic: selectedData.semanticField, outputKey: selectedOutput.key, confirmed: true, updatedAt: new Date().toISOString(),
    };
    onVariableMappings([
      ...variableMappings.filter(item =>
        !(item.collectorId === mapping.collectorId && item.variableId === mapping.variableId) &&
        !(samePath(item.relativePath, path) && (item.outputKey || "") === selectedOutput.key)),
      mapping,
    ]);
  };
  const unmapData = () => {
    if (!selectedData || !selectedOutput) return;
    onVariableMappings(variableMappings.filter(mapping => !(selectedData.sourcePaths.some(path => samePath(path, mapping.relativePath)) && (mapping.outputKey ? mapping.outputKey === selectedOutput.key : mapping.preview === selectedOutput.value))));
    setVariableId("");
  };
  const hideData = (item: ExtractedDataItem) => { onHiddenExtractedData({ ...hiddenExtractedData, [postId]: Array.from(new Set([...manuallyHidden, item.id])) }); if (selectedDataId === item.id) setSelectedDataId(""); };
  const restoreHidden = () => onHiddenExtractedData({ ...hiddenExtractedData, [postId]: [] });
  const mappingRows = variableMappings.map(mapping => {
    const executed = executeVariableMapping(parsed, mapping, { postId, currentUrl });
    const mappingStatus = executed.status === "mapped" ? "Mapped" : executed.status === "needs_attention" ? "Needs Attention" : "Missing";
    return { mapping, value: executed.value, mappingStatus };
  });
  const breadcrumbs = focusPath.map((_, index) => focusPath.slice(0, index + 1));
  const rematch = () => { void invoke({ type: "postDetailClearParentNodeHighlight" }); onRematch(); };

  const engagementData = visibleData.filter(item => item.kind === "engagement");
  const generalData = visibleData.filter(item => item.kind !== "engagement");
  const renderDataTag = (item: ExtractedDataItem) => {
    const mappings = mappingsForItem(item);
    const mappingStatus = item.sourcePaths.length > 1 || item.extractionStatus === "needs_attention" ? "Needs Attention" : mappings.length ? "Auto Mapped" : suggestedVariable(item) ? "Suggested" : "Unmapped";
    const displayLabel = item.kind === "engagement" ? `${item.label || item.semanticField}: ${item.value || "Needs Attention"}` : (item.label || item.value);
    return <span key={item.id} className="pdc-data-tag-wrap" onMouseEnter={() => { if (item.sourcePaths.length === 1) void invoke({ type: "postDetailHighlightParentNode", path: item.sourcePaths[0] }); }} onMouseLeave={() => { void invoke({ type: "postDetailClearParentNodeHighlight" }); }}><button type="button" title={item.value || displayLabel} className={`pdc-data-tag status-${mappingStatus.toLowerCase().replace(/\s+/g, "-")} ${selectedDataId === item.id ? "selected" : ""}`} onClick={() => selectData(item)}>
      <span className="pdc-data-value">{displayLabel}</span>
    </button><button type="button" className="pdc-data-hide" aria-label={`Hide ${displayLabel}`} onClick={() => hideData(item)}>×</button></span>;
  };

  return <div className={`pdc-step pdc-step3 ${isExpanded ? "pdc-explorer-expanded" : ""}`}>
    <div className="pdc-section-header"><div><h2>Step 3 — Extracted Data Review</h2><p className="pdc-subtitle">AUTO resolves the saved Parent and shows meaningful DOM values without wrapper markup.</p></div><div className="pdc-btn-row"><button type="button" className={`pdc-btn pdc-btn-secondary ${variablesOpen ? "active" : ""}`} onClick={openVariablesDrawer}>Manage Variables</button><button className="pdc-btn pdc-btn-secondary" onClick={() => setIsExpanded(value => !value)}>{isExpanded ? "Restore" : "Expand"}</button><button className="pdc-btn pdc-btn-secondary" onClick={rematch}>Customize · Rematch Parent</button>{onNextBatchValidation && <button type="button" className="pdc-btn pdc-btn-primary" onClick={onNextBatchValidation}>Step 4 · Batch Validation →</button>}</div></div>
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
    <div className={`pdc-alert ${status === "PARENT_MATCHED" ? "pdc-alert-ok" : "pdc-alert-warn"}`}>{status === "PARENT_MATCHED" ? "AUTO · Parent Matched" : status === "RESOLVING" ? "AUTO · Resolving Parent..." : `Needs Attention · ${result?.failureCode || status}`}</div>
    {result?.diagnostics.map(item => <p key={item} className="pdc-panel-desc">{item}</p>)}
    {status !== "NOT_CONFIGURED" && <div className={`pdc-dom-workspace ${browserCollapsed ? "browser-collapsed" : ""}`}><div className="pdc-dom-browser-wrap"><button className="pdc-btn pdc-btn-tiny" onClick={() => setBrowserCollapsed(value => !value)}>{browserCollapsed ? "Show Browser Preview" : "Collapse Browser Preview"}</button>{!browserCollapsed && <div ref={hostRef} className="pdc-browser-host pdc-dom-browser" data-browser-core-host="" />}</div><div className="pdc-dom-panel">
      {status === "PARENT_MATCHED" ? <><div className={`pdc-data-review ${selectedData ? "has-detail" : ""}`}>
        <div className="pdc-data-list" aria-label="Extracted values">
          <div className="pdc-data-list-header"><h3>Extracted values</h3><div className="pdc-btn-row"><span>{visibleData.length} shown · {hiddenCount} hidden</span><button className="pdc-btn pdc-btn-tiny" onClick={() => setShowHidden(value => !value)}>{showHidden ? "Hide Noise" : "Show Hidden"}</button><button className="pdc-btn pdc-btn-tiny" disabled={!manuallyHidden.length} onClick={restoreHidden}>Restore</button></div></div>
          {engagementData.length > 0 && <div className="pdc-engagement-group" aria-label="Engagement"><h4>Engagement</h4><div className="pdc-engagement-tags">{engagementData.map(renderDataTag)}</div></div>}
          {generalData.length ? generalData.map(renderDataTag) : !engagementData.length ? <p className="pdc-panel-desc">No meaningful DOM values were extracted from this Parent.</p> : null}
        </div>
        {selectedData && <div className="pdc-extracted-detail"><h3>Value detail</h3>
          <dl className="pdc-kv pdc-kv-compact">
            <div className="pdc-kv-item"><dt>Field</dt><dd>{selectedData.semanticField || selectedData.kind}</dd></div>
            <div className="pdc-kv-item"><dt>Type</dt><dd>{selectedData.predictedType || selectedData.kind}</dd></div>
            <div className="pdc-kv-item"><dt>Context</dt><dd>{selectedData.context}</dd></div>
            <div className="pdc-kv-item"><dt>Confidence</dt><dd>{selectedData.confidence} · {selectedData.extractionStatus}</dd></div>
            {selectedData.sourceAttribute && <div className="pdc-kv-item"><dt>Attr</dt><dd>{selectedData.sourceAttribute}</dd></div>}
            <div className="pdc-kv-item"><dt>Source</dt><dd>{selectedData.sourcePaths.length === 1 ? "Unique DOM node" : `${selectedData.sourcePaths.length} nodes · Needs Attention`}</dd></div>
            <div className="pdc-kv-item pdc-kv-wide"><dt>Value</dt><dd className="pdc-preserve-lines">{selectedOutput?.value || selectedData.value}</dd></div>
          </dl>
          {selectedData.outputs.length > 1 && <label>Output<select value={selectedOutput?.key || ""} onChange={event => { const output = selectedData.outputs.find(item => item.key === event.target.value); if (output) selectOutput(selectedData, output); }}>{selectedData.outputs.map(output => <option key={output.key} value={output.key}>{output.label}</option>)}</select></label>}
          <p className="pdc-data-detail-status">{selectedOutput && mappingForOutput(selectedData, selectedOutput) ? `Mapped → ${mappingForOutput(selectedData, selectedOutput)?.variableLabel}` : suggestedVariable(selectedData) ? `Suggested → ${suggestedVariable(selectedData)?.label}` : selectedData.extractionStatus === "needs_attention" ? "Needs Attention" : "Unmapped"}</p>
          {mappingsForItem(selectedData).length > 0 && <div className="pdc-output-mappings"><b>Output mappings</b>{mappingsForItem(selectedData).map(mapping => <span key={`${mapping.variableId}:${mapping.outputKey || mapping.preview}`}>{mapping.outputKey || "legacy"} → {mapping.variableLabel}</span>)}</div>}
          {variables.length ? <><select value={variableId} onChange={event => setVariableId(event.target.value)}><option value="">Select existing variable…</option>{variables.map(variable => <option key={`${variable.collectorId}:${variable.id}`} value={`${variable.collectorId}:${variable.id}`}>{variable.collectorName} · {variable.label} ({variable.key})</option>)}</select><p>Preview: <span className="pdc-preserve-lines">{selectedOutput?.value || selectedData.value}</span></p><div className="pdc-btn-row pdc-detail-actions"><button className="pdc-btn pdc-btn-primary" disabled={!variableId || !selectedOutput || !selectedOutput.value || selectedData.sourcePaths.length !== 1} onClick={applyDataMapping}>Save Mapping</button><button className="pdc-btn pdc-btn-secondary" disabled={!selectedOutput || !mappingForOutput(selectedData, selectedOutput)} onClick={unmapData}>Unmap Output</button></div></> : <p className="pdc-panel-desc">No existing Collector variables. Create schema in Collectors first.</p>}
        </div>}
      </div><details className="pdc-advanced-debug"><summary>Advanced Debug</summary><div className="pdc-btn-row"><button className={`pdc-btn pdc-btn-tiny ${tab === "explorer" ? "active" : ""}`} onClick={() => setTab("explorer")}>DOM Explorer</button><button className={`pdc-btn pdc-btn-tiny ${tab === "raw" ? "active" : ""}`} onClick={() => setTab("raw")}>Raw HTML</button><button className="pdc-btn pdc-btn-tiny" disabled={!focusPath.length} onClick={resetFocus}>Reset Focus</button></div>
      {tab === "raw" ? <pre className="pdc-code-preview">{result?.innerHTML}</pre> : <><div className="pdc-dom-breadcrumb"><button onClick={resetFocus}>Root</button>{breadcrumbs.map(path => <button key={pathKey(path)} onClick={() => setFocusPath(path)}>› {atPath(path)?.tagName.toLowerCase()}</button>)}</div><label className="pdc-split-control">Tree width <input type="range" min="30" max="75" value={treeRatio} onChange={event => setTreeRatio(Number(event.target.value))} /></label><div className="pdc-dom-columns" style={{ gridTemplateColumns: `${treeRatio}fr ${100 - treeRatio}fr` }}><div className="pdc-dom-tree"><ul>{nodes.map(node => <TreeNode key={pathKey(node.path)} node={node} expanded={expanded} selected={selected ? pathKey(selected.path) : ""} onToggle={key => setExpanded(current => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next; })} onSelect={choose} onFocus={focus} onHover={highlight} />)}</ul></div><div className="pdc-dom-inspector"><h3>Inspector</h3>{selected ? <>
        <section><h4>Attributes</h4><dl className="pdc-kv">{Object.entries(selected.attrs).map(([name, value]) => <React.Fragment key={name}><dt>{name}</dt><dd>{value}</dd></React.Fragment>)}</dl></section>
        <section><h4>Text</h4><p>{selected.directText || selected.textPreview || "—"}</p><button className="pdc-btn pdc-btn-tiny" onClick={() => copy(selected.element.textContent || "")}>Copy Text</button><details><summary>Full text</summary><pre>{selected.element.textContent}</pre></details><details><summary>outerHTML</summary><pre>{selected.element.outerHTML}</pre></details></section>
        <section><h4>Selector</h4><code>{relativeXPath(selected.path)}</code><div className="pdc-btn-row"><button className="pdc-btn pdc-btn-tiny" onClick={() => copy(relativeXPath(selected.path))}>Copy XPath</button><button className="pdc-btn pdc-btn-tiny" onClick={() => copy(relativeSelector(selected.path))}>Copy Selector</button></div></section>
        <section><h4>Variables</h4>{variables.length ? <><select value={variableId} onChange={event => setVariableId(event.target.value)}><option value="">Select existing variable…</option>{variables.map(variable => <option key={`${variable.collectorId}:${variable.id}`} value={`${variable.collectorId}:${variable.id}`}>{variable.collectorName} · {variable.label} ({variable.key})</option>)}</select><select value={method} onChange={event => setMethod(event.target.value as typeof method)}><option value="DOM_TEXT">text</option><option value="DOM_ATTRIBUTE">attribute</option></select>{method === "DOM_ATTRIBUTE" && <input value={attribute} onChange={event => setAttribute(event.target.value)} placeholder="href" />}<p>Preview: {selectedValue || "Missing / Needs Attention"}</p><p>Locator matches: {selectedMatchCount} {selectedMatchCount === 1 ? "· verified" : "· Needs Attention"}</p><button className="pdc-btn pdc-btn-primary" disabled={!variableId || !selectedValue || selectedMatchCount !== 1} onClick={saveMapping}>Confirm Mapping</button></> : <p className="pdc-panel-desc">No existing Collector variables. Create schema in Collectors first.</p>}</section>
      </> : <p className="pdc-panel-desc">Chọn một node. Double-click để Focus Root.</p>}</div></div><section className="pdc-variable-status"><h3>Confirmed mappings</h3>{mappingRows.length ? mappingRows.map(({ mapping, value, mappingStatus }) => <div key={`${mapping.collectorId}:${mapping.variableId}`}><b>{mapping.variableLabel}</b> · <span>{mappingStatus}</span> · {value || "—"}</div>) : <p className="pdc-panel-desc">Unmapped · chưa có mapping đã xác nhận.</p>}</section></>}</details></> : <div><h3>Parent resolution failed</h3><p className="pdc-panel-desc">AUTO did not accept a Parent without identity, Action Row ownership, and Parent validation.</p>{result?.diagnosticMeta && <pre className="pdc-code-preview">{JSON.stringify(result.diagnosticMeta, null, 2)}</pre>}</div>}
    </div></div>}
  </div>;
}
