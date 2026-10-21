import React, { useEffect, useState } from "react";
import type { MainPage, State } from "../shared/contracts";
import type { Binding, Definition, Field, Port, StudioState, V3Request, V3Response, Value, ValueType } from "../shared/admin-v3";
import { V3_CAPABILITIES, inputValues, scenarioOutputs } from "../shared/admin-v3";
import { safeKey, sensitiveKey } from "../shared/admin-v3-validation";
import { UiPopover } from "./ui-popover";

export type StudioEditorHandle = { dirty: boolean; name: string; save: () => Promise<void>; discard: () => void };
const pages = ["variations", "widget-registry", "workflows", "builds-releases"];
export const isStudioPage = (page: string) => pages.includes(page);
const empty: StudioState = { definitions: [], releases: [], previews: [], runs: [], imports: [] };
const kindFor = (page: string): Definition["kind"] => page === "variations" ? "variation" : page === "workflows" ? "workflow" : "widget";
function valueText(value: Value | undefined) { return Array.isArray(value) ? value.join("\n") : value ?? ""; }
function parseValue(type: ValueType, text: string): Value { return ["number", "integer"].includes(type) ? (text === "" ? "" : Number(text)) : type === "files" ? text.split("\n").filter(Boolean) : text; }
function FieldInput({ field, value, change, disabled }: { field: Field; value?: Value; change: (x: Value) => void; disabled?: boolean }) {
  return <label>{field.label}{field.required ? " *" : ""}<small>{field.description}</small>
    {field.type === "files" ? <textarea disabled={disabled} value={valueText(value)} required={field.required} placeholder="Local file paths, one per line"
      onChange={e => change(parseValue(field.type, e.target.value))} /> : <input disabled={disabled} type={field.sensitive ? "password" : ["number", "integer"].includes(field.type) ? "number" : "text"}
      step={field.type === "integer" ? 1 : "any"} value={valueText(value)} required={field.required}
      placeholder={field.type === "file" ? "Local file path" : undefined}
      onChange={e => change(parseValue(field.type, e.target.value))} />}</label>;
}
function Mapping({ value, ports, inputs, change }: { value?: Binding; ports: { id: string; outputs: Port[] }[]; inputs: Field[]; change: (binding: Binding) => void }) {
  const selected = value?.source === "input" ? `input:${value.key}` : value?.source === "node" ? `${value.nodeId}:${value.key}` : value?.source === "literal" ? "literal" : "";
  return <div className="v3-mapping"><select aria-label="Mapping source" value={selected} onChange={e => {
    const [node, key] = e.target.value.split(":");
    change(node === "literal" ? { source: "literal", type: "text", value: "" } : node === "input" ? { source: "input", key } : { source: "node", nodeId: node, key });
  }}><option value="" disabled>Select source</option><optgroup label="Form inputs">{inputs.map(f => <option key={f.key} value={`input:${f.key}`}>{f.key} ({f.type})</option>)}</optgroup>
    {ports.map(p => <optgroup key={p.id} label={p.id}>{p.outputs.map(o => <option key={o.key} value={`${p.id}:${o.key}`}>{o.key} ({o.type})</option>)}</optgroup>)}<option value="literal">Literal</option></select>
    {value?.source === "literal" && <><select value={value.type} onChange={e => change({ source: "literal", type: e.target.value as ValueType, value: parseValue(e.target.value as ValueType, "") })}>
      {["text", "integer", "number"].map(t => <option key={t}>{t}</option>)}</select><input value={valueText(value.value)} onChange={e => change({ ...value, value: parseValue(value.type, e.target.value) })} /></>}
  </div>;
}
export function AdminStudioPage({ page, state, selectedId, open, locked, report }: {
  page: MainPage | string; state: State; selectedId?: string; open: (id: string, page: MainPage, label: string) => void; locked: boolean; report: (id: string, handle: StudioEditorHandle) => void;
}) {
  const [studio, setStudio] = useState<StudioState>(empty), [drafts, setDrafts] = useState<Record<string, Definition>>({});
  const [working, setWorking] = useState(false), [message, setMessage] = useState("");
  const [reviewedMedia, setReviewedMedia] = useState("");
  const [media, setMedia] = useState<V3Response["media"]>();
  const [sessionId, setSessionId] = useState(state.activeBrowserSessionId ?? ""), [startUrl, setStartUrl] = useState("");
  const [values, setValues] = useState<Record<string, Value>>({}), [previewForm, setPreviewForm] = useState(false);
  const [importValues, setImportValues] = useState<Record<string, Record<string, Value>>>({});
  useEffect(() => setValues({}), [selectedId]);
  const [variationId, setVariationId] = useState("");
  const disabled = locked || working;
  async function request(request: V3Request) {
    setWorking(true); setMessage("");
    try {
      const next = await window.creator.invoke({ type: "studio", request }) as V3Response;
      setStudio(next.state);
      if (next.error) throw new Error(next.error.message);
      if (next.issues) setMessage(next.issues.length ? next.issues.map(x => `${x.code} · ${x.path}: ${x.message}`).join("\n") : "Validation completed without reported issues. Execution acceptance is still required.");
      if (next.result) setMessage(JSON.stringify(next.result, null, 2));
      if (next.media) setMedia(next.media);
      return next;
    } catch (error) { setMessage(String(error)); throw error; } finally { setWorking(false); }
  }
  useEffect(() => { if (isStudioPage(page) && !working) void request({ action: "state" }).catch(() => {}); }, [page]);
  const original = studio.definitions.find(x => x.id === selectedId), definition = selectedId ? drafts[selectedId] ?? original : undefined;
  const dirty = !!definition && JSON.stringify(definition) !== JSON.stringify(original);
  const immutable = !!definition && ["published", "deprecated"].includes(definition.state);
  function discardItem(item: Definition) {
    setDrafts(x => { const copy = { ...x }; delete copy[item.id]; return copy; });
    if (!studio.definitions.some(d => d.id === item.id)) report(`studio:${item.id}`, { dirty: false, name: item.name, save: async () => {}, discard: () => {} });
  }
  function edit(patch: Partial<Definition>) { if (definition) setDrafts(x => ({ ...x, [definition.id]: { ...definition, ...patch } })); }
  async function saveItem(item: Definition) {
    await request({ action: "save", definition: item });
    setDrafts(x => { const copy = { ...x }; delete copy[item.id]; return copy; });
  }
  async function save() { if (definition) await saveItem(definition); }
  useEffect(() => {
    const items = { ...Object.fromEntries(studio.definitions.map(d => [d.id, d])), ...drafts };
    for (const item of Object.values(items)) report(`studio:${item.id}`, {
      dirty: JSON.stringify(item) !== JSON.stringify(studio.definitions.find(d => d.id === item.id)), name: item.name,
      save: () => saveItem(item), discard: () => discardItem(item)
    });
  }, [drafts, studio, report]);
  function create() {
    const source = studio.definitions.find(d => d.id === variationId);
    const id = `d${crypto.randomUUID()}`, kind = kindFor(page);
    const item: Definition = { id, name: kind === "widget" && source ? `${source.name} Widget` : `New ${kind}`, kind, version: "1.0.0", revision: 0,
      fields: structuredClone(source?.fields ?? []), nodes: structuredClone(source?.nodes ?? []), outputs: structuredClone(source?.outputs ?? []),
      capabilities: [...(source?.capabilities ?? ["browser.input"])], previewIds: [...(source?.previewIds ?? [])], variationId: source?.id,
      state: "draft", updatedAt: new Date().toISOString() };
    setDrafts(x => ({ ...x, [id]: item })); setValues({}); open(id, page as MainPage, item.name);
  }
  const contract = (releaseId?: string) => studio.contracts?.[releaseId ?? ""];
  const portsBefore = (index: number) => definition?.nodes.slice(0, index).map(n => ({ id: n.id,
    outputs: definition.kind === "workflow" ? contract(n.releaseId)?.outputs ?? [] : scenarioOutputs })) ?? [];
  function addScenario(id: string) {
    if (!definition) return;
    const flow = state.flows.find(x => x.id === id); if (!flow) return;
    const nodeId = `n${crypto.randomUUID()}`, fields = [...definition.fields], mappings: Record<string, Binding> = {};
    for (const variable of flow.variables ?? []) {
      let key = safeKey(variable.key) ? variable.key : `input${fields.length + 1}`;
      while (fields.some(f => f.key === key)) key += "_";
      fields.push({ key, label: variable.key, type: variable.type, required: true, visibility: "exposed", description: variable.description, ...(sensitiveKey(key) ? { sensitive: true } : {}) });
      mappings[variable.id] = { source: "input", key };
    }
    edit({ fields, nodes: [...definition.nodes, { id: nodeId, scenario: { id, steps: structuredClone(flow.steps) }, mappings, failure: "stop" }] });
  }
  return <section className="app-page v3-studio" hidden={!isStudioPage(page)} aria-label="Admin Studio V3">
    <div className="page-heading"><h1>{page === "variations" ? "Variations" : page === "widget-registry" ? "Widget Registry" : page === "workflows" ? "Workflows" : "Builds & Releases"}</h1>
      <p>Local authoring, version-pinned composition and package export.</p></div>
    {page !== "builds-releases" && <div className="scenario-toolbar">
      {page === "widget-registry" && <select value={variationId} onChange={e => setVariationId(e.target.value)}><option value="">Choose Variation</option>{studio.definitions.filter(x => x.kind === "variation").map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
      <button disabled={disabled || page === "widget-registry" && !variationId} onClick={create}>+ {kindFor(page)}</button>
      <button disabled={disabled} onClick={() => void request({ action: "import" }).catch(() => {})}>Import package ZIP</button>
    </div>}
    <div className="v3-list">{studio.definitions.filter(x => x.kind === kindFor(page) && page !== "builds-releases").map(item => <div className="scenario-item" key={item.id}>
      <button disabled={disabled} onClick={() => { setValues({}); open(item.id, page as MainPage, item.name); }}>{item.name} · {item.version}</button><small>{item.state}</small>
      <button disabled={disabled} onClick={() => void request({ action: "duplicate", id: item.id }).catch(() => {})}>Duplicate / Revision</button>
      <button disabled={disabled} onClick={() => { if (window.confirm(`Delete draft ${item.name}? Released artifacts are retained.`)) void request({ action: "delete", id: item.id, confirmed: true }).then(() => {
        setDrafts(x => { const copy = { ...x }; delete copy[item.id]; return copy; });
        report(`studio:${item.id}`, { dirty: false, name: item.name, save: async () => {}, discard: () => {} });
      }).catch(() => {}); }}>Delete</button>
    </div>)}</div>
    {definition && page !== "builds-releases" && definition.kind === kindFor(page) && <div className="case-form v3-editor">
      <h2>{definition.name}{dirty ? " ●" : ""} <small>{definition.state}</small></h2>
      <fieldset disabled={disabled || immutable}>
        <label>Name<input value={definition.name} maxLength={120} onChange={e => edit({ name: e.target.value })} /></label>
        <label>Version<input value={definition.version} onChange={e => edit({ version: e.target.value })} /></label>
        <h3>End-user form</h3>
        {definition.fields.map((field, i) => <details key={`${definition.id}:${i}`} className="v3-field" open><summary>{field.label} · {field.type}</summary>
          <label>Key<input value={field.key} onChange={e => edit({ fields: definition.fields.map((f, j) => j === i ? { ...f, key: e.target.value } : f) })} /></label>
          <label>Label<input value={field.label} onChange={e => edit({ fields: definition.fields.map((f, j) => j === i ? { ...f, label: e.target.value } : f) })} /></label>
          <select aria-label="Field type" value={field.type} onChange={e => edit({ fields: definition.fields.map((f, j) => j === i ? { ...f, type: e.target.value as ValueType, default: undefined } : f) })}>{["text", "file", "files", "integer", "number"].map(x => <option key={x}>{x}</option>)}</select>
          <label><input type="checkbox" checked={field.required} onChange={e => edit({ fields: definition.fields.map((f, j) => j === i ? { ...f, required: e.target.checked } : f) })} />Required</label>
          <select aria-label="Visibility" value={field.visibility} onChange={e => edit({ fields: definition.fields.map((f, j) => j === i ? { ...f, visibility: e.target.value as Field["visibility"] } : f) })}><option>exposed</option><option>hidden</option></select>
          <label>Description<input value={field.description ?? ""} onChange={e => edit({ fields: definition.fields.map((f, j) => j === i ? { ...f, description: e.target.value } : f) })} /></label>
          <label><input type="checkbox" checked={field.sensitive === true} onChange={e => edit({ fields: definition.fields.map((f, j) => j === i ? { ...f, sensitive: e.target.checked, default: undefined } : f) })} />Sensitive, supplied locally</label>
          {!field.sensitive && !["file", "files"].includes(field.type) && <label>Default<input value={valueText(field.default)} onChange={e => edit({ fields: definition.fields.map((f, j) => j === i ? { ...f, default: e.target.value === "" ? undefined : parseValue(field.type, e.target.value) } : f) })} /></label>}
          <label>Validation (JSON)<input defaultValue={JSON.stringify(field.validation ?? {})} onBlur={e => { try { const validation = JSON.parse(e.target.value); edit({ fields: definition.fields.map((f, j) => j === i ? { ...f, validation } : f) }); } catch { setMessage("Invalid validation JSON."); } }} /></label>
          <button onClick={() => edit({ fields: definition.fields.filter((_, j) => i !== j) })}>Remove field</button>
        </details>)}
        <button onClick={() => edit({ fields: [...definition.fields, { key: `input${definition.fields.length + 1}`, label: "Input", type: "text", required: true, visibility: "exposed" }] })}>+ Field</button>
        <button onClick={() => setPreviewForm(true)}>Form Preview</button>
        <h3>{definition.kind === "workflow" ? "Workflow canvas" : "Scenario composition"}</h3>
        {definition.kind !== "workflow" ? <select value="" onChange={e => addScenario(e.target.value)}><option value="">+ Saved Scenario</option>{state.flows.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
          : <select value="" onChange={e => edit({ nodes: [...definition.nodes, { id: `n${crypto.randomUUID()}`, releaseId: e.target.value, mappings: {}, failure: "stop" }] })}><option value="">+ Widget release</option>{studio.releases.filter(r => r.manifest.kind === "widget" && r.status !== "deprecated").map(r => <option key={r.manifest.releaseId} value={r.manifest.releaseId}>{r.manifest.name} · {r.manifest.version} · {r.status}</option>)}</select>}
        <div className="v3-canvas"><div className="v3-node">Start · form inputs</div>
          {definition.nodes.map((node, index) => {
            const flow = state.flows.find(f => f.id === node.scenario?.id);
            const ports: Port[] = definition.kind === "workflow" ? contract(node.releaseId)?.inputs ?? [] : (flow?.variables ?? []).map(v => ({ key: v.id, type: v.type, required: true }));
            return <React.Fragment key={node.id}><div className="v3-edge">↓ success</div><div className="v3-node">
              <b>{index + 1}. {flow?.name ?? studio.releases.find(r => r.manifest.releaseId === node.releaseId)?.manifest.name ?? "Missing dependency"}</b>
              <small>{node.id} · {node.releaseId ?? node.scenario?.steps.map(s => `${s.id}:v${s.version}`).join(", ")}</small>
              {node.scenario?.steps.map((ref, stepIndex) => <label key={ref.id}>Step {stepIndex + 1} version
                <select value={ref.version} onChange={e => edit({ nodes: definition.nodes.map(n => n.id === node.id && n.scenario ? {
                  ...n, scenario: { ...n.scenario, steps: n.scenario.steps.map(s => s.id === ref.id ? { ...s, version: Number(e.target.value) } : s) }
                } : n) })}>{state.steps.filter(s => s.id === ref.id).map(s => <option key={s.version} value={s.version}>{s.name} · v{s.version}</option>)}</select>
              </label>)}
              <p>Failure → End with error</p>
              <button disabled={index === 0} onClick={() => { const nodes = [...definition.nodes]; [nodes[index - 1], nodes[index]] = [nodes[index], nodes[index - 1]]; edit({ nodes }); }}>↑</button>
              <button disabled={index === definition.nodes.length - 1} onClick={() => { const nodes = [...definition.nodes]; [nodes[index], nodes[index + 1]] = [nodes[index + 1], nodes[index]]; edit({ nodes }); }}>↓</button>
              <button onClick={() => edit({ nodes: definition.nodes.filter(n => n.id !== node.id) })}>Remove node</button>
              {ports.map(p => <label key={p.key}>{flow?.variables?.find(v => v.id === p.key)?.key ?? p.key} ({p.type})
                <Mapping value={node.mappings[p.key]} inputs={definition.fields} ports={portsBefore(index)} change={binding => edit({ nodes: definition.nodes.map(n => n.id === node.id ? { ...n, mappings: { ...n.mappings, [p.key]: binding } } : n) })} /></label>)}
              <small>Outputs: {(definition.kind === "workflow" ? contract(node.releaseId)?.outputs ?? [] : scenarioOutputs).map(p => `${p.key}: ${p.type}`).join(" · ")}</small>
            </div></React.Fragment>;
          })}<div className="v3-edge">↓ success</div><div className="v3-node">End · structured outputs</div></div>
        <h3>Output contract</h3>{definition.outputs.map((o, i) => <div key={i}>
          <input aria-label="Output key" value={o.key} onChange={e => edit({ outputs: definition.outputs.map((v, j) => i === j ? { ...v, key: e.target.value } : v) })} />
          <select value={o.type} onChange={e => edit({ outputs: definition.outputs.map((v, j) => i === j ? { ...v, type: e.target.value as ValueType } : v) })}>{["text", "integer", "number", "file", "files"].map(t => <option key={t}>{t}</option>)}</select>
          <Mapping value={o.binding} inputs={definition.fields} ports={portsBefore(definition.nodes.length)} change={binding => edit({ outputs: definition.outputs.map((v, j) => i === j ? { ...v, binding } : v) })} />
          <button onClick={() => edit({ outputs: definition.outputs.filter((_, j) => i !== j) })}>Remove output</button></div>)}
        <button onClick={() => edit({ outputs: [...definition.outputs, { key: `output${definition.outputs.length + 1}`, type: "text", required: true, binding: { source: "literal", type: "text", value: "" } }] })}>+ Output</button>
        <h3>Capabilities</h3>{V3_CAPABILITIES.map(c => <label key={c}><input type="checkbox" checked={definition.capabilities.includes(c)} onChange={e => edit({ capabilities: e.target.checked ? [...definition.capabilities, c] : definition.capabilities.filter(x => x !== c) })} />{c}</label>)}
        <h3>Reviewed previews</h3>{studio.previews.map(p => <label key={p.id}><input type="checkbox" checked={definition.previewIds.includes(p.id)} onChange={e => edit({ previewIds: e.target.checked ? [...definition.previewIds, p.id] : definition.previewIds.filter(id => id !== p.id) })} />{p.kind} · {p.runId}<button onClick={() => void request({ action: "preview", id: p.id }).catch(() => {})}>View</button></label>)}
        <button disabled={!dirty} onClick={() => void save().catch(() => {})}>Save</button>
        <button disabled={!dirty} onClick={() => discardItem(definition)}>Discard draft</button>
      </fieldset>
      <div className="case-actions"><button disabled={disabled || dirty} onClick={() => void request({ action: "validate", id: definition.id }).catch(() => {})}>Validate saved</button>
        {definition.kind !== "variation" && <button disabled={disabled || dirty || immutable} onClick={() => void request({ action: "build", id: definition.id }).catch(() => {})}>Build package</button>}</div>
      <h3>Test saved composition</h3>
      <label>Local Browser Session<select value={sessionId} onChange={e => setSessionId(e.target.value)}>{state.browserSessions?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Start URL<input value={startUrl} type="url" onChange={e => setStartUrl(e.target.value)} /></label>
      {definition.fields.filter(f => f.visibility === "exposed" || f.sensitive).map(f => <FieldInput key={`${definition.id}:${f.key}`} field={f} value={values[f.key] ?? f.default} change={v => setValues(x => ({ ...x, [f.key]: v }))} />)}
      <button disabled={disabled || dirty || !startUrl || !sessionId} onClick={() => { try { inputValues(definition.fields, values); void request({ action: "run", id: definition.id, sessionId, startUrl, values }).catch(() => {}); } catch (e) { setMessage(String(e)); } }}>Run through V2 Runtime</button>
    </div>}
    {page === "builds-releases" && <><div className="scenario-toolbar"><button disabled={disabled} onClick={() => void request({ action: "import" }).catch(() => {})}>Import ZIP</button></div>
      {studio.builds?.filter(b => b.status === "failed").map(b => <article className="scenario-folder" key={b.id}>
        <h3>{b.name} · {b.kind} · {b.version} · Build failed</h3><p>{b.createdAt}</p>
        <pre className="v3-message">{b.issues.map(i => `${i.code} · ${i.path}: ${i.message}`).join("\n")}</pre></article>)}
      <div className="v3-release-list">{studio.releases.map(r => <article className="scenario-folder" key={r.manifest.releaseId}>
        <h3>{r.manifest.name} · {r.manifest.kind} · {r.manifest.version}</h3><p>{r.status} · Created {r.createdAt} · Published {r.publishedAt ?? "—"}</p>
        <p>Release: {r.manifest.releaseId}<br />SHA-256: {r.manifest.checksum}<br />Validation issues: {r.validation.length} · Test: {r.testedRunId}</p>
        <button disabled={disabled} onClick={() => void request({ action: "export", releaseId: r.manifest.releaseId }).catch(() => {})}>Export ZIP</button>
        <button disabled={disabled || r.status !== "built"} onClick={() => { if (window.confirm("Publish this immutable local release? Confirm selected preview media and package metadata contain no sensitive information.")) void request({ action: "publish", releaseId: r.manifest.releaseId }).catch(() => {}); }}>Publish locally</button>
        <button disabled={disabled || r.status !== "published"} onClick={() => void request({ action: "deprecate", releaseId: r.manifest.releaseId }).catch(() => {})}>Deprecate</button>
      </article>)}</div>
      <h3>Imported packages</h3>{studio.imports.map(m => <div className="scenario-folder" key={m.releaseId}><b>{m.name} {m.version}</b><p>{m.releaseId}</p>
        <label>Local Session<select value={sessionId} onChange={e => setSessionId(e.target.value)}>{state.browserSessions?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Start URL<input value={startUrl} onChange={e => setStartUrl(e.target.value)} /></label>
        {(studio.contracts?.[m.releaseId]?.fields ?? []).filter(f => f.visibility === "exposed" || f.sensitive).map(f => <FieldInput key={f.key} field={f} value={importValues[m.releaseId]?.[f.key] ?? f.default} change={v => setImportValues(x => ({ ...x, [m.releaseId]: { ...x[m.releaseId], [f.key]: v } }))} />)}
        <button disabled={disabled || !sessionId || !startUrl} onClick={() => void request({ action: "run", id: m.releaseId, sessionId, startUrl, values: importValues[m.releaseId] ?? {}, imported: true }).catch(() => {})}>Run imported package</button>
      </div>)}</>}
    <h3>Select preview from Test Run</h3><p>Review the entire image/video first. Confirm it contains no cookies, credentials, private or sensitive content. Selection copies it outside Test Run retention.</p>
    {state.testLab?.cases.filter(c => c.lastResult?.runId && c.lastResult.status !== "RUNNING").map(c => <div key={c.id}>
      {c.name} · {c.lastResult!.status} · {c.lastResult!.runId}
      {(["screenshot", "video"] as const).filter(kind => kind === "screenshot" ? c.lastResult!.screenshotPath : c.lastResult!.recordingPath).map(kind => <React.Fragment key={kind}>
        <button disabled={disabled} onClick={() => void window.creator.invoke({ type: kind === "screenshot" ? "testCaseScreenshot" : "testCaseVideo", caseId: c.id, runId: c.lastResult!.runId! }).then(x => { setMedia({ kind, url: x as string }); setReviewedMedia(`${c.id}:${c.lastResult!.runId}:${kind}`); }).catch(e => setMessage(String(e)))}>Review {kind}</button>
        <button disabled={disabled || reviewedMedia !== `${c.id}:${c.lastResult!.runId}:${kind}`} onClick={() => { if (window.confirm(`I reviewed this ${kind}, including all video frames. It contains no credentials or sensitive information and may be used in public packages.`)) void request({ action: "selectPreview", caseId: c.id, runId: c.lastResult!.runId!, kind, confirmed: true }).catch(() => {}); }}>Confirm & protect {kind}</button>
      </React.Fragment>)}
    </div>)}
    {message && <pre role="status" className="v3-message">{message}</pre>}
    {media && <UiPopover variant="modal" label="Preview review" close={() => setMedia(undefined)}><button onClick={() => setMedia(undefined)}>Close</button>{media.kind === "video" ? <video controls src={media.url} style={{ maxWidth: "100%" }} /> : <img src={media.url} alt="Selected preview for review" style={{ maxWidth: "100%" }} />}</UiPopover>}
    {previewForm && definition && <UiPopover variant="modal" label="Runner form preview" close={() => setPreviewForm(false)}><h2>{definition.name}</h2>
      {definition.fields.filter(f => f.visibility === "exposed").map(f => <FieldInput key={f.key} field={f} value={values[f.key] ?? f.default} change={v => setValues(x => ({ ...x, [f.key]: v }))} />)}<button onClick={() => setPreviewForm(false)}>Close</button></UiPopover>}
  </section>;
}
