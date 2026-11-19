import type { Flow } from "./contracts.js";

/**
 * Creator step-list numbering: Group children use `04.1` style; ungrouped Steps use
 * block ordinals (`05`). Flat `flow.steps` order is separate (`→ Step N`).
 */
export function flowUiStepNumbers(flow: Flow): Map<string, string> {
  const groups = flow.groups ?? [];
  const blocks: { groupId?: string; stepIds: string[] }[] = [];
  for (const ref of flow.steps) {
    const group = groups.find((g) => g.stepIds.includes(ref.id));
    if (group) {
      if (!blocks.some((b) => b.groupId === group.id))
        blocks.push({ groupId: group.id, stepIds: [...group.stepIds] });
    } else blocks.push({ stepIds: [ref.id] });
  }
  const map = new Map<string, string>();
  blocks.forEach((block, index) => {
    const blockNo = String(index + 1).padStart(2, "0");
    if (block.groupId) {
      block.stepIds.forEach((id, child) => map.set(id, `${blockNo}.${child + 1}`));
    } else if (block.stepIds[0]) {
      map.set(block.stepIds[0], blockNo);
    }
  });
  return map;
}
