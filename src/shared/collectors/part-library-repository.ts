/**
 * Collector-owned Part Library repository.
 * UI talks to this adapter only — never to raw storage keys.
 * Backing store is a key-value adapter today (localStorage); SQLite can replace the adapter later.
 */

import {
  PART_LIBRARY_DEFAULT_STORAGE_KEY,
  PART_LIBRARY_SCHEMA_VERSION,
  emptyNetworkPartConfig,
  emptyPostDetailPartConfig,
  emptyVisualFeedItemConfig,
  type CollectorPart,
  type CollectorPartConfig,
  type CollectorPartEditor,
  type CollectorPartStatus,
  type CollectorPartType,
  type CollectorScriptDef,
  type CollectorScriptPartRef,
  type PartLibraryEnvelope,
  type PartInputContract,
  type PartOutputContract,
  type VisualFeedAdoptionRecord,
  type VisualFeedItemPartConfig,
  type VisualPostDetailPartConfig,
} from "./part-library-types.js";
import {
  adoptExistingVisualFeedData,
  type VisualFeedAdoptionResult,
} from "./visual-feed-adoption.js";

export type KeyValueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
};

export class MemoryKeyValueStorage implements KeyValueStorage {
  private data = new Map<string, string>();
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function newId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function emptyPartLibraryEnvelope(): PartLibraryEnvelope {
  return {
    schemaVersion: PART_LIBRARY_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    parts: [],
    scripts: [],
  };
}

function parseInputContract(raw: unknown): PartInputContract {
  if (!isObject(raw)) return { schemaVersion: 1, required: [], optional: [] };
  return {
    schemaVersion: typeof raw.schemaVersion === "number" ? raw.schemaVersion : 1,
    required: Array.isArray(raw.required) ? raw.required.filter((x): x is string => typeof x === "string") : [],
    optional: Array.isArray(raw.optional) ? raw.optional.filter((x): x is string => typeof x === "string") : [],
  };
}

function parseOutputContract(raw: unknown): PartOutputContract {
  if (!isObject(raw)) return { schemaVersion: 1, payloadKind: "unspecified" };
  const kind = raw.payloadKind;
  const payloadKind =
    kind === "visual_observations" || kind === "network_records" || kind === "unspecified"
      ? kind
      : "unspecified";
  return {
    schemaVersion: typeof raw.schemaVersion === "number" ? raw.schemaVersion : 1,
    payloadKind,
  };
}

function parseConfig(raw: unknown, editor: CollectorPartEditor): CollectorPartConfig {
  if (!isObject(raw) || typeof raw.kind !== "string") {
    if (editor === "post-detail") return emptyPostDetailPartConfig();
    if (editor === "none") return emptyNetworkPartConfig();
    return emptyVisualFeedItemConfig();
  }
  if (raw.kind === "visual_feed_item") {
    const cfg: VisualFeedItemPartConfig = {
      kind: "visual_feed_item",
      templates: isObject(raw.templates) ? (raw.templates as VisualFeedItemPartConfig["templates"]) : {},
      step: raw.step === 2 || raw.step === 3 ? raw.step : 1,
      reports: Array.isArray(raw.reports) ? raw.reports : [],
      summaryStats: raw.summaryStats ?? null,
      currentRunId: typeof raw.currentRunId === "string" ? raw.currentRunId : null,
      selectedFrameIndex: typeof raw.selectedFrameIndex === "number" ? raw.selectedFrameIndex : 0,
      selectedCandidateIndex:
        typeof raw.selectedCandidateIndex === "number" ? raw.selectedCandidateIndex : 0,
    };
    return cfg;
  }
  if (raw.kind === "visual_post_detail") {
    const cfg: VisualPostDetailPartConfig = {
      kind: "visual_post_detail",
      snapshot: isObject(raw.snapshot) ? raw.snapshot : {},
    };
    return cfg;
  }
  if (raw.kind === "network_draft") {
    return {
      kind: "network_draft",
      readiness: "not_implemented",
      note:
        typeof raw.note === "string"
          ? raw.note
          : emptyNetworkPartConfig().note,
    };
  }
  return emptyVisualFeedItemConfig();
}

function parsePart(raw: unknown, warnings: string[]): CollectorPart | null {
  if (!isObject(raw) || typeof raw.partId !== "string" || typeof raw.name !== "string") {
    warnings.push("Skipped part with missing partId/name");
    return null;
  }
  const partType: CollectorPartType = raw.partType === "network" ? "network" : "visual";
  const editor: CollectorPartEditor =
    raw.editor === "post-detail" || raw.editor === "none" || raw.editor === "feed-item-visual"
      ? raw.editor
      : partType === "network"
        ? "none"
        : "feed-item-visual";
  const status: CollectorPartStatus = raw.status === "ready" ? "ready" : "draft";
  return {
    partId: raw.partId,
    name: raw.name,
    partType,
    version: typeof raw.version === "number" && raw.version > 0 ? raw.version : 1,
    status,
    editor,
    inputContract: parseInputContract(raw.inputContract),
    outputContract: parseOutputContract(raw.outputContract),
    config: parseConfig(raw.config, editor),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
  };
}

function parseScript(raw: unknown, warnings: string[]): CollectorScriptDef | null {
  if (!isObject(raw) || typeof raw.scriptId !== "string" || typeof raw.name !== "string") {
    warnings.push("Skipped collector script with missing scriptId/name");
    return null;
  }
  const partRefs: CollectorScriptPartRef[] = Array.isArray(raw.partRefs)
    ? raw.partRefs
        .filter((r): r is Record<string, unknown> => isObject(r) && typeof r.partId === "string")
        .map((r) => ({
          partId: r.partId as string,
          partVersion: typeof r.partVersion === "number" ? r.partVersion : 1,
        }))
    : [];
  return {
    scriptId: raw.scriptId,
    name: raw.name,
    version: typeof raw.version === "number" && raw.version > 0 ? raw.version : 1,
    status: "draft",
    partRefs,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
  };
}

export function parsePartLibraryEnvelope(raw: string | null): PartLibraryEnvelope {
  if (!raw) return emptyPartLibraryEnvelope();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const envelope = emptyPartLibraryEnvelope();
    envelope.parseWarnings = ["JSON parse failed; original payload retained in rawBackup"];
    envelope.rawBackup = raw;
    return envelope;
  }
  if (!isObject(parsed)) {
    const envelope = emptyPartLibraryEnvelope();
    envelope.parseWarnings = ["Root value was not an object; original payload retained"];
    envelope.rawBackup = raw;
    return envelope;
  }
  const warnings: string[] = [];
  const parts = Array.isArray(parsed.parts)
    ? parsed.parts.map((p) => parsePart(p, warnings)).filter((p): p is CollectorPart => Boolean(p))
    : [];
  const scripts = Array.isArray(parsed.scripts)
    ? parsed.scripts
        .map((s) => parseScript(s, warnings))
        .filter((s): s is CollectorScriptDef => Boolean(s))
    : [];
  if (!Array.isArray(parsed.parts)) warnings.push("parts missing or invalid — recovered as []");
  if (!Array.isArray(parsed.scripts)) warnings.push("scripts missing or invalid — recovered as []");

  let visualFeedAdoption: VisualFeedAdoptionRecord | undefined;
  if (isObject(parsed.visualFeedAdoption) && typeof parsed.visualFeedAdoption.adoptedPartId === "string") {
    visualFeedAdoption = {
      schemaVersion: 1,
      adoptedPartId: parsed.visualFeedAdoption.adoptedPartId,
      contentFingerprint:
        typeof parsed.visualFeedAdoption.contentFingerprint === "string"
          ? parsed.visualFeedAdoption.contentFingerprint
          : "",
      adoptedAt:
        typeof parsed.visualFeedAdoption.adoptedAt === "string"
          ? parsed.visualFeedAdoption.adoptedAt
          : new Date().toISOString(),
    };
  }

  return {
    schemaVersion: PART_LIBRARY_SCHEMA_VERSION,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    parts,
    scripts,
    visualFeedAdoption,
    parseWarnings: warnings.length ? warnings : undefined,
    rawBackup: warnings.length ? raw : undefined,
  };
}

export function serializePartLibraryEnvelope(envelope: PartLibraryEnvelope): string {
  const next: PartLibraryEnvelope = {
    ...envelope,
    schemaVersion: PART_LIBRARY_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  };
  return JSON.stringify(next);
}

export class PartLibraryRepository {
  constructor(
    private readonly storage: KeyValueStorage,
    private readonly storageKey: string = PART_LIBRARY_DEFAULT_STORAGE_KEY,
  ) {}

  load(): PartLibraryEnvelope {
    return parsePartLibraryEnvelope(this.storage.getItem(this.storageKey));
  }

  save(envelope: PartLibraryEnvelope): void {
    this.storage.setItem(this.storageKey, serializePartLibraryEnvelope(envelope));
  }

  listParts(): CollectorPart[] {
    return this.load().parts.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getPart(partId: string): CollectorPart | undefined {
    return this.load().parts.find((p) => p.partId === partId);
  }

  upsertPart(part: CollectorPart): CollectorPart {
    const envelope = this.load();
    const next: CollectorPart = { ...part, updatedAt: new Date().toISOString() };
    const others = envelope.parts.filter((p) => p.partId !== part.partId);
    this.save({ ...envelope, parts: [...others, next] });
    return next;
  }

  updatePartConfig(partId: string, config: CollectorPartConfig): CollectorPart | undefined {
    const existing = this.getPart(partId);
    if (!existing) return undefined;
    return this.upsertPart({ ...existing, config });
  }

  listScripts(): CollectorScriptDef[] {
    return this.load().scripts.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getScript(scriptId: string): CollectorScriptDef | undefined {
    return this.load().scripts.find((s) => s.scriptId === scriptId);
  }

  upsertScript(script: CollectorScriptDef): CollectorScriptDef {
    const envelope = this.load();
    const next: CollectorScriptDef = { ...script, updatedAt: new Date().toISOString() };
    const others = envelope.scripts.filter((s) => s.scriptId !== script.scriptId);
    this.save({ ...envelope, scripts: [...others, next] });
    return next;
  }

  createVisualFeedItemPart(name: string): CollectorPart {
    const now = new Date().toISOString();
    return this.upsertPart({
      partId: newId("part"),
      name: name.trim(),
      partType: "visual",
      version: 1,
      status: "draft",
      editor: "feed-item-visual",
      inputContract: {
        schemaVersion: 1,
        required: ["browserSession"],
        optional: ["sourceUrl"],
      },
      outputContract: {
        schemaVersion: 1,
        payloadKind: "visual_observations",
      },
      config: emptyVisualFeedItemConfig(),
      createdAt: now,
      updatedAt: now,
    });
  }

  createVisualPostDetailPart(name: string): CollectorPart {
    const now = new Date().toISOString();
    return this.upsertPart({
      partId: newId("part"),
      name: name.trim(),
      partType: "visual",
      version: 1,
      status: "draft",
      editor: "post-detail",
      inputContract: {
        schemaVersion: 1,
        required: ["browserSession"],
        optional: ["sourceUrl"],
      },
      outputContract: {
        schemaVersion: 1,
        payloadKind: "visual_observations",
      },
      config: emptyPostDetailPartConfig(),
      createdAt: now,
      updatedAt: now,
    });
  }

  createNetworkDraftPart(name: string): CollectorPart {
    const now = new Date().toISOString();
    return this.upsertPart({
      partId: newId("part"),
      name: name.trim(),
      partType: "network",
      version: 1,
      status: "draft",
      editor: "none",
      inputContract: {
        schemaVersion: 1,
        required: ["browserSession"],
        optional: ["sourceUrl"],
      },
      outputContract: {
        schemaVersion: 1,
        payloadKind: "network_records",
      },
      config: emptyNetworkPartConfig(),
      createdAt: now,
      updatedAt: now,
    });
  }

  createCollectorScript(name: string, partRefs: CollectorScriptPartRef[]): CollectorScriptDef {
    const now = new Date().toISOString();
    return this.upsertScript({
      scriptId: newId("cscript"),
      name: name.trim(),
      version: 1,
      status: "draft",
      partRefs,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * One-time adopt existing Feed Visual Counter legacy data into Part Library.
   * `legacyStorage` defaults to the same adapter (browser localStorage holds both keys).
   */
  adoptExistingVisualFeed(legacyStorage: KeyValueStorage = this.storage): VisualFeedAdoptionResult {
    return adoptExistingVisualFeedData({
      loadEnvelope: () => this.load(),
      saveEnvelope: (envelope) => this.save(envelope),
      legacyStorage,
    });
  }

  getAdoptedVisualFeedPartId(): string | undefined {
    return this.load().visualFeedAdoption?.adoptedPartId;
  }
}

/** Browser factory — sole place that binds the default key-value backend. */
export function createBrowserPartLibraryRepository(
  storage: KeyValueStorage = typeof localStorage !== "undefined"
    ? localStorage
    : new MemoryKeyValueStorage(),
  storageKey: string = PART_LIBRARY_DEFAULT_STORAGE_KEY,
): PartLibraryRepository {
  return new PartLibraryRepository(storage, storageKey);
}
