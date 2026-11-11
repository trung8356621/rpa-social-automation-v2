import React, { useState, useEffect } from "react";
import type { LiveCandidate } from "./LiveScrollTest";
import type { LiveCapture } from "./types";
import type { Command } from "../../../shared/contracts";
import type { BoundaryProbeResult } from "../../../shared/boundary-probe";
import { resolveBoundaryFromAncestors } from "../../../shared/boundary-probe";
import type { PostIdentity } from "../../../shared/permalink-adapter";
import {
  PermalinkRuleRegistry,
  detectRuleConflict,
  validateRuleTemplate,
  type UserPermalinkRule,
} from "../../../shared/permalink-rules";
import { resolveFullUrl } from "./PermalinkInspector";

type Invoke = <T>(command: Command) => Promise<T>;

export function generateTemplateSuggestion(rawUrl: string): { template: string; ruleName: string } {
  try {
    const trimmed = rawUrl.trim();
    const urlObj = new URL(trimmed, "https://www.facebook.com");
    const pathname = urlObj.pathname;
    let template = urlObj.href;
    let ruleName = `Rule for ${pathname}`;

    // 1. Group photo with set=pcb or set=gm
    if (pathname.includes("/photo") && urlObj.searchParams.has("set")) {
      const setVal = urlObj.searchParams.get("set") || "";
      if (setVal.startsWith("pcb.")) {
        template = `${urlObj.origin}/photo/?fbid={photoId}&set=pcb.{postId}`;
        ruleName = "Facebook Photo (set=pcb.{postId})";
        return { template, ruleName };
      }
      if (setVal.startsWith("gm.")) {
        template = `${urlObj.origin}/photo/?fbid={photoId}&set=gm.{postId}&idorvanity={groupId}`;
        ruleName = "Facebook Photo (set=gm.{postId})";
        return { template, ruleName };
      }
    }

    // 2. Group posts: /groups/{group}/posts/{postId}/
    const groupMatch = /\/groups\/([^/]+)\/(posts|permalink)\/([^/?#]+)/.exec(pathname);
    if (groupMatch) {
      template = `${urlObj.origin}/groups/{groupId}/${groupMatch[2]}/{postId}/`;
      ruleName = `Facebook Group ${groupMatch[2] === "permalink" ? "Permalink" : "Post"}`;
      return { template, ruleName };
    }

    // 2b. Group user link: /groups/{group}/user/{userId}/
    const groupUserMatch = /\/groups\/([^/]+)\/user\/([^/?#]+)/.exec(pathname);
    if (groupUserMatch) {
      template = `${urlObj.origin}/groups/{groupId}/user/{postId}/`;
      ruleName = "Facebook Group User Link (non-post)";
      return { template, ruleName };
    }

    // 3. User / Page posts: /{slug}/posts/{postId}/
    const pageMatch = /^\/([^/]+)\/posts\/([^/?#]+)/.exec(pathname);
    if (pageMatch) {
      template = `${urlObj.origin}/{pageOrUser}/posts/{postId}/`;
      ruleName = `Facebook Post (${pageMatch[1]})`;
      return { template, ruleName };
    }

    // 4. Legacy permalink.php
    if (pathname.includes("/permalink.php")) {
      template = `${urlObj.origin}/permalink.php?story_fbid={postId}&id={ownerId}`;
      ruleName = "Facebook Legacy permalink.php";
      return { template, ruleName };
    }

    // 5. Story.php
    if (pathname.includes("/story.php")) {
      template = `${urlObj.origin}/story.php?story_fbid={postId}&id={ownerId}`;
      ruleName = "Facebook story.php";
      return { template, ruleName };
    }

    // Fallback: strip tracking params (__cft__, __tn__) and attach {postId}
    const cleanUrl = `${urlObj.origin}${urlObj.pathname}`;
    return {
      template: cleanUrl.includes("{postId}") ? cleanUrl : `${cleanUrl}?story_fbid={postId}`,
      ruleName: `Custom Rule (${pathname.slice(0, 20)})`,
    };
  } catch {
    return {
      template: rawUrl,
      ruleName: "Custom Rule",
    };
  }
}

export function PermalinkRuleEditor({
  frameNumber,
  candidateIndex,
  candidate,
  capture,
  rules,
  onRuleSaved,
  onUpdateBoundary,
  prefillUrl,
  invoke,
}: {
  frameNumber: number;
  candidateIndex: number;
  candidate: LiveCandidate;
  capture: LiveCapture;
  rules: UserPermalinkRule[];
  onRuleSaved: (newRule: UserPermalinkRule) => void;
  onUpdateBoundary: (newBoundary: BoundaryProbeResult, evidenceUrl?: string) => void;
  prefillUrl?: string | null;
  invoke: Invoke;
}) {
  const [templateInput, setTemplateInput] = useState("https://www.facebook.com/photo/?fbid={photoId}&set=pcb.{postId}");
  const [ruleNameInput, setRuleNameInput] = useState("Custom Photo PCB Rule");
  const [isTestingOffline, setIsTestingOffline] = useState(false);
  const [isTestingLive, setIsTestingLive] = useState(false);
  const [lastTestedTemplate, setLastTestedTemplate] = useState<string | null>(null);

  const [testResult, setTestResult] = useState<{
    valid: boolean;
    error?: string;
    conflicts: any[];
    matchedUrls: number;
    beforeStatus: string;
    afterStatus: string;
    beforeTransition: string;
    afterTransition: string;
    candidateContainer?: string;
    mode: "offline" | "live";
  } | null>(null);
  const [saveBanner, setSaveBanner] = useState<string | null>(null);

  // Reset test/save state when switching frame or candidate row (Next/Prev)
  useEffect(() => {
    setTestResult(null);
    setSaveBanner(null);
    setLastTestedTemplate(null);
  }, [frameNumber, candidateIndex]);

  // When user clicks "Use URL" in Permalink Inspector, auto-populate template
  useEffect(() => {
    if (prefillUrl) {
      const suggestion = generateTemplateSuggestion(prefillUrl);
      setTemplateInput(suggestion.template);
      setRuleNameInput(suggestion.ruleName);
      setTestResult(null);
      setSaveBanner(null);
      setLastTestedTemplate(null);
    }
  }, [prefillUrl]);

  const sampleUrls = [
    ...new Set(
      (candidate.boundary?.ancestorSteps ?? []).flatMap(s => (s.rawUrls ?? []).map(u => resolveFullUrl(u)))
    ),
  ];

  const runTestOffline = () => {
    setSaveBanner(null);
    setIsTestingOffline(true);

    try {
      const val = validateRuleTemplate(templateInput);
      if (!val.valid) {
        setTestResult({
          valid: false,
          error: val.error,
          conflicts: [],
          matchedUrls: 0,
          beforeStatus: candidate.boundary?.status ?? "NONE",
          afterStatus: "VALIDATION_FAILED",
          beforeTransition: candidate.boundary?.jumpReason || "None",
          afterTransition: "Validation failed",
          mode: "offline",
        });
        return;
      }

      // Check evidence availability
      if (!candidate?.boundary || !candidate.boundary.ancestorSteps?.length) {
        setTestResult({
          valid: false,
          error: `EVIDENCE_MISSING: Frame #${frameNumber} không có dữ liệu ancestor steps để test offline.`,
          conflicts: [],
          matchedUrls: 0,
          beforeStatus: candidate.boundary?.status ?? "NONE",
          afterStatus: "EVIDENCE_MISSING",
          beforeTransition: "N/A",
          afterTransition: "N/A",
          mode: "offline",
        });
        return;
      }

      const testRule: UserPermalinkRule = {
        id: `test_offline_${Date.now()}`,
        name: ruleNameInput.trim() || "Test Rule",
        platform: "facebook",
        template: templateInput.trim(),
        enabled: true,
      };

      const conflictRes = detectRuleConflict(testRule, rules, sampleUrls);
      const testRegistry = new PermalinkRuleRegistry([testRule, ...rules]);

      let matchedCount = 0;
      const updatedSteps = (candidate.boundary.ancestorSteps ?? []).map(step => {
        const posts: PostIdentity[] = [];
        const keys = new Set<string>();
        for (const u of step.rawUrls ?? []) {
          const fullUrl = resolveFullUrl(u);
          const m = testRegistry.match(fullUrl) ?? testRegistry.match(u);
          if (m) {
            const k = `${m.identity.platform}:${m.identity.postId}`;
            if (!keys.has(k)) {
              keys.add(k);
              posts.push(m.identity);
            }
            if (m.ruleId === testRule.id) matchedCount++;
          }
        }
        return {
          ...step,
          postIdentities: posts,
          uniqueKeys: Array.from(keys),
        };
      });

      const actionRowRect = {
        x: candidate.bbox.x,
        y: candidate.bbox.y,
        width: candidate.bbox.width,
        height: candidate.bbox.height,
      };
      const newBoundary = resolveBoundaryFromAncestors(
        updatedSteps,
        candidate.boundary?.actionPoint ?? { x: candidate.bbox.x + 20, y: candidate.bbox.y + 10 },
        actionRowRect,
      );

      const beforeTransition =
        candidate.boundary?.jumpReason ||
        (candidate.boundary?.firstPermalinkLevel !== null
          ? `L${candidate.boundary?.firstPermalinkLevel} -> L${candidate.boundary?.secondPermalinkLevel}`
          : "0 posts");

      const afterTransition =
        newBoundary.jumpReason ||
        (newBoundary.firstPermalinkLevel !== null
          ? `L${newBoundary.firstPermalinkLevel} -> L${newBoundary.secondPermalinkLevel}`
          : "0 posts");

      const containerDesc = newBoundary.candidateContainer
        ? `<${newBoundary.candidateContainer.tag}${newBoundary.candidateContainer.role ? ` role="${newBoundary.candidateContainer.role}"` : ""}> L${newBoundary.candidateContainer.level} (${Math.round(newBoundary.candidateContainer.rect.width)}×${Math.round(newBoundary.candidateContainer.rect.height)})`
        : "None";

      setLastTestedTemplate(templateInput.trim());
      setTestResult({
        valid: true,
        conflicts: conflictRes.conflicts,
        matchedUrls: matchedCount,
        beforeStatus: candidate.boundary?.status ?? "NONE",
        afterStatus: newBoundary.status,
        beforeTransition,
        afterTransition,
        candidateContainer: containerDesc,
        mode: "offline",
      });

      if (newBoundary.status === "BOUNDARY_FOUND") {
        onUpdateBoundary(newBoundary);
      }
    } finally {
      setIsTestingOffline(false);
    }
  };

  const runTestLive = async () => {
    setSaveBanner(null);
    setIsTestingLive(true);

    try {
      const val = validateRuleTemplate(templateInput);
      if (!val.valid) {
        setTestResult({
          valid: false,
          error: val.error,
          conflicts: [],
          matchedUrls: 0,
          beforeStatus: candidate.boundary?.status ?? "NONE",
          afterStatus: "VALIDATION_FAILED",
          beforeTransition: "Validation error",
          afterTransition: "Validation error",
          mode: "live",
        });
        return;
      }

      // Check if this capture is from a loaded offline run (cannot run live DOM hit-test against historical run)
      if (capture.id.startsWith("capture_") && capture.id.includes("run_")) {
        setTestResult({
          valid: false,
          error: "LIVE_CONTEXT_UNAVAILABLE: Frame này được nạp từ run đã lưu trong quá khứ. Live DOM hit-test chỉ thực hiện được trên session BrowserCore đang chạy trực tiếp.",
          conflicts: [],
          matchedUrls: 0,
          beforeStatus: candidate.boundary?.status ?? "NONE",
          afterStatus: "LIVE_CONTEXT_UNAVAILABLE",
          beforeTransition: "N/A",
          afterTransition: "N/A",
          mode: "live",
        });
        return;
      }

      const testRule: UserPermalinkRule = {
        id: `test_live_${Date.now()}`,
        name: ruleNameInput.trim() || "Test Rule",
        platform: "facebook",
        template: templateInput.trim(),
        enabled: true,
      };

      const conflictRes = detectRuleConflict(testRule, rules, sampleUrls);

      const liveRes = await invoke<BoundaryProbeResult & { evidenceDataUrl?: string }>({
        type: "visualMatchLabProbeBoundary",
        captureId: capture.id,
        webContentsId: capture.webContentsId,
        point: {
          x: Math.round((candidate.bbox.x + candidate.bbox.width / 2) * capture.viewport.width / capture.width),
          y: Math.round((candidate.bbox.y + candidate.bbox.height / 2) * capture.viewport.height / capture.height),
        },
        actionRowBbox: candidate.bbox,
        options: { highlight: true, captureEvidence: true, customRules: [testRule, ...rules] },
      });

      const beforeTransition =
        candidate.boundary?.jumpReason ||
        (candidate.boundary?.firstPermalinkLevel !== null
          ? `L${candidate.boundary?.firstPermalinkLevel} -> L${candidate.boundary?.secondPermalinkLevel}`
          : "0 posts");

      const afterTransition =
        liveRes.jumpReason ||
        (liveRes.firstPermalinkLevel !== null
          ? `L${liveRes.firstPermalinkLevel} -> L${liveRes.secondPermalinkLevel}`
          : "0 posts");

      const containerDesc = liveRes.candidateContainer
        ? `<${liveRes.candidateContainer.tag}${liveRes.candidateContainer.role ? ` role="${liveRes.candidateContainer.role}"` : ""}> L${liveRes.candidateContainer.level} (${Math.round(liveRes.candidateContainer.rect.width)}×${Math.round(liveRes.candidateContainer.rect.height)})`
        : "None";

      setLastTestedTemplate(templateInput.trim());
      setTestResult({
        valid: true,
        conflicts: conflictRes.conflicts,
        matchedUrls: liveRes.postIdentities.length,
        beforeStatus: candidate.boundary?.status ?? "NONE",
        afterStatus: liveRes.status,
        beforeTransition,
        afterTransition,
        candidateContainer: containerDesc,
        mode: "live",
      });

      onUpdateBoundary(liveRes, liveRes.evidenceDataUrl);
    } catch (e) {
      const errStr = String(e);
      const isUnavailable = /STALE|WRONG_BROWSER|BROWSER_NOT_FACEBOOK|NOT_LOGGED_IN|capture_/i.test(errStr);
      setTestResult({
        valid: false,
        error: isUnavailable
          ? "LIVE_CONTEXT_UNAVAILABLE: BrowserCore không còn ở đúng viewport của frame này (trang đã scroll/navigate hoặc phiên đã đổi). Vui lòng chạy lại Live Scroll Test."
          : `Live test failed: ${errStr}`,
        conflicts: [],
        matchedUrls: 0,
        beforeStatus: candidate.boundary?.status ?? "NONE",
        afterStatus: isUnavailable ? "LIVE_CONTEXT_UNAVAILABLE" : "LIVE_PROBE_ERROR",
        beforeTransition: "N/A",
        afterTransition: "N/A",
        mode: "live",
      });
    } finally {
      setIsTestingLive(false);
    }
  };

  // Save Rule is ONLY enabled when tested successfully with at least 1 match and current template matches last tested
  const canSave =
    Boolean(testResult?.valid) &&
    (testResult?.matchedUrls ?? 0) > 0 &&
    lastTestedTemplate === templateInput.trim() &&
    !isTestingOffline &&
    !isTestingLive;

  const handleSave = () => {
    const val = validateRuleTemplate(templateInput);
    if (!val.valid || !canSave) return;
    const newRule: UserPermalinkRule = {
      id: `user_rule_${Date.now()}`,
      name: ruleNameInput.trim() || `User Rule (${templateInput.slice(0, 30)})`,
      platform: "facebook",
      template: templateInput.trim(),
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    onRuleSaved(newRule);
    setSaveBanner(`Rule "${newRule.name}" đã lưu thành công vào registry!`);
  };

  return (
    <div className="permalink-rule-editor url-inspector-block">
      <div className="url-block-header">
        <h5 className="section-subtitle">
          3. User-configurable Permalink Rule Editor
        </h5>
      </div>

      <div className="rule-inputs-grid">
        <div className="input-group">
          <label>Rule Name:</label>
          <input
            type="text"
            value={ruleNameInput}
            onChange={e => {
              setRuleNameInput(e.target.value);
              setSaveBanner(null);
            }}
            placeholder="e.g. Custom Photo PCB Rule"
          />
        </div>
        <div className="input-group">
          <label>URL Template (bắt buộc chứa &#123;postId&#125;):</label>
          <input
            type="text"
            value={templateInput}
            onChange={e => {
              setTemplateInput(e.target.value);
              setSaveBanner(null);
            }}
            placeholder="https://www.facebook.com/photo/?fbid={photoId}&set=pcb.{postId}"
            className="monospace-input"
          />
        </div>
      </div>

      <div className="rule-actions-bar">
        <button
          type="button"
          className="btn-offline"
          onClick={runTestOffline}
          disabled={isTestingOffline || isTestingLive}
        >
          {isTestingOffline ? "Testing Offline..." : "⚡ Test Rule (Offline)"}
        </button>

        <button
          type="button"
          className="btn-live"
          onClick={runTestLive}
          disabled={isTestingOffline || isTestingLive}
        >
          {isTestingLive ? "Testing Live DOM..." : "🌐 Test Rule (Live DOM)"}
        </button>

        <button
          type="button"
          className={`btn-save ${canSave ? "enabled" : "disabled"}`}
          onClick={handleSave}
          disabled={!canSave}
          title={canSave ? "Lưu rule vào registry" : "Vui lòng chạy Test Rule (Offline hoặc Live DOM) đạt kết quả hợp lệ trước khi lưu"}
        >
          💾 Save Rule
        </button>
      </div>

      {!canSave && (
        <div className="save-hint-text">
          ℹ Nút <b>Save Rule</b> chỉ kích hoạt sau khi kiểm tra rule (Offline/Live) có ít nhất 1 URL khớp thành công.
        </div>
      )}

      {saveBanner && (
        <div className="save-success-banner">
          ✔ {saveBanner}
        </div>
      )}

      {testResult && (
        <div className={`rule-test-preview ${testResult.valid ? "valid" : "invalid"}`}>
          {!testResult.valid ? (
            <div className="preview-error">⚠ {testResult.error}</div>
          ) : (
            <div>
              <div className="preview-header">
                <b>Mode: {testResult.mode.toUpperCase()} &middot; Khớp: {testResult.matchedUrls} URL(s)</b>
                <span>
                  <b>Before:</b> <span className={`badge-boundary ${testResult.beforeStatus}`}>{testResult.beforeStatus}</span>
                  {" ➔ "}
                  <b>After:</b> <span className={`badge-boundary ${testResult.afterStatus}`}>{testResult.afterStatus}</span>
                </span>
              </div>
              <div className="preview-details">
                <div>Transition: <code>{testResult.beforeTransition}</code> ➔ <code>{testResult.afterTransition}</code></div>
                {testResult.candidateContainer && <div>Candidate Container: {testResult.candidateContainer}</div>}
              </div>
              {testResult.conflicts.length > 0 && (
                <div className="preview-conflicts">
                  {testResult.conflicts.map((c, i) => (
                    <div key={i}>⚠ [{c.type}]: {c.message}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
