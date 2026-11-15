import type { PostDetailAnchorType, VisualReferenceSample } from "./types.js";

export const VISUAL_REFERENCE_ROLES: PostDetailAnchorType[] = ["LIKE", "COMMENT", "SHARE"];

export function structuredReferenceRole(sample: VisualReferenceSample): PostDetailAnchorType | null {
  return VISUAL_REFERENCE_ROLES.includes(sample.semanticRole as PostDetailAnchorType)
    ? sample.semanticRole as PostDetailAnchorType
    : null;
}

export function auditVisualReferenceRoles(samples: VisualReferenceSample[]) {
  const grouped = new Map<PostDetailAnchorType, VisualReferenceSample[]>();
  for (const role of VISUAL_REFERENCE_ROLES) grouped.set(role, []);
  const legacy: VisualReferenceSample[] = [];
  for (const sample of samples) {
    const role = structuredReferenceRole(sample);
    if (!role) legacy.push(sample);
    else grouped.get(role)!.push(sample);
  }
  return {
    legacy,
    duplicates: VISUAL_REFERENCE_ROLES.filter(role => grouped.get(role)!.length > 1),
    missing: VISUAL_REFERENCE_ROLES.filter(role => grouped.get(role)!.length === 0),
    grouped,
    valid: legacy.length === 0 && VISUAL_REFERENCE_ROLES.every(role => grouped.get(role)!.length === 1),
  };
}
