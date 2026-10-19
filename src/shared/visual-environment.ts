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
    environment.height !== WEB_HEIGHT
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
      `Viewport không khớp target: cần ${expected.width}×${expected.height} @${expected.zoom * 100}%, hiện tại ${current.width}×${current.height} @${current.zoom * 100}%. ${expected.width === WEB_WIDTH ? "Ẩn" : "Mở"} Editor để khôi phục viewport đã lưu; hoặc crop lại và lưu version mới. Chưa gửi input.`,
    );
}
