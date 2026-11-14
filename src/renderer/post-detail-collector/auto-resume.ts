import type { PostDetailSavedParentResolution } from "../../shared/post-detail-collector/types";

const TRANSIENT_FAILURES = new Set<PostDetailSavedParentResolution["failureCode"]>([
  "BROWSER_NOT_READY",
  "NOT_FOUND",
  "PARENT_MISMATCH",
  "ACTION_ROW_SELECTOR_NOT_FOUND",
  "ACTION_ROW_INVALID",
  "POST_IDENTITY_MISMATCH",
]);

export function shouldRetrySavedParentResolution(result: PostDetailSavedParentResolution): boolean {
  return Boolean(result.failureCode && TRANSIENT_FAILURES.has(result.failureCode));
}
