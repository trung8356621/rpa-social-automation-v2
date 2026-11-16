import type {
  PostDetailParentConfig,
  PostDetailSavedParentResolution,
} from "../../shared/post-detail-collector/types";
import { resolveStableParent, type ResolveStableParentProgress } from "./BatchValidationStep";
import { classifyAutoMatchGate, effectiveStrategyConfig } from "./url-workspace";
import type { Invoke, PostDetailDomStrategy } from "./types";

export const AUTO_MATCH_TOTAL_TIMEOUT_MS = 20_000;

export type TerminalResolutionStatus = Exclude<PostDetailSavedParentResolution["status"], "RESOLVING">;

export function isTerminalResolutionStatus(
  status: PostDetailSavedParentResolution["status"] | undefined | null,
): status is TerminalResolutionStatus {
  return Boolean(status && status !== "RESOLVING");
}

export function ensureTerminalResolution(
  resolution: PostDetailSavedParentResolution | null | undefined,
  fallbackStatus: TerminalResolutionStatus = "REMATCH_REQUIRED",
): Omit<PostDetailSavedParentResolution, "status"> & { status: TerminalResolutionStatus } {
  if (!resolution) {
    return {
      status: fallbackStatus,
      failureCode: fallbackStatus === "BROWSER_NOT_READY" ? "BROWSER_NOT_READY" : "NOT_FOUND",
      innerHTML: "",
      rect: null,
      diagnostics: ["Auto Match finished without a resolution result."],
    };
  }
  if (resolution.status === "RESOLVING") {
    return {
      ...resolution,
      status: fallbackStatus,
      failureCode: resolution.failureCode || (fallbackStatus === "BROWSER_NOT_READY" ? "BROWSER_NOT_READY" : "NOT_FOUND"),
      diagnostics: [...(resolution.diagnostics || []), "Normalized non-terminal RESOLVING state to terminal failure."],
    };
  }
  return { ...resolution, status: resolution.status };
}

export type AutoMatchRunResult = {
  outcome: "MATCHED" | "FAILED" | "CANCELLED";
  resolution: PostDetailSavedParentResolution;
  strategyId?: string;
  selectedConfig?: PostDetailParentConfig;
  anchorsVerified: boolean;
  elapsedMs: number;
};

export async function runAutoMatchStrategies(opts: {
  invoke: Invoke;
  strategies: PostDetailDomStrategy[];
  expectedPostId: string | null;
  currentUrl: string;
  isCancelled: () => boolean;
  timeoutMs?: number;
  maxAttemptsPerStrategy?: number;
  retryDelayMs?: number;
  onWaiting?: (message: string) => void;
  onProgress?: (progress: ResolveStableParentProgress) => void;
}): Promise<AutoMatchRunResult> {
  const startedAtMs = Date.now();
  const timeoutMs = opts.timeoutMs ?? AUTO_MATCH_TOTAL_TIMEOUT_MS;
  const deadlineMs = startedAtMs + timeoutMs;
  const elapsed = () => Math.max(0, Date.now() - startedAtMs);

  const cancelledReturn = (last?: PostDetailSavedParentResolution | null): AutoMatchRunResult => ({
    outcome: "CANCELLED",
    resolution: {
      status: "CANCELLED",
      innerHTML: "",
      rect: null,
      diagnosticMeta: {
        ...(last?.diagnosticMeta || {}),
        cancelled: true,
        elapsedMs: elapsed(),
      },
      diagnostics: [...(last?.diagnostics || []), "Auto Match cancelled."],
    },
    anchorsVerified: false,
    elapsedMs: elapsed(),
  });

  if (opts.isCancelled()) return cancelledReturn();

  if (opts.strategies.length === 0) {
    return {
      outcome: "FAILED",
      resolution: {
        status: "REMATCH_REQUIRED",
        failureCode: "NOT_FOUND",
        innerHTML: "",
        rect: null,
        diagnosticMeta: { expectedPostId: opts.expectedPostId, strategiesTried: 0, elapsedMs: elapsed() },
        diagnostics: ["No saved DOM strategy is available for this platform."],
      },
      anchorsVerified: false,
      elapsedMs: elapsed(),
    };
  }

  let lastResolution: PostDetailSavedParentResolution | null = null;
  let lastStrategyId: string | undefined;

  for (let index = 0; index < opts.strategies.length; index++) {
    if (opts.isCancelled()) return cancelledReturn(lastResolution);
    if (Date.now() >= deadlineMs) {
      return {
        outcome: "FAILED",
        resolution: {
          status: "BROWSER_NOT_READY",
          failureCode: "BROWSER_NOT_READY",
          innerHTML: "",
          rect: null,
          diagnosticMeta: {
            ...(lastResolution?.diagnosticMeta || {}),
            strategyId: lastStrategyId,
            strategiesTried: index,
            totalStrategies: opts.strategies.length,
            timedOut: true,
            elapsedMs: elapsed(),
          },
          diagnostics: [
            ...(lastResolution?.diagnostics || []),
            `Auto Match timed out after ${elapsed()}ms across ${index}/${opts.strategies.length} strategies.`,
          ],
        },
        strategyId: lastStrategyId,
        anchorsVerified: false,
        elapsedMs: elapsed(),
      };
    }

    const strategy = opts.strategies[index];
    lastStrategyId = strategy.id;
    const effectiveConfig = effectiveStrategyConfig(strategy);

    const resolution = await resolveStableParent({
      invoke: opts.invoke,
      config: effectiveConfig,
      expectedPostId: opts.expectedPostId,
      currentUrl: opts.currentUrl,
      maxAttempts: opts.maxAttemptsPerStrategy,
      retryDelayMs: opts.retryDelayMs,
      deadlineMs,
      startedAtMs,
      strategyId: strategy.id,
      strategyIndex: index + 1,
      totalStrategies: opts.strategies.length,
      cancelled: opts.isCancelled,
      onWaiting: opts.onWaiting,
      onProgress: opts.onProgress,
    });

    if (opts.isCancelled() || resolution.status === "CANCELLED") {
      return cancelledReturn(resolution);
    }

    lastResolution = resolution;

    const runtimeConfig = resolution.resolvedDomAnchors
      ? { ...effectiveConfig, domAnchors: resolution.resolvedDomAnchors, updatedAt: new Date().toISOString() }
      : effectiveConfig;
    const anchorsConfigured = ["like_anchor", "comment_anchor", "share_anchor"].every(
      (role) =>
        runtimeConfig.domAnchors?.[role as keyof NonNullable<typeof runtimeConfig.domAnchors>]?.verificationStatus === "VERIFIED",
    );
    const anchorsVerified = anchorsConfigured && resolution.diagnosticMeta?.domAnchorsVerified === true;
    const gate = classifyAutoMatchGate({
      status: resolution.status,
      postIdentityVerified: resolution.diagnosticMeta?.postIdentityVerified === true,
      parentVerified: resolution.diagnosticMeta?.parentVerified === true,
      engagementAnchorsVerified: anchorsVerified,
    });

    if (gate.canReview) {
      return {
        outcome: "MATCHED",
        resolution: {
          ...resolution,
          diagnosticMeta: {
            ...resolution.diagnosticMeta,
            engagementAnchorsVerified: anchorsVerified,
            strategyId: strategy.id,
            strategyVersion: strategy.version,
            parentConfigVersion: effectiveConfig.version,
            strategiesTried: index + 1,
            totalStrategies: opts.strategies.length,
            elapsedMs: elapsed(),
          },
        },
        strategyId: strategy.id,
        selectedConfig: runtimeConfig,
        anchorsVerified,
        elapsedMs: elapsed(),
      };
    }

    if (resolution.diagnosticMeta?.timedOut === true || Date.now() >= deadlineMs) {
      return {
        outcome: "FAILED",
        resolution: {
          ...ensureTerminalResolution(resolution, "BROWSER_NOT_READY"),
          status: "BROWSER_NOT_READY",
          failureCode: resolution.failureCode || "BROWSER_NOT_READY",
          diagnosticMeta: {
            ...(resolution.diagnosticMeta || {}),
            strategyId: strategy.id,
            strategiesTried: index + 1,
            totalStrategies: opts.strategies.length,
            timedOut: true,
            elapsedMs: elapsed(),
          },
        },
        strategyId: strategy.id,
        anchorsVerified: false,
        elapsedMs: elapsed(),
      };
    }
  }

  const terminal = ensureTerminalResolution(lastResolution, "REMATCH_REQUIRED");
  const finalStatus: TerminalResolutionStatus =
    terminal.status === "PARENT_MATCHED" ? "REMATCH_REQUIRED" : terminal.status;

  return {
    outcome: "FAILED",
    resolution: {
      ...terminal,
      status: finalStatus,
      diagnosticMeta: {
        ...(terminal.diagnosticMeta || {}),
        strategyId: lastStrategyId ?? terminal.diagnosticMeta?.strategyId,
        strategiesTried: opts.strategies.length,
        totalStrategies: opts.strategies.length,
        elapsedMs: elapsed(),
      },
      diagnostics: [
        ...(terminal.diagnostics || []),
        `All ${opts.strategies.length} saved DOM strategies failed to verify this post.`,
      ],
    },
    strategyId: lastStrategyId,
    anchorsVerified: false,
    elapsedMs: elapsed(),
  };
}
