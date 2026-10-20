import type { Payload, VisualEnvironment } from "./contracts.js";
import {
  WEB_WIDTH,
  WEB_HEIGHT,
  EDITOR_WIDTH,
  validateZoom,
} from "./geometry.js";
export function targetEnvironment(
  payload: Payload,
  flowZoom: number,
): VisualEnvironment | undefined {
  if (
    !["CLICK_TARGET", "CLICK_AND_TYPE", "UPLOAD_FILE", "WAIT_VERIFY"].includes(
      payload.action,
    )
  )
    return;
  return (
    payload.target?.environment ?? {
      width: WEB_WIDTH,
      height: WEB_HEIGHT,
      zoom: flowZoom,
    }
  );
}
export function validateVisualEnvironment(environment: VisualEnvironment) {
  if (
    !environment ||
    ![WEB_WIDTH, WEB_WIDTH - EDITOR_WIDTH].includes(environment.width) ||
    (!Number.isInteger(environment.height) || environment.height < 1)
  )
    throw new Error("Viewport target không hợp lệ.");
  validateZoom(environment.zoom);
}
export function assertVisualEnvironment(
  payload: Payload,
  flowZoom: number,
  current: VisualEnvironment,
) {
  const expected = targetEnvironment(payload, flowZoom);
  if (!expected) return;
  validateVisualEnvironment(expected);
  if (
    expected.width !== current.width ||
    expected.height !== current.height ||
    expected.zoom !== current.zoom
  )
    throw new Error(
      `Viewport không khớp target: cần ${expected.width}×${expected.height} @${expected.zoom * 100}%, hiện tại ${current.width}×${current.height} @${current.zoom * 100}%. Cần crop lại target ở viewport hiện tại ${current.width}×${current.height} rồi lưu redesign. Target/version cũ được giữ nguyên; không tự scale hoặc click đoán. Chưa gửi input.`,
    );
}
