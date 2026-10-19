# Sửa UX flow/ROI và chế độ cửa sổ — 19/10/2026

## Thay đổi

- Bước 1 ghi rõ phải tạo hoặc chọn flow trước khi lưu step; nút `Tạo flow`, tên flow đang chọn và thông báo sau tạo giúp thấy trạng thái hiện tại.
- Nút crop giữ precondition flow; thông báo giải thích ngay cạnh nút, liên kết qua `aria-describedby`, kèm `Đi tới bước 1` để focus trường tên flow. Không còn disabled không có lý do.
- Dời xác nhận ROI và `Quay lại browser · Esc` từ sidebar lên thanh trên cùng. Escape hoạt động ngay cả khi chưa vẽ ROI, đang kéo hoặc sau lỗi crop; pointer cancel/lost capture không để drag state bị kẹt.
- Giữ `resizable:false`, bật maximize và fullscreen. F11/nút trên header đổi fullscreen; Escape thoát fullscreen khi đang ở browser, ưu tiên thoát crop nếu đang xem ảnh.
- WebContentsView và ảnh luôn 1024×560 DIP tại offset (320,88). Chỉ native window lớn thêm; không đổi zoom hoặc scale browser/ảnh. Giữ lại khoảng trống ngoài vùng thiết kế.
- Windows cần `setMaximizable(true)` sau khi khởi tạo và bỏ maximum size cố định do `resizable:false` tạo ra. `isResizable()` vẫn false qua tất cả các mode. Nguồn đối chiếu: [Electron v44.9.0 native_window_views.cc](https://github.com/electron/electron/blob/v44.9.0/shell/browser/native_window_views.cc).

## Đã kiểm chứng thực tế bằng Electron + fixture

`npm run typecheck`, 4 unit tests và build đều qua. Vòng cuối trên bản sửa có 30 checks regression qua hai process và **16 checks UX qua** (46 checks qua tổng cộng). Report còn hai mục chưa đạt/cần thủ công: capture khi hidden view bị timeout và phím Ctrl+Shift+T vật lý chưa xác nhận. Capture/focus có kết quả thay đổi giữa các lần chạy nên vẫn giữ các giới hạn POC cũ, không xem bản sửa UX là đã giải quyết chúng. Report UX tại `artifacts/browser-ux.json`:

1. Profile kiểm thử mới chưa có active flow: crop disabled có giải thích và CTA focus đúng ô tên flow.
2. Tạo flow bằng UI thật bật crop; chụp, kéo ROI, lưu ảnh và Base được.
3. Nút thoát ở thanh trên cùng vẫn nhìn thấy khi sidebar cuộn xuống cuối.
4. Escape khi chưa vẽ ROI và khi đang kéo đều trả browser về visible.
5. Pointer cancel không giữ drag state; crop có thể mở lại/thoát bình thường.
6. Backend crop được tiêm lỗi ảnh hết hạn: hiện lỗi, không lưu Base, vẫn thoát bằng Escape được.
7. Ở zoom 100% và 90%: kiểm tra normal → maximize → fullscreen → maximize → restore. Mỗi mode kéo crop mới, sau đó runtime click bằng **cùng target đã lưu ban đầu**, đối chiếu CSS click thực tế trên fixture gần (270,152), sai số <2 px. Không hiệu chỉnh lại target theo mode.
8. Kiểm tra actual native bounds: maximize phủ work area, fullscreen phủ display; không chỉ dựa vào `isMaximized()`/`isFullScreen()`.
9. Browser bounds, PNG 1024×560 và zoom flow giữ nguyên; CSS viewport không dưới 1024.
10. Đổi sang maximize khi đang crop vẫn giữ nguyên canvas, Escape vẫn thoát được.

Máy test Windows scale 100%, display 1366×768, work area 1366×720:

| Mode | Native window bounds (width×height) | Content size | Browser view |
| --- | --- | --- | --- |
| Normal / Restore | 1360×687 | 1344×648 | 1024×560 |
| Maximize | 1382×736, gồm viền ngoài work area | 1366×697 | 1024×560 |
| Fullscreen | 1366×768 | 1366×768 | 1024×560 |

Lỗi ban đầu đã được test bắt: chỉ set flags khiến `isMaximizable()` false; bật lại style khiến trạng thái maximize true nhưng cửa sổ còn bị maximum-size cap. Bản cuối đã bỏ cap và test actual bounds qua.

## Facebook thật: chưa xác nhận trong lượt sửa này

Fixture không chứng minh composer hoặc UI Facebook giống nhau. Không sử dụng session Facebook của người dùng trong test, không bấm Publish. Cần người dùng thử lại:

1. `npm start`, đăng nhập Facebook như trước. Nếu chưa có flow, kiểm tra lời hướng dẫn cạnh crop, bấm `Đi tới bước 1`, nhập tên và `Tạo flow`.
2. Trên Facebook đang hiển thị, chụp/crop ROI, `Dùng ROI` và lưu Base. Kiểm tra ảnh target đúng vùng đã kéo.
3. Mở crop rồi nhấn Escape khi chưa kéo; mở lại, kéo dở rồi Escape; cuộn sidebar xuống và dùng nút thoát trên cùng. Browser phải hiện lại, không mất login.
4. Với cùng flow/target, thử maximize → fullscreen bằng nút/F11 → restore. Xác nhận zoom không đổi, ROI không lệch và CLICK_TARGET vẫn click đúng. Không Publish.
5. Khi crop trong fullscreen, Escape lần đầu phải hủy crop; Escape tiếp theo khi browser có focus mới thoát fullscreen.

Chưa benchmark DPI 125/150%, nhiều màn hình hoặc phím F11 vật lý trong automation desktop; cần kiểm tra trên máy người dùng. Không mở rộng Runner/proxy/SEO-OPS.
