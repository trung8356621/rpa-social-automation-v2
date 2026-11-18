import type { ActionTag, Command, State } from "../shared/contracts";
import type { ActionTagsRefreshResult } from "../shared/action-tags";

export type ActionTagsRefreshResponse = ActionTagsRefreshResult & { state?: State };

export async function refreshActionTagsFromSeoOps(
  invoke: <T>(command: Command) => Promise<T>,
  options?: { force?: boolean },
): Promise<ActionTagsRefreshResponse> {
  return invoke<ActionTagsRefreshResponse>({
    type: "seoOpsRefreshActionTags",
    force: options?.force,
  });
}

/**
 * Patch tags only — never replace the full State snapshot from IPC.
 * Replacing state() on every refresh recreates flows/steps array refs and
 * re-triggers Creator/Scripts effects → API request storms.
 */
export function applyActionTagsToState(
  state: State | undefined,
  tags: ActionTag[],
  _nextState?: State,
): State | undefined {
  if (!state) return state;
  return { ...state, actionTags: tags };
}

export function formatActionTagsRefreshStatus(result: ActionTagsRefreshResult): string {
  if (result.ok) {
    if (result.source === "api") {
      return `Đã cập nhật ${result.count} Action Tag từ SEO-OPS.`;
    }
    if (result.source === "requests") {
      return `Đã bổ sung Tag từ Script Requests (${result.count} Tag).`;
    }
    return `Đang dùng cache local (${result.count} Tag).`;
  }
  if (result.authRequired) {
    return `Cần đăng nhập lại SEO-OPS. Đang giữ cache local (${result.count} Tag).`;
  }
  const via =
    result.source === "requests"
      ? `đang dùng Tag từ Script Requests + cache (${result.count} Tag)`
      : `đang dùng cache local (${result.count} Tag)`;
  if (result.rateLimited) {
    const wait = result.retryAfterSeconds ? ` Thử lại sau ${result.retryAfterSeconds}s.` : "";
    return `SEO-OPS đang giới hạn yêu cầu.${wait} — ${via}.`;
  }
  return `Không làm mới được Tag: ${result.error} — ${via}.`;
}
