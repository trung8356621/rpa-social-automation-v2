# Creator UX Refactor — giai đoạn 2

Branch: `feature/creator-ui-refactor`. Không merge main. Thư mục untracked có sẵn `rpa-social-automation-v2/` được giữ nguyên.

## Trạng thái

Người dùng đã xác nhận Overlay POC chạy thành công trên Windows tương tác: 5 passed, 0 pending (native stacking, input vùng không bị che, viewport, navigation và focus). Giai đoạn 2 tiếp tục từ kết quả đó; không làm lại POC.

UI sử dụng hai native WebContentsView đặt trên Embedded Browser: Step Editor ở góc phải phía trên, Test & Debug phía dưới. Nút −/+ thu gọn/mở từng panel bằng cách đổi bounds của panel. Browser luôn giữ bounds x320/y88, viewport 1024 × 560 DIP và zoom của flow. Thu gọn từ panel trả focus về browser; mở panel không tự focus vào ô nhập. F11/fullscreen/restore không scale browser, kéo cạnh vẫn bị khóa.

Top bar chứa Flow, tên flow mới, Save step, URL, Copy URL và zoom. Sidebar chỉ chứa danh sách Step và thêm/chọn Step. Editor giữ Action-first, target ROI/OCR, input và Save. Test được giữ ở đầu panel dưới; kết quả và Đúng/Sai hiện trước Debug. Version/Override, log kỹ thuật, ảnh bằng chứng và hướng dẫn Test cặp mặc định thu gọn. Khi crop/xem ảnh, cả hai native panel được ẩn để canvas dùng đúng toàn bộ hệ tọa độ browser; thoát sẽ hiện lại panel theo trạng thái thu gọn trước đó.

Bản nháp đồng bộ giữa ba renderer qua IPC có kiểm tra sender và danh sách key cho phép. Saved Step, Base/Override và test vẫn dùng Store/Runtime hiện có. Chỉ mở rộng nhận diện focus editor cho hai native panel. Không thay đổi action execution, AUTO resolver, clipboard/upload/session hoặc thêm Publish/Runner/SEO-OPS.

## Kiểm thử

- Typecheck và build pass; 24/24 unit tests pass.
- Electron: creator-ui 10, first 27, restart 3, UX 16, OCR 8, typing 13, upload 8, address 14: tổng 99 checks pass.
- Phase first vẫn partial: screenshot khi ẩn cửa sổ có thể timeout; phím Ctrl+Shift+T vật lý cần xác nhận trong desktop tương tác.
- Regression `creator-native` dùng OS mouse cho nút thu gọn của UI thật và vùng browser không bị che. Phiên automation hiện tại không điều khiển được input desktop: SetCursorPos trả false. Đây là kiểm tra native của UI mới chưa đạt trong phiên này, không phủ nhận kết quả POC bạn đã xác nhận. Regression renderer input/focus và collapse thật trong `creator-ui` đã pass.
- Chưa kiểm thử lại UI refactor trên Facebook thật. Các xác nhận trong fixture không phải Facebook acceptance.

```powershell
Set-Location D:\workspace-2026\rpa\new
npm run typecheck
npm test
npm run test:browser
```

`test:browser` mặc định chạy UI thật cùng các fixture nghiệp vụ; không chạy lại Overlay POC. Trên Windows tương tác, chạy bổ sung:

```powershell
npm run test:browser -- creator-native
```

Giữ desktop mở và không thao tác chuột trong lúc test native. Báo cáo cục bộ: `artifacts/browser-*.json`; lỗi: `artifacts/failure-*.txt`. `artifacts/creator-ui.png` là ảnh ghép từ capture thật của shell, browser và từng native panel theo đúng bounds, không phải ảnh desktop nguyên khối. Báo cáo và ảnh runtime vẫn bị gitignore. Ảnh review fixture được lưu riêng tại [images/creator-ui.png](images/creator-ui.png) để review cùng branch.

![Creator UI từ capture các native view](images/creator-ui.png)

## Kiểm chứng Facebook Group

1. Chạy `npm start`, mở URL Group test và đăng nhập thủ công. Chọn flow đã có hoặc Tạo flow; xác nhận zoom đúng flow. Không xóa `.local/creator` vì chứa session.
2. Trong Step Editor, chọn CLICK_TARGET, crop nút mở composer, xác nhận OCR nếu dùng chữ và bấm Save step. Trong panel dưới bấm Test, quan sát composer thực sự mở rồi bấm Đúng. Nút “Tạo Step tiếp theo” tiếp tục từ trang hiện tại.
3. Với composer đang mở, chọn CLICK_AND_TYPE, crop vùng nhập, nhập nội dung tiếng Việt/emoji/nhiều dòng, Save rồi Test. Quan sát click và nội dung thực tế trước khi xác nhận. Lặp lại với keyboard/clipboard nếu dùng cả hai.
4. Chọn UPLOAD_FILE, chọn ảnh local, crop nút Ảnh/Video, Save rồi Test. Chờ đủ thumbnail/preview thật và không có lỗi mới xác nhận hoàn thành. Không bấm Publish.
5. Bấm Sai để Redesign, sửa target/nội dung rồi Save tạo Base version mới. Mở Version & Override để xem lại version cũ, Ghim version và tạo Override riêng. Chuyển Implementation giữa Base/Override; kiểm tra Base không đổi.
6. Chuyển Step từ sidebar, kiểm tra form/input/target tương ứng và Test dùng payload đã lưu. Thử hủy crop bằng Esc, mở lại crop rồi dùng ROI. Kiểm tra URL/Copy URL sau điều hướng Facebook và sau khi tự nhập URL mới.
7. Click/gõ ở vùng browser không bị che, thu gọn/mở cả hai panel, F11 rồi restore. Trang không reload, target không lệch, browser vẫn 1024 × 560 DIP. TYPE_ONLY/SCROLL: click browser rồi Ctrl+Shift+T và thả phím; hoặc mở hướng dẫn Test cặp cho CLICK → TYPE.
8. Đóng/mở app kiểm tra session, ghi commit hash, zoom, action đã thử và kết quả Đúng/Sai. Facebook acceptance của UI mới cần xác nhận thực tế của bạn.
