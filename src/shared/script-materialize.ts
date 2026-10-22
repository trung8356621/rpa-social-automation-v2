import type { Flow, Payload, Step, StepGroup, Variable } from "./contracts.js";
import { normalizeImportedVisualTarget } from "./script-release.js";
import {
  canonicalizePayload,
  stableStringify,
} from "./script-execution-canon.js";

export type MaterializeOk = {
  ok: true;
  flow: Flow;
  steps: Step[];
  /** Versions that already match local and must not be rewritten. */
  skippedVersions: Array<{ id: string; version: number }>;
  /** Versions to insert (not present locally). */
  inserts: Step[];
};

export type MaterializeErr = {
  ok: false;
  reason: string;
};

export type MaterializeResult = MaterializeOk | MaterializeErr;

const ACTIONS: Payload["action"][] = [
  "CLICK_TARGET",
  "CLICK_AND_TYPE",
  "UPLOAD_FILE",
  "QUICK_TAG",
  "TYPE_ONLY",
  "WAIT_VERIFY",
  "SCROLL",
  "SLEEP",
];

/**
 * Pure materialize: rebuild Flow + pinned Steps from a Script release.
 * Never invents Variable ids when the package carries them.
 * Refuses partial packages and refuses to overwrite a divergent local version.
 */
export function materializeScriptRelease(input: {
  release: Record<string, unknown>;
  existing?: Flow | null;
  existingSteps?: Step[];
  /** Optional payload validator (e.g. Store.validatePayload). */
  validatePayload?: (payload: Payload) => void;
}): MaterializeResult {
  const release = input.release;
  const manifest = (release.manifest ?? {}) as Record<string, unknown>;
  const scriptId = String(manifest.script_id ?? release.package_key ?? "");
  if (!scriptId) return { ok: false, reason: "missing_script_id" };

  const stepRows = Array.isArray(manifest.steps) ? manifest.steps : [];
  if (!stepRows.length) return { ok: false, reason: "steps_required" };

  const variables = mapVariables(
    Array.isArray(manifest.variables) ? manifest.variables : [],
    input.existing ?? null,
  );
  if (!variables.ok) return variables;
  const varById = new Map(variables.variables.map((v) => [v.id, v]));
  const varByKey = new Map(variables.variables.map((v) => [v.key, v]));

  const prepared: Step[] = [];
  for (const raw of stepRows) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, reason: "invalid_payload" };
    }
    const s = raw as Record<string, unknown>;
    const built = buildStepPayload(s, varById, varByKey);
    if (!built.ok) return built;
    if (input.validatePayload) {
      try {
        input.validatePayload(built.payload);
      } catch {
        return { ok: false, reason: "invalid_payload" };
      }
    }
    const stepId = String(s.id ?? "");
    const version = Number(s.version ?? 1);
    if (!stepId || !Number.isInteger(version) || version < 1) {
      return { ok: false, reason: "invalid_version" };
    }
    prepared.push({
      id: stepId,
      version,
      name: String(s.name ?? built.payload.action),
      payload: built.payload,
      createdAt: new Date().toISOString(),
    });
  }

  const existingByRef = new Map<string, Step>(
    (input.existingSteps ?? []).map((s) => [`${s.id}@${s.version}`, s]),
  );
  const skippedVersions: MaterializeOk["skippedVersions"] = [];
  const inserts: Step[] = [];
  for (const step of prepared) {
    const key = `${step.id}@${step.version}`;
    const local = existingByRef.get(key);
    if (!local) {
      inserts.push(step);
      continue;
    }
    const localCanon = stableStringify({
      id: local.id,
      version: local.version,
      name: local.name,
      payload: canonicalizePayload(local.payload),
    });
    const remoteCanon = stableStringify({
      id: step.id,
      version: step.version,
      name: step.name,
      payload: canonicalizePayload(step.payload),
    });
    if (localCanon !== remoteCanon) {
      return { ok: false, reason: "version_conflict" };
    }
    skippedVersions.push({ id: step.id, version: step.version });
  }

  const defaultPattern = mapDefaultPattern(manifest, variables.variables);
  const groups = mapGroups(manifest);
  const zoom = Number(manifest.zoom ?? input.existing?.zoom ?? 1);
  const flow: Flow = {
    id: scriptId,
    name: String(release.name ?? input.existing?.name ?? scriptId),
    zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1,
    steps: prepared.map((s) => ({ id: s.id, version: s.version })),
    variables: variables.variables,
    defaultPattern,
    groups,
  };

  return { ok: true, flow, steps: prepared, skippedVersions, inserts };
}

function mapVariables(
  rows: unknown[],
  existing: Flow | null,
): { ok: true; variables: Variable[] } | MaterializeErr {
  const existingByKey = new Map((existing?.variables ?? []).map((v) => [v.key, v]));
  const existingById = new Map((existing?.variables ?? []).map((v) => [v.id, v]));
  const out: Variable[] = [];
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object") return { ok: false, reason: "invalid_payload" };
    const r = row as Record<string, unknown>;
    const key = String(r.key ?? "").trim();
    if (!key) return { ok: false, reason: "invalid_payload" };
    const type = String(r.type ?? "text") as Variable["type"];
    if (!["text", "file", "files", "integer", "number"].includes(type)) {
      return { ok: false, reason: "invalid_payload" };
    }
    const packagedId = typeof r.id === "string" && r.id.trim() ? r.id.trim() : "";
    const priorByKey = existingByKey.get(key);
    const id = packagedId || priorByKey?.id || existingById.get(packagedId)?.id;
    if (!id) {
      // No packaged id and no local prior — reject rather than invent orphans.
      return { ok: false, reason: "missing_variable_id" };
    }
    if (seenIds.has(id) || seenKeys.has(key)) {
      return { ok: false, reason: "invalid_payload" };
    }
    seenIds.add(id);
    seenKeys.add(key);
    out.push({
      id,
      key,
      type,
      ...(r.description || priorByKey?.description
        ? { description: String(r.description ?? priorByKey?.description) }
        : {}),
    });
  }
  return { ok: true, variables: out };
}

function mapDefaultPattern(
  manifest: Record<string, unknown>,
  variables: Variable[],
): { values: Record<string, string | string[] | number> } {
  const raw =
    (manifest.default_pattern && typeof manifest.default_pattern === "object"
      ? (manifest.default_pattern as { values?: Record<string, unknown> }).values
      : undefined) ??
    (manifest.defaultPattern && typeof manifest.defaultPattern === "object"
      ? (manifest.defaultPattern as { values?: Record<string, unknown> }).values
      : undefined) ??
    {};
  const ids = new Set(variables.map((v) => v.id));
  const values: Record<string, string | string[] | number> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!ids.has(id)) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      (Array.isArray(value) && value.every((x) => typeof x === "string"))
    ) {
      values[id] = value as string | string[] | number;
    }
  }
  return { values };
}

function mapGroups(manifest: Record<string, unknown>): StepGroup[] {
  if (!Array.isArray(manifest.groups)) return [];
  const out: StepGroup[] = [];
  for (const raw of manifest.groups) {
    if (!raw || typeof raw !== "object") continue;
    const g = raw as Record<string, unknown>;
    const id = String(g.id ?? "");
    const name = String(g.name ?? "");
    const slug = String(g.slug ?? "");
    if (!id || !name || !slug) continue;
    out.push({
      id,
      name,
      slug,
      collapsed: Boolean(g.collapsed),
      stepIds: Array.isArray(g.stepIds)
        ? g.stepIds.filter((x): x is string => typeof x === "string")
        : [],
      ...(typeof g.emptyPosition === "number"
        ? { emptyPosition: g.emptyPosition }
        : {}),
    });
  }
  return out;
}

function buildStepPayload(
  s: Record<string, unknown>,
  varById: Map<string, Variable>,
  varByKey: Map<string, Variable>,
): { ok: true; payload: Payload } | MaterializeErr {
  const actionRaw = String(s.action ?? "SLEEP");
  const action = (ACTIONS.includes(actionRaw as Payload["action"])
    ? actionRaw
    : null) as Payload["action"] | null;
  if (!action) return { ok: false, reason: "invalid_payload" };

  let variableId: string | undefined;
  if (typeof s.variableId === "string" && s.variableId) {
    if (!varById.has(s.variableId)) return { ok: false, reason: "orphan_variable" };
    variableId = s.variableId;
  } else if (typeof s.variable_key === "string" && s.variable_key) {
    const v = varByKey.get(s.variable_key);
    if (!v) return { ok: false, reason: "orphan_variable" };
    variableId = v.id;
  }

  const targetRaw =
    s.target && typeof s.target === "object"
      ? (s.target as Record<string, unknown>)
      : undefined;

  let payload: Payload;
  if (targetRaw) {
    const normalized = normalizeImportedVisualTarget(targetRaw);
    if (!normalized.ok) return { ok: false, reason: normalized.code };
    payload = {
      action,
      ...(variableId ? { variableId } : {}),
      ...(typeof s.method === "string" ? { method: s.method as Payload["method"] } : {}),
      ...(typeof s.threshold === "number" ? { threshold: s.threshold } : {}),
      ...(typeof s.timeoutMs === "number" ? { timeoutMs: s.timeoutMs } : {}),
      ...(typeof s.inputMethod === "string"
        ? { inputMethod: s.inputMethod as Payload["inputMethod"] }
        : {}),
      ...(typeof s.deltaY === "number" ? { deltaY: s.deltaY } : {}),
      ...(typeof s.quickTagRows === "number" ? { quickTagRows: s.quickTagRows } : {}),
      ...(typeof s.text === "string" ? { text: s.text } : {}),
      ...(Array.isArray(s.files) ? { files: s.files as string[] } : {}),
      target: normalized.target,
    };
  } else {
    payload = {
      action,
      ...(variableId ? { variableId } : {}),
      ...(typeof s.timeoutMs === "number" ? { timeoutMs: s.timeoutMs } : {}),
      ...(typeof s.deltaY === "number" ? { deltaY: s.deltaY } : {}),
      ...(typeof s.text === "string" ? { text: s.text } : {}),
      ...(Array.isArray(s.files) ? { files: s.files as string[] } : {}),
    };
  }
  return { ok: true, payload };
}
