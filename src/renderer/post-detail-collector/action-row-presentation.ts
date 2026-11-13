import type { Rect } from "../../shared/contracts";
import type {
  PostDetailMainActionRow,
  PostDetailVisualAnchor,
} from "../../shared/post-detail-collector/types";

export type ActionRowDisplayStatus =
  "CANDIDATE_FOUND" | "CONFIRMED" | "AMBIGUOUS" | "NOT_FOUND";

export function actionRowDisplayStatus(
  row: PostDetailMainActionRow | null | undefined,
): ActionRowDisplayStatus {
  if (!row) return "NOT_FOUND";
  if (row.status === "CONFIRMED") return "CONFIRMED";
  if (row.status === "MAIN_ACTION_ROW_CANDIDATE") return "CANDIDATE_FOUND";
  return row.status;
}

/** Never project a retained row onto a different screenshot frame. */
export function actionRowOverlayForFrame(
  row: PostDetailMainActionRow | null | undefined,
  frameId: string | undefined,
): { bbox: Rect; anchors: PostDetailVisualAnchor[] } | null {
  if (!row || !frameId || row.frameId !== frameId) return null;
  return { bbox: row.bbox, anchors: row.anchors };
}

export function scaleImageRect(
  rect: Rect,
  source: { width: number; height: number },
  rendered: { width: number; height: number },
): Rect {
  if (source.width <= 0 || source.height <= 0)
    return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: (rect.x / source.width) * rendered.width,
    y: (rect.y / source.height) * rendered.height,
    width: (rect.width / source.width) * rendered.width,
    height: (rect.height / source.height) * rendered.height,
  };
}
