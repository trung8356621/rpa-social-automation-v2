# RPA Creator V2 — POC

Creator đầu tiên, theo [baseline V2 trên Drive](https://docs.google.com/document/d/141N81qBlAg9VlX1WF-iaX9CfAieTcmBokjbWp5rpqUY/edit), đọc ngày 19/10/2026; mục 24 Action-first ưu tiên hơn các ý tưởng cũ.

**Trạng thái: POC một phần, chưa đạt acceptance Facebook.** Đã chạy Electron thật và kiểm chứng editor/runtime trên trang kiểm chuẩn local. Facebook chưa được kiểm thử.

## Chạy ứng dụng

Dependency đã được cài trong `new/`. PowerShell:

```powershell
Set-Location D:\workspace-2026\rpa\new
npm start
```

Ứng dụng mở ở content window 1344×648 DIP, sidebar 320 DIP và WebContentsView cố định 1024×560 DIP. Không resize thủ công; có thể maximize bằng nút cửa sổ và bật/tắt fullscreen bằng nút `Toàn màn hình` hoặc F11. Zoom, viewport web và gốc tọa độ crop/click không thay đổi khi chuyển chế độ; phần cửa sổ rộng thêm không scale trang web. Work area ban đầu cần tối thiểu 1360×688 DIP; app báo lỗi nếu không vừa, không âm thầm thu nhỏ web. Ở zoom 100%, web rộng 1024 CSS px; zoom 90/80% có CSS viewport rộng hơn. Zoom khóa sau khi flow có step; tạo flow mới để chọn môi trường khác.

Electron 44.9.0, React 19, Vite 8, TypeScript, Sharp, SQLite tích hợp trong Node của Electron (`node:sqlite`). Không có Puppeteer hay browser thứ hai. Browser session, ảnh, DB và log development đều nằm trong `new/.local/creator/`. Không xóa thư mục này nếu cần giữ đăng nhập. `.local/` bị gitignore. Chưa đóng gói installer; vị trí dữ liệu này dành cho POC trong workspace.

## Cách dùng

1. Tạo flow bằng nút `Tạo flow` hoặc chọn flow đã lưu ở Bước 1. Khi chưa có flow, ngay cạnh nút crop có lý do và nút `Đi tới bước 1`. Chọn zoom trước khi lưu step đầu tiên.
2. Chọn Action trước. CLICK_TARGET và WAIT/VERIFY cần `Chụp & crop ROI`; TYPE_ONLY và SCROLL không cần target.
3. Kéo ROI trên ảnh, chọn `Dùng ROI` ở thanh trên cùng, rồi `Lưu Base v1`. `Quay lại browser` hoặc Escape hủy crop mà không lưu step. Nút thoát luôn ở thanh trên cùng, kể cả khi sidebar cuộn xuống hoặc crop báo lỗi. Trong crop mode, Escape thoát crop trước; khi đang ở browser fullscreen, Escape thoát fullscreen. Ảnh crop PNG được lưu thật.
4. Test step đã lưu. CLICK_TARGET gửi click thật trên browser đang hiển thị và trả ACTION_SENT; không tự chụp ảnh sau click hay reset trang. Quan sát kết quả rồi chọn **Đúng — Hoàn thành Step** để VERIFIED và tạo Step tiếp theo từ trạng thái hiện tại, hoặc **Sai — Redesign Step** để sửa mà giữ Base. WAIT/VERIFY xác nhận điều kiện ảnh/chữ. Xem [quy trình Test & Debug](docs/TEST-DEBUG-UX.md) và [hướng dẫn OCR](docs/OCR-POC.md).
5. TYPE_ONLY: lưu nội dung, click thủ công vào ô nhập trong browser, nhấn **Ctrl+Shift+T rồi thả các phím**. Action không tự tìm input, click hoặc focus. Nếu native focus không thuộc browser, runtime từ chối.
6. Chỉnh form rồi `Lưu redesign` tạo version mới cùng stable ID. Chọn version cũ và `Ghim version` để rollback flow. V1 vẫn tồn tại trong SQLite.
7. `Lưu form thành Override riêng` giữ Base nguyên vẹn. Chọn Implementation để test Base hoặc Override. Override tham chiếu đúng Base version; đổi Base phải test/lưu Override lại. UI hiện hỗ trợ replacement một action; contract/runtime hỗ trợ segment tối đa 8 action, chưa có segment editor.

Khi sửa form, Test vẫn dùng **payload đã lưu**. Chưa có full-flow runner, breakpoint debugger, recorder hoặc auto modal/security detector; scope hiện tại là author/test từng step. CAPTCHA/checkpoint cần người dùng dừng và xử lý thủ công, không tự tiếp tục.

## Giới hạn đã tái hiện

- Chụp screenshot có thể làm mất native focus của WebContentsView trên build Electron/Windows này. TYPE_ONLY/SCROLL vì vậy gửi input **trước** ảnh debug và không có ảnh trước; không khôi phục focus tự động. Sau khi xem/chụp ảnh, click lại ô nhập trước lần TYPE_ONLY tiếp theo.
- `capturePage` từng báo `Current display surface not available for capture`. Backend hiện dùng CDP `Page.captureScreenshot` của chính WebContentsView, không dùng DOM hoặc browser khác. Ảnh được chuẩn hóa về DIP trước crop/click.
- Chụp khi ẩn native view đã trả về ảnh không trắng trên fixture; ẩn toàn BrowserWindow bị timeout 4 giây ở bản cuối. Không cam kết chạy khi ẩn/minimize/khóa màn hình. Input chủ động bị chặn khi browser ẩn.
- Phím tắt Ctrl+Shift+T đã nối vào runtime ở main process nhưng **chưa kiểm chứng bằng bàn phím vật lý** trong automation desktop. Synthetic `sendInputEvent` không đi qua `before-input-event`; thử Windows SendKeys cũng không tới app đáng tin cậy. Cần xác nhận thủ công trước bài Facebook.
- Matching là RGB template search trong ROI ±64 DIP, threshold mặc định 0.96. Có OCR local Việt/Anh, chọn chữ tường minh và chặn ứng viên trùng/thiếu tin cậy. Chưa scale-invariant matching hoặc tìm toàn trang. Không dùng target đơn sắc/ít chi tiết. Chưa benchmark hiệu năng Facebook.
- Đã đo zoom 100/90/80% ở Windows scale 100% (DPR nền 1); chưa kiểm tra Windows 125/150%, nhiều màn hình và nhiều ngôn ngữ/tài khoản Facebook.
- Ảnh/log POC chưa có retention tự động; chúng có thể chứa nội dung đang hiển thị. Không export session cùng flow.

## Kiểm thử và bằng chứng

```powershell
npm run typecheck
npm test
npm run test:browser
```

`test:browser` mở Electron thật, dùng session kiểm thử riêng `.local/test-session/`, chạy hai process liên tiếp. Không mở hay thao tác Facebook. Exit 0 nghĩa assertions tự động hoàn tất; các mục `limitation`/`manualRequired` vẫn khiến trạng thái POC là **PARTIAL**.

Bộ test hiện chạy thêm process UX với session riêng `.local/test-ux-<pid>/`, kiểm tra tạo flow, hủy/lỗi crop, maximize/fullscreen/restore. Có thể chạy riêng sau build bằng `node scripts/browser-test.mjs ux`. Báo cáo sửa UX: [docs/UX-FIXES.md](docs/UX-FIXES.md); kết quả máy: `artifacts/browser-ux.json`.

Bản Test & Debug: 10 unit tests qua; 54 checks Electron đạt (27 first + 3 restart + 16 UX + 8 OCR/debug), còn 2 mục giới hạn/thủ công ở lần chạy cuối: screenshot khi ẩn view timeout và phím tắt vật lý chưa xác nhận. Screenshot/focus vẫn có thể không ổn định theo môi trường; CLICK_TARGET không tự chụp sau click. Báo cáo: [Test & Debug](docs/TEST-DEBUG-UX.md), [OCR](docs/OCR-POC.md). Các báo cáo POC/UX cũ giữ làm lịch sử; kết quả mới tại `artifacts/browser-*.json`.

[Ảnh review UI](artifacts/creator-ui-composed.png) được ghép từ capture shell và capture browser thật, vì BrowserWindow.capturePage không chứa native child view. Đây không phải ảnh chụp desktop nguyên khối.

## Bài Facebook cần người dùng kiểm tra

1. Chạy `npm start`, mở Facebook bằng URL, tự đăng nhập. Đóng app bằng nút X, mở lại và xác nhận vẫn đăng nhập.
2. Ở zoom 100%, crop nút mở composer, lưu CLICK_TARGET, test; xác nhận composer thực sự mở.
3. Tạo TYPE_ONLY với nội dung bản nháp. Click thủ công vào vùng soạn thảo, dùng Ctrl+Shift+T và thả phím. Xác nhận đúng chữ/dấu/emoji, không mất hoặc lặp ký tự. Nếu không chạy, ghi trạng thái focus và message; chưa xem phím tắt là đã đạt.
4. Chụp/crop vùng bản nháp, lưu WAIT/VERIFY và test. Chọn OCR text matching để xác nhận dòng chữ, rồi kiểm tra bằng mắt toàn bộ nội dung.
5. Thử redesign V2, mở lại V1; lưu Override và chuyển về Base để xác nhận Base không đổi.
6. **Không bấm Publish.** Không có Publish action được tạo sẵn. Nếu gặp CAPTCHA/checkpoint, dừng và xử lý thủ công.

Không có Runner, Profile/Proxy Manager, SEO-OPS, marketplace, crawler hoặc AI API trong POC này. `old/` chỉ được đọc; `git status --porcelain` tại đó trống sau triển khai.
