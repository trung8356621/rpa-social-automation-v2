import type { ActionTag, Flow } from "./contracts.js";

export type ActionTagReassignInput = {
  flowId: string;
  destinationTagKey: string;
  destinationTagId?: number;
};

export type ActionTagReassignConflict =
  | { code: "FLOW_NOT_FOUND"; message: string }
  | { code: "TAG_NOT_FOUND"; message: string }
  | { code: "SAME_TAG"; message: string }
  | { code: "DESTINATION_ACTIVE_CONFLICT"; message: string; conflictingFlowId: string; conflictingFlowName: string }
  | { code: "DESTINATION_HAS_SCRIPTS"; message: string; otherFlowIds: string[] };

export type ActionTagReassignPlan = {
  ok: true;
  flowId: string;
  previousTagKey?: string;
  previousTagId?: number;
  nextTagKey: string;
  nextTagId?: number;
  warnings: string[];
  /** Local Script stays the same id; remote reassignment happens on next Sync publish. */
  requiresSync: true;
} | {
  ok: false;
  conflict: ActionTagReassignConflict;
};

/**
 * Pure planner for local Action Tag reassignment.
 * Does not rename the Script and does not call SEO-OPS.
 */
export function planActionTagReassignment(input: {
  flow: Flow | undefined;
  tags: ActionTag[];
  flows: Flow[];
  activeScriptsByTag: Record<string, string>;
  destinationTagKey: string;
  destinationTagId?: number;
  allowDestinationSiblings?: boolean;
}): ActionTagReassignPlan {
  const flow = input.flow;
  if (!flow) {
    return {
      ok: false,
      conflict: { code: "FLOW_NOT_FOUND", message: "Không tìm thấy Script để đổi Action Tag." },
    };
  }
  const tagKey = input.destinationTagKey.trim();
  if (!tagKey) {
    return {
      ok: false,
      conflict: { code: "TAG_NOT_FOUND", message: "Chưa chọn Action Tag đích." },
    };
  }
  const tag =
    input.tags.find((t) => t.tag_key === tagKey) ||
    (typeof input.destinationTagId === "number"
      ? input.tags.find((t) => t.id === input.destinationTagId)
      : undefined);
  if (!tag) {
    return {
      ok: false,
      conflict: {
        code: "TAG_NOT_FOUND",
        message: `Action Tag đích không tồn tại trong danh sách local: ${tagKey}`,
      },
    };
  }
  if (flow.actionTagKey === tag.tag_key) {
    return {
      ok: false,
      conflict: {
        code: "SAME_TAG",
        message: `Script đã gắn Action Tag ${tag.tag_key}.`,
      },
    };
  }

  const warnings: string[] = [];
  const activeDest = input.activeScriptsByTag[tag.tag_key];
  if (activeDest && activeDest !== flow.id) {
    const other = input.flows.find((f) => f.id === activeDest);
    return {
      ok: false,
      conflict: {
        code: "DESTINATION_ACTIVE_CONFLICT",
        message:
          `Action Tag ${tag.tag_key} đang Active bởi Script khác` +
          (other ? ` (“${other.name}”). Hủy Active hoặc chọn tag khác.` : "."),
        conflictingFlowId: activeDest,
        conflictingFlowName: other?.name || activeDest,
      },
    };
  }

  const siblings = input.flows.filter(
    (f) => f.id !== flow.id && !f.disabled && f.actionTagKey === tag.tag_key,
  );
  if (siblings.length && !input.allowDestinationSiblings) {
    return {
      ok: false,
      conflict: {
        code: "DESTINATION_HAS_SCRIPTS",
        message:
          `Action Tag ${tag.tag_key} đã có ${siblings.length} Script khác. ` +
          `Xác nhận nếu vẫn muốn gắn thêm (không ghi đè Script hiện có).`,
        otherFlowIds: siblings.map((s) => s.id),
      },
    };
  }
  if (siblings.length) {
    warnings.push(
      `Tag đích đã có ${siblings.length} Script khác — giữ nguyên các Script đó, chỉ đổi tag của Script này.`,
    );
  }
  if (flow.actionTagKey) {
    warnings.push(
      `Tag cũ ${flow.actionTagKey} được gỡ khỏi Script này; cần Sync lại để SEO-OPS nhận action_tag_key mới.`,
    );
  }

  return {
    ok: true,
    flowId: flow.id,
    previousTagKey: flow.actionTagKey,
    previousTagId: flow.actionTagId,
    nextTagKey: tag.tag_key,
    nextTagId: tag.id,
    warnings,
    requiresSync: true,
  };
}
