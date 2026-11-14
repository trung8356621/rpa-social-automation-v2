import React, { useMemo, useRef, useState } from "react";
import type {
  PostDetailParentConfig,
  PostDetailSavedParentResolution,
} from "../../shared/post-detail-collector/types";
import { shouldRetrySavedParentResolution } from "./auto-resume";
import {
  advanceParentReadiness,
  evaluateMatchedParentDom,
  extractPostIdentityFromUrl,
  formatShortPostLabel,
  parseBatchUrls,
} from "./batch-validation";
import { SavedParentHtmlStep } from "./SavedParentHtmlStep";
import { extractParentData } from "./extract-parent-data";
import type {
  BatchValidationRow,
  BrowserProbe,
  Invoke,
  PostDetailDomVariableMapping,
} from "./types";
import { listRegistryVariables } from "./variable-registry";

const MAX_RESOLVE_ATTEMPTS = 10;
const RESOLVE_RETRY_DELAY_MS = 750;
const REQUIRED_STABLE_SNAPSHOTS = 2;

function parseHtmlFragment(innerHTML: string): Element | null {
  if (!innerHTML || typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString("<!doctype html><body></body>", "text/html");
  const root = doc.createElement("div");
  root.innerHTML = innerHTML;
  return root;
}

function extractionSignature(root: Element, postId: string | null, currentUrl: string) {
  return JSON.stringify(extractParentData(root, { postId: postId || undefined, currentUrl }).filter(item => item.semanticField).map(item => ({
    semanticField: item.semanticField,
    value: item.value,
    extractionStatus: item.extractionStatus,
    sourcePaths: item.sourcePaths,
  })));
}

async function resolveStableParent(opts: {
  invoke: Invoke;
  config: PostDetailParentConfig;
  expectedPostId: string | null;
  currentUrl: string;
  cancelled?: () => boolean;
  onWaiting?: (message: string) => void;
}): Promise<PostDetailSavedParentResolution> {
  let last: PostDetailSavedParentResolution | null = null;
  let readinessState = { signature: "", stableCount: 0 };
  for (let attempt = 0; attempt < MAX_RESOLVE_ATTEMPTS; attempt++) {
    if (opts.cancelled?.()) break;
    const resolution = await opts.invoke<PostDetailSavedParentResolution>({ type: "postDetailResolveSavedParent", config: opts.config });
    last = resolution;
    if (resolution.status === "PARENT_MATCHED") {
      const meta = resolution.diagnosticMeta || {};
      const livePostId = typeof meta.postId === "string" ? meta.postId : null;
      const identityVerified = meta.postIdentityVerified === true && (!opts.expectedPostId || livePostId === opts.expectedPostId);
      const root = identityVerified ? parseHtmlFragment(resolution.innerHTML) : null;
      if (!identityVerified) {
        readinessState = { signature: "", stableCount: 0 };
        opts.onWaiting?.(`Waiting for live post identity${opts.expectedPostId ? ` #${opts.expectedPostId}` : ""} (${attempt + 1}/${MAX_RESOLVE_ATTEMPTS})`);
      } else if (root) {
        const signature = extractionSignature(root, opts.expectedPostId, opts.currentUrl);
        const readiness = advanceParentReadiness({ state: readinessState, expectedPostId: opts.expectedPostId, resolvedPostId: livePostId, postIdentityVerified: identityVerified, parentMatched: true, semanticSignature: signature, requiredStableSnapshots: REQUIRED_STABLE_SNAPSHOTS });
        readinessState = readiness.state;
        if (readiness.ready) {
          return {
            ...resolution,
            diagnosticMeta: { ...meta, readinessVerified: true, stableSnapshots: readinessState.stableCount, extractionSignature: signature },
            diagnostics: [...resolution.diagnostics, `DOM readiness verified after ${readinessState.stableCount} stable semantic snapshots.`],
          };
        }
        opts.onWaiting?.(`Waiting for semantic DOM stability (${readinessState.stableCount}/${REQUIRED_STABLE_SNAPSHOTS}, attempt ${attempt + 1}/${MAX_RESOLVE_ATTEMPTS})`);
      }
    } else if (!shouldRetrySavedParentResolution(resolution)) {
      return resolution;
    } else {
      readinessState = { signature: "", stableCount: 0 };
      opts.onWaiting?.(`Waiting for Parent locator (${resolution.failureCode || resolution.status}, ${attempt + 1}/${MAX_RESOLVE_ATTEMPTS})`);
    }
    if (attempt < MAX_RESOLVE_ATTEMPTS - 1) await new Promise(resolve => setTimeout(resolve, RESOLVE_RETRY_DELAY_MS));
  }
  return {
    status: "BROWSER_NOT_READY",
    innerHTML: "",
    rect: null,
    failureCode: "BROWSER_NOT_READY",
    diagnosticMeta: { ...(last?.diagnosticMeta || {}), readinessVerified: false, stableSnapshots: readinessState.stableCount },
    diagnostics: [...(last?.diagnostics || []), "Readiness timeout: post identity and semantic DOM did not produce two consecutive stable snapshots."],
  };
}

export function BatchValidationStep({
  invoke,
  parentConfigs,
  variableMappings,
  hiddenExtractedData,
  batchUrlsText,
  batchResults,
  batchConfigVersion,
  batchValidatedVersion,
  onBatchUrlsText,
  onBatchResults,
  onVariableMappings,
  onHiddenExtractedData,
  onReviewInStep3,
  onBackToStep3,
}: {
  invoke: Invoke;
  parentConfigs: Record<string, PostDetailParentConfig>;
  variableMappings: PostDetailDomVariableMapping[];
  hiddenExtractedData: Record<string, string[]>;
  batchUrlsText: string;
  batchResults: BatchValidationRow[];
  batchConfigVersion: number;
  batchValidatedVersion: number | null;
  onBatchUrlsText: (text: string) => void;
  onBatchResults: (rows: BatchValidationRow[], validatedVersion: number) => void;
  onVariableMappings: (mappings: PostDetailDomVariableMapping[]) => void;
  onHiddenExtractedData: (hidden: Record<string, string[]>) => void;
  onReviewInStep3: (url: string, resolution: PostDetailSavedParentResolution) => void;
  onBackToStep3: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [selectedUrl, setSelectedUrl] = useState<string>("");
  const [copiedJson, setCopiedJson] = useState(false);
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);
  const [reviewResolution, setReviewResolution] = useState<PostDetailSavedParentResolution | null>(null);
  const [reviewStaleWarning, setReviewStaleWarning] = useState<string>("");
  const cancelRef = useRef(false);
  const reviewEpochRef = useRef(0);

  const parsed = useMemo(() => parseBatchUrls(batchUrlsText), [batchUrlsText]);
  const validCount = parsed.items.filter((i) => i.valid).length;
  const invalidCount = parsed.items.length - validCount;
  const isStale =
    batchResults.length > 0 &&
    batchValidatedVersion !== null &&
    batchValidatedVersion !== batchConfigVersion;

  const selectedRow =
    batchResults.find((r) => r.url === selectedUrl) || batchResults[0] || null;

  const runBatch = async () => {
    if (running || parsed.items.length === 0) return;
    cancelRef.current = false;
    setRunning(true);
    setCopiedJson(false);

    const runVersion = batchConfigVersion;
    const registryVariables = listRegistryVariables();
    const collected: BatchValidationRow[] = [];

    try {
      for (let idx = 0; idx < parsed.items.length; idx++) {
        if (cancelRef.current) break;
        const item = parsed.items[idx];
        setProgressText(`Validating ${idx + 1}/${parsed.items.length}: ${item.url}`);

        if (!item.valid) {
          collected.push({
            url: item.url,
            resolvedUrl: "",
            postId: null,
            parentStatus: "Invalid",
            passedCount: 0,
            totalCount: variableMappings.length,
            status: "FAILED",
            failureReason: item.error || "Invalid URL",
            fields: [],
            validatedAt: new Date().toISOString(),
          });
          onBatchResults([...collected], runVersion);
          continue;
        }

        const platform = item.platform || "facebook";
        const config = parentConfigs[platform];
        if (!config) {
          collected.push({
            url: item.url,
            resolvedUrl: "",
            postId: item.postId,
            parentStatus: "Failed",
            passedCount: 0,
            totalCount: variableMappings.length,
            status: "FAILED",
            failureReason: `Parent config not configured for ${platform}`,
            fields: [],
            validatedAt: new Date().toISOString(),
          });
          onBatchResults([...collected], runVersion);
          continue;
        }

        let resolvedUrl = item.url;
        let resolution: PostDetailSavedParentResolution | null = null;

        try {
          await invoke({ type: "postDetailNavigate", url: item.url });
          resolution = await resolveStableParent({
            invoke,
            config,
            expectedPostId: item.postId,
            currentUrl: item.url,
            cancelled: () => cancelRef.current,
            onWaiting: message => setProgressText(`Waiting DOM (${idx + 1}/${parsed.items.length}) · ${message}`),
          });
          if (cancelRef.current) break;
          try {
            const probe = await invoke<BrowserProbe>({ type: "postDetailBrowserProbe" });
            if (probe?.url) resolvedUrl = probe.url;
          } catch {
            /* keep navigated url */
          }
        } catch (err) {
          resolution = {
            status: "REMATCH_REQUIRED",
            failureCode: "BROWSER_NOT_READY",
            innerHTML: "",
            rect: null,
            diagnostics: [String(err)],
          };
        }

        if (cancelRef.current) break;

        const effectiveResolution: PostDetailSavedParentResolution = resolution || {
          status: "REMATCH_REQUIRED",
          failureCode: "BROWSER_NOT_READY",
          innerHTML: "",
          rect: null,
          diagnostics: ["No resolution response"],
        };
        const rootElement =
          effectiveResolution.status === "PARENT_MATCHED"
            ? parseHtmlFragment(effectiveResolution.innerHTML)
            : null;

        const row = evaluateMatchedParentDom({
          url: item.url,
          resolvedUrl,
          postId: item.postId,
          resolution: effectiveResolution,
          rootElement,
          mappings: variableMappings,
          registryVariables,
        });
        collected.push(row);
        onBatchResults([...collected], runVersion);
        if (!selectedUrl) setSelectedUrl(row.url);
      }
    } finally {
      setRunning(false);
      setProgressText(cancelRef.current ? "Batch stopped by user." : "Batch validation complete.");
    }
  };

  const stopBatch = () => {
    cancelRef.current = true;
    setProgressText("Stopping after current check...");
  };

  const openInBrowser = async (url: string) => {
    try {
      await invoke({ type: "postDetailNavigate", url });
    } catch {
      /* ignore */
    }
  };

  const customizeRowInStep3 = async (row: BatchValidationRow) => {
    const platform = /threads\.(?:com|net)/i.test(row.url) ? "threads" : "facebook";
    const config = parentConfigs[platform];
    try {
      await invoke({ type: "postDetailNavigate", url: row.url });
      if (config) {
        const res = await invoke<PostDetailSavedParentResolution>({
          type: "postDetailResolveSavedParent",
          config,
        });
        onReviewInStep3(row.url, res);
        return;
      }
    } catch {
      /* fallback to Step 3 */
    }
    onBackToStep3();
  };

  const copyRowJson = () => {
    if (!selectedRow) return;
    void navigator.clipboard.writeText(JSON.stringify(selectedRow, null, 2));
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 1800);
  };

  const openRowDetailReview = async (row: BatchValidationRow) => {
    const epoch = ++reviewEpochRef.current;
    setSelectedUrl(row.url);
    setReviewUrl(row.url);
    setReviewStaleWarning("");
    setReviewResolution({
      status: "RESOLVING",
      innerHTML: "",
      rect: null,
      diagnostics: [`Loading ${row.url} in BrowserCore...`],
    });

    const platform = /threads\.(?:com|net)/i.test(row.url) ? "threads" : "facebook";
    const config = parentConfigs[platform];
    if (!config) {
      setReviewResolution({
        status: "NOT_CONFIGURED",
        innerHTML: "",
        rect: null,
        diagnostics: [`Parent config not configured for ${platform}`],
      });
      return;
    }

    try {
      let needsNav = true;
      try {
        const probe = await invoke<BrowserProbe>({ type: "postDetailBrowserProbe" });
        if (probe?.url && (probe.url === row.resolvedUrl || probe.url === row.url)) {
          needsNav = false;
        }
      } catch {
        /* navigate */
      }
      if (epoch !== reviewEpochRef.current) return;
      if (needsNav) {
        await invoke({ type: "postDetailNavigate", url: row.url });
      }
      const res = await resolveStableParent({
        invoke,
        config,
        expectedPostId: row.postId,
        currentUrl: row.url,
        cancelled: () => epoch !== reviewEpochRef.current,
      });
      if (epoch !== reviewEpochRef.current || !res) return;

      const probeAfter = await invoke<BrowserProbe>({ type: "postDetailBrowserProbe" }).catch(() => null);
      if (epoch !== reviewEpochRef.current) return;

      const liveIdentity = probeAfter?.url ? extractPostIdentityFromUrl(probeAfter.url) : null;
      const resolvedIdentity = typeof res.diagnosticMeta?.postId === "string" ? res.diagnosticMeta.postId : null;
      let staleReason = "";
      if (res.diagnosticMeta?.readinessVerified !== true) {
        staleReason = "Navigation/DOM readiness was not verified; live highlighting is disabled.";
      } else if (row.postId && resolvedIdentity !== row.postId) {
        staleReason = `Post identity mismatch: expected #${row.postId}, resolved Parent is #${resolvedIdentity || "unknown"}.`;
      } else if (row.postId && liveIdentity?.postId && liveIdentity.postId !== row.postId) {
        staleReason = `Post identity mismatch: expected #${row.postId}, live BrowserCore is #${liveIdentity.postId}.`;
      } else if (res.status === "PARENT_MATCHED" && row.parentStatus === "Matched" && row.fields.length > 0) {
        const root = parseHtmlFragment(res.innerHTML);
        const liveEval = evaluateMatchedParentDom({
          url: row.url,
          resolvedUrl: probeAfter?.url || row.resolvedUrl || row.url,
          postId: row.postId,
          resolution: res,
          rootElement: root,
          mappings: variableMappings,
          registryVariables: listRegistryVariables(),
        });
        const differences = row.fields.flatMap((f) => {
          const liveF = liveEval.fields.find((lf) => lf.variableId === f.variableId);
          return liveF && (liveF.value !== f.value || liveF.fieldStatus !== f.fieldStatus) ? [{ snapshot: f, live: liveF }] : [];
        });
        if (differences.some(({ live }) => live.variableKey === "post_images" && live.fieldStatus === "NEEDS_ATTENTION")) {
          staleReason = "Post media is still lazy-loading; live highlighting is disabled until media locators stabilize.";
        } else if (differences.some(({ snapshot, live }) => snapshot.fieldStatus === "PASS" && live.fieldStatus !== "PASS")) {
          staleReason = "DOM structure/path is stale: a previously mapped field no longer resolves to verified live data.";
        } else if (differences.length) {
          staleReason = "Live data value changed after the batch snapshot; Parent identity and current locators remain verified.";
        }
      }
      setReviewStaleWarning(staleReason);
      setReviewResolution(res);
    } catch (err) {
      if (epoch !== reviewEpochRef.current) return;
      setReviewResolution({
        status: "REMATCH_REQUIRED",
        failureCode: "BROWSER_NOT_READY",
        innerHTML: "",
        rect: null,
        diagnostics: [String(err)],
      });
    }
  };

  const reviewRowIndex = reviewUrl ? batchResults.findIndex((r) => r.url === reviewUrl) : -1;
  const reviewRow = reviewRowIndex >= 0 ? batchResults[reviewRowIndex] : null;
  if (reviewRow) {
    return (
      <SavedParentHtmlStep
        invoke={invoke}
        result={reviewResolution}
        currentUrl={reviewRow.resolvedUrl || reviewRow.url}
        variableMappings={variableMappings}
        onVariableMappings={onVariableMappings}
        hiddenExtractedData={hiddenExtractedData}
        onHiddenExtractedData={onHiddenExtractedData}
        onRematch={() => void customizeRowInStep3(reviewRow)}
        reviewMode={{
          row: reviewRow,
          rowIndex: reviewRowIndex,
          totalRows: batchResults.length,
          canPrev: reviewRowIndex > 0,
          canNext: reviewRowIndex < batchResults.length - 1,
          staleDomWarning: reviewStaleWarning || undefined,
          onBackToResults: () => {
            reviewEpochRef.current += 1;
            setReviewUrl(null);
            setReviewResolution(null);
            setReviewStaleWarning("");
          },
          onPrevPost: () => {
            if (reviewRowIndex > 0) void openRowDetailReview(batchResults[reviewRowIndex - 1]);
          },
          onNextPost: () => {
            if (reviewRowIndex < batchResults.length - 1) void openRowDetailReview(batchResults[reviewRowIndex + 1]);
          },
          onCustomizeInStep3: () => void customizeRowInStep3(reviewRow),
        }}
      />
    );
  }

  return (
    <div className="pdc-step pdc-step4">
      <div className="pdc-section-header">
        <div>
          <h2>Step 4 — Batch Validation</h2>
          <p className="pdc-subtitle">
            Read-only validation of saved Parent locator and Variable mappings across multiple Facebook Post URLs using BrowserCore.
          </p>
        </div>
        <div className="pdc-btn-row">
          <button type="button" className="pdc-btn pdc-btn-secondary" onClick={onBackToStep3}>
            ← Back to Step 3
          </button>
          {running ? (
            <button type="button" className="pdc-btn pdc-btn-danger" onClick={stopBatch}>
              Stop Batch
            </button>
          ) : (
            <button
              type="button"
              className="pdc-btn pdc-btn-primary"
              disabled={parsed.items.length === 0}
              onClick={() => void runBatch()}
            >
              Run Batch Validation ({parsed.items.length})
            </button>
          )}
        </div>
      </div>

      {isStale && (
        <div className="pdc-alert pdc-alert-warn" role="status">
          Mappings or Variable definitions changed since the last validation run. Re-run Batch Validation to verify latest configuration.
        </div>
      )}

      {progressText && (
        <div className="pdc-alert pdc-alert-ok" role="status">
          {progressText}
        </div>
      )}

      <div className="pdc-batch-layout">
        <div className="pdc-batch-input-card">
          <div className="pdc-batch-card-head">
            <h3>Post URLs (one per line)</h3>
            <span className="pdc-panel-desc">
              {validCount} valid · {invalidCount} invalid · {parsed.duplicateCount} duplicates removed
            </span>
          </div>
          <textarea
            className="pdc-batch-textarea"
            aria-label="Batch Post URLs"
            rows={5}
            disabled={running}
            value={batchUrlsText}
            onChange={(e) => onBatchUrlsText(e.target.value)}
            placeholder={"https://www.facebook.com/groups/abc/posts/123/\nhttps://www.facebook.com/groups/abc/posts/456/"}
          />
        </div>

        <div className="pdc-batch-results-grid">
          <div className="pdc-batch-table-wrap">
            <h3>Validation Results ({batchResults.length})</h3>
            {batchResults.length ? (
              <table className="pdc-batch-table">
                <thead>
                  <tr>
                    <th>Post</th>
                    <th>Parent</th>
                    <th>Fields</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {batchResults.map((row) => (
                    <tr
                      key={row.url}
                      className={selectedRow?.url === row.url ? "selected" : ""}
                      onClick={() => void openRowDetailReview(row)}
                    >
                      <td className="pdc-batch-url-cell" title={row.url}>
                        {formatShortPostLabel(row.url, row.postId)}
                      </td>
                      <td>{row.parentStatus}</td>
                      <td title={`Extracted: ${row.extractedCount ?? row.passedCount} · Missing: ${row.missingCount ?? 0} · Needs Attention: ${row.needsAttentionCount ?? 0}`}>
                        {row.passedCount}/{row.totalCount}
                        {(row.missingCount || row.needsAttentionCount) ? (
                          <div className="pdc-batch-breakdown">
                            {row.missingCount ? `${row.missingCount} miss` : ""}{row.missingCount && row.needsAttentionCount ? " · " : ""}{row.needsAttentionCount ? `${row.needsAttentionCount} attn` : ""}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <span className={`pdc-batch-pill status-${row.status.toLowerCase()}`}>
                          {row.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="pdc-panel-desc">
                Paste Facebook Post URLs above and click Run Batch Validation.
              </p>
            )}
          </div>

          <div className="pdc-batch-detail-wrap">
            <div className="pdc-batch-card-head">
              <h3>Row Details</h3>
              {selectedRow && (
                <div className="pdc-btn-row">
                  <button type="button" className="pdc-btn pdc-btn-tiny" onClick={copyRowJson}>
                    {copiedJson ? "Copied!" : "Copy JSON"}
                  </button>
                  <button
                    type="button"
                    className="pdc-btn pdc-btn-tiny"
                    onClick={() => void openInBrowser(selectedRow.url)}
                  >
                    Open in BrowserCore
                  </button>
                  <button
                    type="button"
                    className="pdc-btn pdc-btn-tiny pdc-btn-primary"
                    onClick={() => void customizeRowInStep3(selectedRow)}
                  >
                    Customize in Step 3
                  </button>
                </div>
              )}
            </div>

            {selectedRow ? (
              <div className="pdc-batch-detail-body">
                <dl className="pdc-kv">
                  <dt>Source URL</dt>
                  <dd>{selectedRow.url}</dd>
                  <dt>Resolved URL</dt>
                  <dd>{selectedRow.resolvedUrl || "—"}</dd>
                  <dt>Parent</dt>
                  <dd>{selectedRow.parentStatus}</dd>
                  {selectedRow.failureReason && (
                    <>
                      <dt>Failure / Note</dt>
                      <dd>{selectedRow.failureReason}</dd>
                    </>
                  )}
                </dl>

                {selectedRow.fields.length > 0 && (
                  <table className="pdc-batch-table">
                    <thead>
                      <tr>
                        <th>Variable</th>
                        <th>Value</th>
                        <th>Method</th>
                        <th>Locator</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedRow.fields.map((f) => (
                        <tr key={`${f.variableId}:${f.variableKey}`}>
                          <td>{f.variableKey}</td>
                          <td className="pdc-preserve-lines">{f.value || "—"}</td>
                          <td>{f.attribute ? `${f.method}(${f.attribute})` : f.method}</td>
                          <td>
                            <code>{f.relativeXPath || "—"}</code>
                          </td>
                          <td>
                            <span className={`pdc-batch-pill status-${f.status.toLowerCase()}`}>
                              {f.status}
                            </span>
                            {f.reason && <div className="pdc-panel-desc">{f.reason}</div>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {selectedRow.parentDiagnostics && selectedRow.parentDiagnostics.length > 0 && (
                  <details className="pdc-advanced-debug">
                    <summary>Parent Diagnostics</summary>
                    {selectedRow.parentDiagnostics.map((d, i) => (
                      <p key={i} className="pdc-panel-desc">
                        {d}
                      </p>
                    ))}
                  </details>
                )}
              </div>
            ) : (
              <p className="pdc-panel-desc">Select a row from the results table to inspect field extraction.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
