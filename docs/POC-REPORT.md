# Báo cáo POC Creator V2 — 19/10/2026

Baseline: Google Doc `141N81qBlAg9VlX1WF-iaX9CfAieTcmBokjbWp5rpqUY`, bản sửa 03:00 UTC ngày 19/10/2026; mục 24 supersedes mục 23. Không triển khai pseudo-DOM. Không sao chép nguyên kiến trúc V1.

## Giai đoạn 1 — Browser Core và Embedded Browser

Files: `src/main/main.ts`, `src/main/browser-core.ts`, `src/main/fixture.ts`, `src/preload/index.cts`, `src/shared/geometry.ts`, cấu hình Electron/Vite/TypeScript và package lock.

Đã chạy thực tế:

- Một BrowserWindow cố định, một WebContentsView, cùng webContents cho navigation/input/capture. Session partition `persist:creator-default`.
- Bounds web 1024×560 DIP, content app 1344×648 DIP; actual outer window trên máy test 1360×687 DIP. Không thu nhỏ để vừa màn hình.
- Fixture đo click ở CSS (270,152) đúng khi zoom 1.0, 0.9 và 0.8. PNG chuẩn hóa 1024×560 px tương ứng view DIPs; input được gửi trong không gian DIP, không cộng offset sidebar vào tọa độ browser.
- Nhập đúng `Nháp tiếng Việt 👋` vào textarea đã focus; gửi TYPE_ONLY khi button đang focus không tự chuyển sang textarea. Từ chối TYPE_ONLY khi editor có focus.
- Wheel scroll thay đổi scrollY trên fixture.
- Cookies có Max-Age và localStorage giữ nguyên qua hai Electron process; không dùng cookie sync hoặc Puppeteer. Đây chưa phải chứng minh session Facebook.

Vấn đề chưa đạt: screenshot có thể làm mất native focus; chụp khi ẩn toàn cửa sổ bị timeout; DPI 125/150% và phím tắt vật lý cần thử. Không cam kết unattended/hidden execution.

## Giai đoạn 2 — Action Editor, storage và runtime tối thiểu

Files: `src/renderer/main.tsx`, `src/renderer/style.css`, `src/shared/contracts.ts`, `src/main/storage.ts`, `src/main/runtime.ts`, `src/main/visual.ts`.

Đã chạy thực tế:

- UI chọn Action, chụp ảnh, kéo ROI bằng mouse events trên UI thật, lưu crop PNG và Base.
- Test CLICK_TARGET đi qua IPC/runtime chung, có matching score và ảnh trước/sau.
- Target dời ra ngoài vùng tìm kiếm làm test thất bại và không phát sinh click.
- Base stable ID với version append-only, redesign giữ V1; rollback ghim version trong flow.
- Lưu Override riêng, thực thi replacement segment, Base không đổi; từ chối Override sai baseVersion.
- Đóng/mở process giữ flow, step versions, Override và target assets.
- TYPE_ONLY qua IPC/runtime khi browser đang focus nhập chính xác `Bản nháp UI 👋`. UI nhận kết quả sau thực thi. Không có refocus hoặc click trong TYPE_ONLY.

Giới hạn: chỉ author/test từng step; WAIT/VERIFY là image verification; chưa OCR, full-flow execution, segment editor hoặc breakpoint UX. Phím tắt Ctrl+Shift+T cần người dùng kiểm tra trên desktop thật.

## Kiểm chứng

- `npm run typecheck`: qua.
- `npm test`: 4 tests qua (geometry/bounds, version/rollback/override, action requirements, image matching/mismatch/low contrast).
- Electron report cuối: `artifacts/browser-first.json` có 26 checks qua và 3 mục chưa đạt/cần thủ công; `artifacts/browser-second.json` có 3 checks qua sau restart.
- `npm audit` sau cập nhật Sharp 0.35.5: 0 vulnerabilities tại thời điểm cài cuối.
- `artifacts/creator-ui-composed.png`: ảnh review ghép shell + browser capture thật. BrowserWindow capture chỉ chứa shell; không dùng ảnh shell trống để kết luận browser không hiển thị.
- Facebook: **chưa chạy**; không có tài khoản/credentials được sử dụng, không bấm Publish.

Exit code của browser harness xác nhận assertions tự động hoàn tất, không xóa các giới hạn trong report. POC tổng thể vẫn **PARTIAL**.

## Lỗi đã ghi nhận và xử lý

1. Đường dẫn build ban đầu tính sai, tạo test data ở workspace root. Đã sửa root thành `new/dist`, dọn riêng dữ liệu phát sinh; workspace root cuối chỉ còn `old/` và `new/`.
2. Sharp.extract dùng `left/top`, không dùng `x/y`. Đã sửa, build/typecheck qua.
3. Windows có thể bỏ lần show đầu khi helper chạy với windowsHide. Harness show/focus chủ động cho kiểm thử; không thêm topmost vào ứng dụng sản phẩm. Topmost chỉ nằm trong self-test để kiểm soát foreground.
4. App cao 728 DIP bị Windows giới hạn trên work area máy test. Chọn viewport cố định 1024×560 DIP và kiểm tra actual content size, không scale viewport âm thầm.
5. `capturePage` có lỗi display surface. CDP screenshot trên cùng webContents hoạt động cho capture hiện tại; timeout và detach debugger khi không có frame. Không mở browser thay thế.
6. Capture có thể làm mất native focus. Không tự refocus: TYPE_ONLY/SCROLL bỏ pre-capture, gửi input trước ảnh debug. Đây là workaround POC, chưa phải kết luận giải quyết mọi focus case.
7. UI assertions từng đọc result cũ khi runtime chưa xong. Đã chuyển sang chờ đúng kết quả/action; không sửa test để báo pass cho dữ liệu chưa xuất hiện.
8. Synthetic keyboard không phát before-input-event; SendKeys không đến được app đáng tin cậy. Phím tắt được ghi manualRequired. Test runtime dùng IPC thật với focus giữ nguyên và đối chiếu giá trị textarea fixture.
9. Screenshot khi window hidden có thể treo. Đặt timeout 4 giây, ghi limitation, không báo pass. Input bị chặn khi hidden/minimized.
10. Một test process treo từng giữ single-instance lock. Đã dừng riêng process `--self-test`; harness kiểm tra timestamp report để không nhận exit 0 từ instance bị từ chối thành test pass.

## Bước tiếp theo

Ưu tiên kiểm tra phím tắt/focus trên desktop người dùng, rồi bài Facebook composer → TYPE_ONLY → kiểm tra bản nháp, không Publish. Sau đó mới quyết định sửa capture/focus sâu hơn và chọn OCR nếu image verification không đủ. Chưa xây Runner, proxy/profile management hay crawler.
