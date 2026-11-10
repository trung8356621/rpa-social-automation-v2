import React, { useMemo, useState } from "react";
import type { Command, OcrResult, OcrSegment, Rect } from "../../../shared/contracts";
import type { FixtureItem } from "../../../../experiments/visual-match-lab/src/fixtures/fixture-manager";
import type { MatchCandidate, RecognizedGroup } from "../../../../experiments/visual-match-lab/src/types";

type Invoke = <T>(command: Command) => Promise<T>;
type ItemCluster = {
  id: string;
  bbox: Rect;
  matches: MatchCandidate[];
  confidence: number;
  ocrValues: Array<{ value: string; confidence: number }>;
  context: "post" | "comment" | "unknown";
  verdict: "Detected" | "Needs Attention";
};

const union = (items: MatchCandidate[]): Rect => {
  const left = Math.min(...items.map(item => item.bbox.x));
  const top = Math.min(...items.map(item => item.bbox.y));
  const right = Math.max(...items.map(item => item.bbox.x + item.bbox.width));
  const bottom = Math.max(...items.map(item => item.bbox.y + item.bbox.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
};

const numericNear = (segments: OcrSegment[], bbox: Rect) => segments
  .filter(segment => /\d/u.test(segment.text))
  .filter(segment => {
    const cy = segment.bbox.y + segment.bbox.height / 2;
    const groupCy = bbox.y + bbox.height / 2;
    return Math.abs(cy - groupCy) <= Math.max(32, bbox.height * 2.5);
  })
  .map(segment => ({ value: segment.text.match(/[\d.,]+/u)?.[0] ?? segment.text, confidence: segment.confidence }));

export function clusterMatches(matches: MatchCandidate[], ocr?: OcrResult | null): ItemCluster[] {
  const sorted = [...matches].sort((a, b) => (a.bbox.y + a.bbox.height / 2) - (b.bbox.y + b.bbox.height / 2));
  const rows: MatchCandidate[][] = [];
  for (const match of sorted) {
    const cy = match.bbox.y + match.bbox.height / 2;
    const row = rows.find(items => {
      const centers = items.map(item => item.bbox.y + item.bbox.height / 2);
      const rowCy = centers.reduce((sum, value) => sum + value, 0) / centers.length;
      const tolerance = Math.max(28, match.bbox.height * 1.75, ...items.map(item => item.bbox.height * 1.75));
      return Math.abs(cy - rowCy) <= tolerance;
    });
    if (row) row.push(match); else rows.push([match]);
  }
  return rows.map((items, index) => {
    const bbox = union(items);
    const horizontalSpan = bbox.width / Math.max(1, Math.max(...items.map(item => item.bbox.width)));
    const hasActionRowEvidence = items.length >= 3 && horizontalSpan >= 4;
    return {
      id: `item-${index + 1}`,
      bbox,
      matches: items,
      confidence: items.reduce((sum, item) => sum + item.score, 0) / items.length,
      ocrValues: numericNear(ocr?.segments ?? [], bbox),
      context: hasActionRowEvidence ? "post" : "unknown",
      verdict: hasActionRowEvidence ? "Detected" : "Needs Attention",
    };
  });
}

export function MultiItemRecognition({ invoke, targetImage, matches, actionGroups }: {
  invoke: Invoke;
  targetImage: FixtureItem | null;
  matches: MatchCandidate[];
  actionGroups: RecognizedGroup[];
}) {
  const [ocr, setOcr] = useState<OcrResult | null>(null);
  const [status, setStatus] = useState("Run Stage E first, then run this sample-image test.");
  const [running, setRunning] = useState(false);
  const clusters = useMemo(() => clusterMatches(matches, ocr), [matches, ocr]);
  const run = async () => {
    if (!targetImage || matches.length === 0) { setStatus("Needs Attention: upload a target image and run Stage E first."); return; }
    setRunning(true);
    try {
      const result = await invoke<OcrResult>({ type: "visualMatchLabOcr", dataUrl: targetImage.dataUrl });
      setOcr(result);
      setStatus(`Detection: ${matches.length} matches / ${clusterMatches(matches, result).length} item clusters. OCR is reported separately.`);
    } catch (error) {
      setOcr(null);
      setStatus(`Detection completed; OCR Needs Attention: ${String(error)}`);
    } finally { setRunning(false); }
  };
  return <section style={{ background: "var(--bg-card)", border: "1px solid var(--border-color)", borderRadius: 8, padding: 16, marginTop: 20 }}>
    <h2 style={{ fontSize: 14, color: "var(--accent-purple)", textTransform: "uppercase", marginBottom: 8 }}>Multi-Item Recognition — Sample Image Test</h2>
    <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>Test A Detect &amp; Read · Test B Count Items · Test C Duplicate Values</p>
    <button onClick={() => void run()} disabled={running} style={{ padding: "8px 14px", background: "var(--accent-purple)", color: "#0f172a", border: 0, borderRadius: 4, fontWeight: 700 }}>{running ? "Running OCR…" : "Run Multi-Item Recognition"}</button>
    <div role="status" style={{ marginTop: 10, fontSize: 12 }}>{status}</div>
    <div style={{ marginTop: 10, overflowX: "auto" }}>
      <table style={{ width: "100%", minWidth: 760, borderCollapse: "collapse", fontSize: 12 }}>
        <thead><tr>{["Item", "OpenCV bbox", "Matches", "Detection confidence", "OCR values (separate)", "Context", "Verdict"].map(value => <th key={value} style={{ padding: 7, textAlign: "left", borderBottom: "1px solid var(--border-color)" }}>{value}</th>)}</tr></thead>
        <tbody>{clusters.map(cluster => <tr key={cluster.id}>
          <td style={{ padding: 7 }}>{cluster.id}</td><td style={{ padding: 7 }}>{cluster.bbox.x}, {cluster.bbox.y}, {cluster.bbox.width}×{cluster.bbox.height}</td>
          <td style={{ padding: 7 }}>{cluster.matches.length}</td><td style={{ padding: 7 }}>{(cluster.confidence * 100).toFixed(1)}%</td>
          <td style={{ padding: 7 }}>{cluster.ocrValues.length ? cluster.ocrValues.map(value => `${value.value} (${value.confidence.toFixed(0)}%)`).join(", ") : "Not read"}</td>
          <td style={{ padding: 7 }}>{cluster.context}</td><td style={{ padding: 7, color: cluster.verdict === "Detected" ? "var(--accent-green)" : "var(--accent-amber)" }}>{cluster.verdict}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <div style={{ marginTop: 8, color: "var(--text-muted)", fontSize: 11 }}>Duplicate OCR values never merge clusters. Post/comment remains Needs Attention without sufficient action-row evidence. Reference action groups: {actionGroups.length}.</div>
  </section>;
}
