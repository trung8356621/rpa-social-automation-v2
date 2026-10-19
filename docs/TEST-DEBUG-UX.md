# Test & Debug — xác nhận kết quả trên browser live

## Đường gọi đã kiểm tra

Nút Test → IPC `test` → `Runtime.test` → nhận diện target từ screenshot → `BrowserCore.click` → focus chính `WebContentsView.webContents` đang hiển thị → `sendInputEvent(mouseMove/mouseDown/mouseUp)`. Phím tắt đi vào cùng runtime. Không có browser thứ hai, mô phỏng click hoặc DOM automation để thực thi action.

`CLICK_TARGET` chỉ trả `ACTION_SENT` khi đã gửi input; không coi đó là kết quả nghiệp vụ đúng. Browser được giữ nguyên URL, session, trạng thái giao diện và viewport; runtime không navigate/reload/reset/khôi phục ảnh trước. Bỏ screenshot **tự động sau CLICK_TARGET** vì có thể làm mất focus. Screenshot trước vẫn cần cho nhận diện; click thật sau nhận diện focus browser trước khi gửi chuột.

## Quy trình mới

1. Lưu Base/Redesign/Override, rồi Test. Mục Test ghi phương thức của payload **đã lưu**, không lấy phương thức từ form chưa lưu.
2. Kết quả cho biết chính xác OCR hay Image Matching, chữ OCR/confidence hoặc ảnh target/score, tọa độ DIP và Step/version/Base hay Override. OCR được lưu cùng ảnh không có nghĩa runtime đã dùng OCR.
3. Quan sát **browser live**, đợi giao diện phản hồi. Sau click không tự mở screenshot. Chỉ xem `Ảnh trước` hoặc `Chụp trạng thái hiện tại` khi cần; `Quay lại browser`/Escape đóng overlay, không hoàn tác trang.
4. Chọn **Đúng — Hoàn thành Step** nếu kết quả mong đợi đã xuất hiện. Lần test đó mới thành `VERIFIED`, ghi người xác nhận và thời gian vào lịch sử SQLite/JSON local. Xác nhận áp dụng đúng lần test/Step/version/implementation, không chứng nhận toàn bộ flow.
5. Chọn **Tạo Step tiếp theo từ browser hiện tại** để mở Action-first editor rỗng trong cùng flow. Không replay hoặc mở lại trang; phím tắt của Step cũ được disarm cho đến khi chọn/lưu Step khác.
6. Nếu sai, chọn **Sai — Redesign Step**. Lần test thành `REJECTED`; editor mở lại Step/version đã test (payload Override nếu có). Base và Override vẫn nguyên vẹn. Chỉ bấm lưu Redesign mới append version tiếp theo cùng stable ID. Muốn giữ cách sửa trong Override, dùng nút lưu Override riêng hiện có.

Chỉ lần test mới nhất trong phiên đang mở, còn `ACTION_SENT`, thuộc flow/version hiện tại mới được xác nhận; không xác nhận lại hoặc xác nhận một lần test đã bị thay thế. Khi đổi version ghim hoặc khởi động lại, hãy Test lại để quan sát kết quả mới. WAIT/VERIFY vẫn có thể trả `VERIFIED` tự động khi điều kiện ảnh/chữ được kiểm chứng rõ ràng; điều đó chỉ chứng nhận điều kiện của Step.

## Focus và ảnh chụp

Fixture Electron đã kiểm tra click mở textarea, `document.activeElement` là ô nhập và native browser vẫn có focus sau Test. Đếm được đúng một screenshot cho CLICK_TARGET (phục vụ nhận diện), không có screenshot sau click. Đây là kiểm chứng trên fixture, không bảo đảm mọi giao diện Facebook.

Click nút xác nhận hoặc thao tác sidebar có thể chuyển native focus về editor. Trước TYPE_ONLY, click **thủ công** vào ô soạn thảo rồi nhấn Ctrl+Shift+T và thả phím; TYPE_ONLY không tự focus. Chụp/xem ảnh theo yêu cầu cũng có thể ảnh hưởng focus. Không tự khôi phục focus bằng DOM hoặc click thêm sau action.

## Kiểm thử tự động

- `npm run typecheck`, `npm test` (10 unit tests), `npm run build`.
- `node scripts/browser-test.mjs first second ux ocr`: Electron thật, fixture local và session test riêng. OCR phase có 8 nhóm assertions, gồm click Việt/Anh, phương thức thực dùng, không tự chụp sau click, browser live/focus, xác nhận đúng + tiếp tục, xác nhận sai + version mới, chặn review lặp/cũ và giữ ảnh trước khi xem lại sau review.
- Hồi quy first/second/ux: session sau restart, crop, input, Base/Override/version, tọa độ/zoom qua maximize/fullscreen/restore. Report nằm trong `artifacts/browser-*.json`, được Git ignore.
- Vẫn còn các giới hạn trước đó: screenshot có thể làm mất focus; screenshot khi ẩn cửa sổ có thể timeout; phím tắt bàn phím vật lý cần kiểm tra thủ công. Không nhận là đã kiểm thử Facebook.

## Thử lại trên Facebook thật

1. `npm start`, vào Group, tạo hoặc chọn flow và Step mở composer. Chọn/lưu OCR hoặc Image Matching; kiểm tra nhãn phương thức **đã lưu**.
2. Test. Xác nhận click xảy ra trên browser đang nhìn thấy, composer mở và giữ nguyên. Kết quả phải là `ACTION_SENT`, không tự VERIFIED hay hiện ảnh cũ thay browser.
3. Đợi giao diện ổn định rồi chọn **Đúng**. Kiểm tra `VERIFIED`, tạo Step tiếp theo và chọn TYPE_ONLY. Composer vẫn mở, không chạy lại Step trước.
4. Lưu nội dung nháp; click thủ công vào composer, dùng phím tắt Test. Kiểm tra chữ/dấu và focus. **Không Publish**.
5. Test một CLICK_TARGET khác rồi chọn **Sai**. Kiểm tra editor đúng Step/version; Base chưa đổi. Crop/chọn target lại và lưu Redesign; v2 có cùng ID, v1 vẫn mở được. Browser không bị reset.
6. Thử xem Ảnh trước rồi Quay lại browser, thử Chụp trạng thái hiện tại; ảnh chỉ mở theo yêu cầu và đóng ảnh không hoàn tác Facebook. Lặp lại ở maximize/fullscreen/restore. Nếu có checkpoint/CAPTCHA thì dừng để xử lý thủ công.
