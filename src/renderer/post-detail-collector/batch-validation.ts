import type { PostDetailSavedParentResolution } from "../../shared/post-detail-collector/types";
import { executeVariableMapping, extractParentData } from "./extract-parent-data";
import type {
  BatchFieldResult,
  BatchValidationRow,
  PostDetailDomVariableMapping,
} from "./types";
import type { RegistryVariableOption } from "./variable-registry";

export type ParsedBatchUrl = {
  url: string;
  valid: boolean;
  platform: "facebook" | "threads" | null;
  postId: string | null;
  error?: string;
};

export function extractPostIdentityFromUrl(rawUrl: string): {
  valid: boolean;
  normalizedUrl: string;
  platform: "facebook" | "threads" | null;
  postId: string | null;
  error?: string;
} {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { valid: false, normalizedUrl: "", platform: null, postId: null, error: "Empty URL" };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, normalizedUrl: trimmed, platform: null, postId: null, error: "Invalid URL syntax" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { valid: false, normalizedUrl: trimmed, platform: null, postId: null, error: "Unsupported protocol" };
  }

  const host = parsed.hostname.toLowerCase();
  const isThreads = /(?:^|\.)threads\.(?:com|net)$/.test(host);
  const isFacebook = /(?:^|\.)(?:facebook|fb)\.com$/.test(host);
  if (!isFacebook && !isThreads) {
    return {
      valid: false,
      normalizedUrl: parsed.href,
      platform: null,
      postId: null,
      error: "URL must be a Facebook or Threads post URL",
    };
  }

  const path = parsed.pathname;
  if (isThreads) {
    const m = /^\/@[^/]+\/post\/([^/?#]+)/i.exec(path);
    if (m) {
      return { valid: true, normalizedUrl: parsed.href, platform: "threads", postId: m[1] };
    }
    return { valid: false, normalizedUrl: parsed.href, platform: "threads", postId: null, error: "Unsupported Threads post URL format" };
  }

  const pathMatch = /(?:\/posts\/|\/permalink\/)([0-9A-Za-z_-]+)/i.exec(path);
  if (pathMatch) {
    return { valid: true, normalizedUrl: parsed.href, platform: "facebook", postId: pathMatch[1] };
  }
  for (const param of ["multi_permalinks", "story_fbid"]) {
    const val = parsed.searchParams.get(param);
    if (val) {
      return { valid: true, normalizedUrl: parsed.href, platform: "facebook", postId: val };
    }
  }
  const setParam = parsed.searchParams.get("set");
  const setMatch = setParam && /^(?:gm|pcb)\.([0-9A-Za-z_-]+)/i.exec(setParam);
  if (setMatch) {
    return { valid: true, normalizedUrl: parsed.href, platform: "facebook", postId: setMatch[1] };
  }

  return {
    valid: false,
    normalizedUrl: parsed.href,
    platform: "facebook",
    postId: null,
    error: "Unsupported Facebook post URL (expected /posts/, /permalink/, story_fbid, or multi_permalinks)",
  };
}

export function parseBatchUrls(rawText: string): {
  items: ParsedBatchUrl[];
  duplicateCount: number;
} {
  const seen = new Set<string>();
  const items: ParsedBatchUrl[] = [];
  let duplicateCount = 0;

  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const identity = extractPostIdentityFromUrl(line);
    const dedupeKey = identity.normalizedUrl || line;
    if (seen.has(dedupeKey)) {
      duplicateCount++;
      continue;
    }
    seen.add(dedupeKey);
    items.push({
      url: identity.normalizedUrl || line,
      valid: identity.valid,
      platform: identity.platform,
      postId: identity.postId,
      error: identity.error,
    });
  }

  return { items, duplicateCount };
}

export function evaluateMatchedParentDom(opts: {
  url: string;
  resolvedUrl: string;
  postId: string | null;
  resolution: PostDetailSavedParentResolution;
  rootElement: Element | null;
  mappings: PostDetailDomVariableMapping[];
  registryVariables: RegistryVariableOption[];
}): BatchValidationRow {
  const now = new Date().toISOString();
  const { url, resolvedUrl, postId, resolution, rootElement, mappings, registryVariables } = opts;

  if (resolution.status !== "PARENT_MATCHED" || !rootElement) {
    return {
      url,
      resolvedUrl,
      postId,
      parentStatus: "Failed",
      passedCount: 0,
      totalCount: mappings.length,
      status: "FAILED",
      failureReason:
        resolution.failureCode ||
        resolution.diagnostics?.[0] ||
        (resolution.status === "PARENT_MATCHED" ? "Empty Parent DOM" : resolution.status),
      parentDiagnostics: resolution.diagnostics ?? [],
      fields: [],
      validatedAt: now,
    };
  }

  const semanticItems = extractParentData(rootElement, {
    postId: postId || undefined,
    currentUrl: resolvedUrl || url,
  });

  const varMetaById = new Map(
    registryVariables.map((v) => [`${v.collectorId}:${v.id}`, v]),
  );

  const fields: BatchFieldResult[] = [];
  const mappedVarKeys = new Set<string>();

  for (const mapping of mappings) {
    const varKey = `${mapping.collectorId}:${mapping.variableId}`;
    mappedVarKeys.add(varKey);
    const varMeta = varMetaById.get(varKey);
    const executed = executeVariableMapping(rootElement, mapping, {
      postId: postId || undefined,
      currentUrl: resolvedUrl || url,
    });

    const semanticMatch = mapping.sourceSemantic
      ? semanticItems.find((item) => item.semanticField === mapping.sourceSemantic)
      : undefined;
    const semanticAmbiguous = semanticMatch?.extractionStatus === "needs_attention";

    const passed =
      executed.status === "mapped" &&
      executed.value.trim().length > 0 &&
      !semanticAmbiguous;

    fields.push({
      variableId: mapping.variableId,
      variableKey: varMeta?.key ?? mapping.variableKey,
      variableLabel: varMeta?.label ?? mapping.variableLabel,
      required: Boolean(varMeta?.required),
      value: executed.value,
      method: mapping.method,
      attribute: mapping.attribute,
      relativeXPath: mapping.relativeXPath,
      status: passed ? "PASS" : "REVIEW",
      reason: passed
        ? undefined
        : semanticAmbiguous
          ? `Semantic extraction flagged Needs Attention (${semanticMatch?.label || mapping.sourceSemantic})`
          : executed.reason || "Empty or missing value",
    });
  }

  const activeCollectorIds = new Set(mappings.map((m) => m.collectorId));
  for (const variable of registryVariables) {
    if (!variable.required) continue;
    if (activeCollectorIds.size > 0 && !activeCollectorIds.has(variable.collectorId)) continue;
    const varKey = `${variable.collectorId}:${variable.id}`;
    if (!mappedVarKeys.has(varKey)) {
      fields.push({
        variableId: variable.id,
        variableKey: variable.key,
        variableLabel: variable.label,
        required: true,
        value: "",
        method: "UNMAPPED",
        relativeXPath: "",
        status: "REVIEW",
        reason: "Required variable is unmapped",
      });
    }
  }

  const passedCount = fields.filter((f) => f.status === "PASS").length;
  const totalCount = fields.length;
  const allPass = totalCount > 0 && passedCount === totalCount;

  return {
    url,
    resolvedUrl,
    postId,
    parentStatus: "Matched",
    passedCount,
    totalCount,
    status: allPass ? "PASS" : "REVIEW",
    failureReason: totalCount === 0 ? "No confirmed variable mappings configured" : undefined,
    parentDiagnostics: resolution.diagnostics,
    fields,
    validatedAt: now,
  };
}
