/**
 * Resolve which Visual (Feed Item) Part a Collector Script Workspace should use.
 * Display order of script.partRefs is never treated as execution order.
 */

import type {
  CollectorPart,
  CollectorScriptPartRef,
  VisualFeedItemPartConfig,
  VisualIconTemplatesBlob,
} from "./part-library-types.js";

export type VisualPartOption = {
  partId: string;
  partVersion: number;
  name: string;
  status: CollectorPart["status"];
  templates: VisualIconTemplatesBlob;
  templateKindsReady: number;
  templatesComplete: boolean;
};

export type VisualPartBinding =
  | { kind: "none"; reason: string; options: [] }
  | {
      kind: "incomplete";
      reason: string;
      options: VisualPartOption[];
      selected?: VisualPartOption;
    }
  | { kind: "single"; reason?: undefined; options: [VisualPartOption]; selected: VisualPartOption }
  | { kind: "multiple"; reason: string; options: VisualPartOption[]; selected?: VisualPartOption };

const TEMPLATE_KINDS = ["like", "comment", "share"] as const;

export function countVisualTemplateKinds(templates: VisualIconTemplatesBlob | undefined): number {
  if (!templates) return 0;
  let n = 0;
  for (const kind of TEMPLATE_KINDS) {
    const t = templates[kind];
    if (t?.dataUrl && t.width > 0 && t.height > 0) n += 1;
  }
  return n;
}

export function isVisualTemplatesComplete(templates: VisualIconTemplatesBlob | undefined): boolean {
  return countVisualTemplateKinds(templates) === TEMPLATE_KINDS.length;
}

function toOption(part: CollectorPart, partVersion: number): VisualPartOption | null {
  if (part.partType !== "visual" || part.editor !== "feed-item-visual") return null;
  if (part.config.kind !== "visual_feed_item") return null;
  const config = part.config as VisualFeedItemPartConfig;
  const templates = config.templates ?? {};
  const templateKindsReady = countVisualTemplateKinds(templates);
  return {
    partId: part.partId,
    partVersion,
    name: part.name,
    status: part.status,
    templates,
    templateKindsReady,
    templatesComplete: templateKindsReady === TEMPLATE_KINDS.length,
  };
}

/** Collect Visual Feed Item Part refs from a script composition (resolved against Part Library). */
export function listVisualPartOptions(
  partRefs: CollectorScriptPartRef[],
  parts: ReadonlyArray<CollectorPart>,
): VisualPartOption[] {
  const byId = new Map(parts.map((p) => [p.partId, p]));
  const out: VisualPartOption[] = [];
  const seen = new Set<string>();
  for (const ref of partRefs) {
    const part = byId.get(ref.partId);
    if (!part) continue;
    const option = toOption(part, ref.partVersion);
    if (!option) continue;
    const key = `${ref.partId}@${ref.partVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(option);
  }
  return out;
}

export function resolveVisualPartBinding(
  partRefs: CollectorScriptPartRef[],
  parts: ReadonlyArray<CollectorPart>,
  selectedKey?: string | null,
): VisualPartBinding {
  const options = listVisualPartOptions(partRefs, parts);
  if (options.length === 0) {
    return {
      kind: "none",
      reason:
        "This Collector Script has no Visual Feed Item Part reference. Add a Visual Part before observing the feed.",
      options: [],
    };
  }

  const selected =
    options.length === 1
      ? options[0]
      : selectedKey
        ? options.find((o) => visualPartOptionKey(o) === selectedKey)
        : undefined;

  if (options.length > 1 && !selected) {
    return {
      kind: "multiple",
      reason:
        "Multiple Visual Parts are referenced. Select which Visual Part configuration to use for this capture session.",
      options,
    };
  }

  const active = selected ?? options[0]!;
  if (!active.templatesComplete) {
    return {
      kind: "incomplete",
      reason: `Visual Part "${active.name}" is missing Like/Comment/Share templates (${active.templateKindsReady}/3). Open Feed Visual Counter to calibrate — do not use legacy global templates.`,
      options: options.length === 1 ? options : options,
      selected: active,
    };
  }

  if (options.length === 1) {
    return { kind: "single", options: [active], selected: active };
  }

  return {
    kind: "multiple",
    reason: "",
    options,
    selected: active,
  };
}

export function visualPartOptionKey(option: Pick<VisualPartOption, "partId" | "partVersion">): string {
  return `${option.partId}@${option.partVersion}`;
}

export function activeVisualPartFromBinding(binding: VisualPartBinding): VisualPartOption | undefined {
  if (binding.kind === "single") return binding.selected;
  if (binding.kind === "multiple" || binding.kind === "incomplete") return binding.selected;
  return undefined;
}
