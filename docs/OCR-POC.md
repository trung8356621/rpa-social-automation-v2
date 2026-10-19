# Creator local OCR POC — 19/10/2026

OCR dùng Tesseract.js 7, xử lý ảnh bằng Sharp; model `vie` và `eng` đi cùng dependencies `@tesseract.js-data/vie` và `@tesseract.js-data/eng`. Worker Node/WASM và model đều đọc từ filesystem, không tải CDN hay gọi AI API trong lúc chạy. Model được copy vào `.local/ocr-models/` khi cần; thư mục này bị Git ignore. Chưa đóng gói installer; khi đóng gói cần mang theo worker/WASM/model và kiểm thử lại đường dẫn. Tesseract.js có license Apache-2.0; hai package model khai báo MIT theo package cài đặt.

## Tạo target

Chọn Action → crop ROI → `Dùng ROI`. OCR tự đọc ảnh nhưng **không tự chọn chữ**. Danh sách hiển thị từng dòng hoặc từng từ, confidence 0–100 và bounding box tương đối với ảnh crop. Bấm một mục để xác nhận; có thể bỏ chữ để giữ image-only. Nếu không có chữ hoặc OCR lỗi, ảnh target vẫn được lưu và có thể tạo step image-only.

Target lưu PNG, ROI và phần OCR được user xác nhận. Chọn `Phương thức nhận diện` trước khi lưu Base/redesign/Override. Test luôn dùng payload đã lưu, không dùng form chưa lưu. Mở step đã lưu giữ nguyên chữ xác nhận; dùng `Đọc lại OCR` nếu muốn chọn lại từ ảnh cũ. Không thay đổi schema SQLite: payload JSON mở rộng, target cũ mặc định image matching. Stable ID, append-only version, rollback và Override vẫn giữ nguyên.

## Điều kiện thực thi

- Image: score tối thiểu 0.96 (hoặc threshold cao hơn); chặn khi có ứng viên ảnh gần tương đương ở vị trí khác trong vùng tìm kiếm. Score ảnh không phải xác suất đúng.
- OCR: đọc lại screenshot mới trong ROI mở rộng 64 DIP mỗi phía, giới hạn viewport. Chỉ khớp chính xác sau NFC, chuẩn hóa khoảng trắng và hoa/thường; giữ dấu tiếng Việt, không fuzzy match/substring. Phải có đúng một dòng/từ khớp và confidence ít nhất 80. Confidence là điểm của engine, không bảo đảm đúng về ngữ nghĩa.
- Click ở tâm bounding box của chữ đã tìm thấy, cùng hệ tọa độ screenshot/input DIP. Không fallback từ OCR sang ảnh khi thiếu chữ, lỗi engine, trùng chữ hoặc confidence thấp. Kết quả `BLOCKED` không gửi action.
- `ACTION_SENT`: click/keyboard/scroll đã gửi, **chưa xác nhận kết quả nghiệp vụ**. `VERIFIED`: WAIT/VERIFY xác nhận điều kiện ảnh/chữ, hoặc người dùng quan sát browser live và chọn Đúng sau click. `REJECTED`: người dùng xác nhận sai để Redesign; Base giữ nguyên. `FAILED`: lỗi thực thi khác. Không tự coi click là thành công nghiệp vụ. Xem [quy trình Test & Debug](TEST-DEBUG-UX.md).

OCR chỉ hỗ trợ mục tiêu nhìn thấy trong vùng tìm kiếm, chưa tìm toàn trang hoặc xử lý thay đổi scale/font/theme lớn. Nhận diện chữ không thay thế bước VERIFY kết quả sau action. Không dùng DOM/pseudo-DOM để tìm target. Instrumentation DOM chỉ có trong test shell và fixture local.

## Bằng chứng tự động

`npm run typecheck`, `npm test`, `npm run build`; `node scripts/browser-test.mjs ocr` mở Electron thật với session kiểm thử riêng. Unit suite có 10 tests, gồm OCR thật đọc fixture Việt/Anh, bbox, confidence, ảnh trống, khớp chính xác, thiếu dấu, trùng chữ, OCR failure, image ambiguity, version/Override/rollback.

Electron OCR phase có 6 nhóm kiểm chứng: crop/đọc tiếng Việt không tự chọn; lưu image-only v1 rồi redesign OCR v2; click đúng nút theo bbox mới; WAIT/VERIFY; chặn action với confidence thấp, chữ trùng và service failure; crop/chọn/click tiếng Anh; thông báo lỗi OCR và vẫn lưu ảnh icon. Ca lỗi dùng injection có chủ đích, không phải lỗi model thật. Báo cáo tại `artifacts/browser-ocr.json`; log/ảnh/runtime nằm trong thư mục bị ignore. Các phase first/second/ux kiểm tra hồi quy session, input, crop, version/Override, fullscreen/maximize và zoom. Giữ nguyên các giới hạn screenshot/focus/phím tắt trong README.

## Facebook cần kiểm tra thủ công

OCR Facebook chưa được agent chạy thử. User đã xác nhận browser, flow, crop, Base và gửi click bằng ảnh ở phiên trước; đó không phải bằng chứng OCR Facebook.

1. `npm start`, mở Group thật, tự đăng nhập nếu cần. Chọn zoom trước khi tạo step.
2. CLICK_TARGET → crop nhãn mở composer → Dùng ROI. Kiểm tra dấu tiếng Việt/English, bbox và confidence; xác nhận chưa có chữ nào được chọn tự động.
3. Bấm đúng dòng/từ, chọn OCR text matching, lưu Base; Test. Kết quả chỉ `ACTION_SENT`; tự quan sát composer có mở đúng không.
4. Tạo TYPE_ONLY, lưu bản nháp; click thủ công vào ô soạn thảo rồi dùng Ctrl+Shift+T và thả phím. Action không tự focus. Không Publish.
5. Tạo WAIT/VERIFY, crop dòng bản nháp, chọn chữ chính xác và OCR method, lưu/test. `VERIFIED` chỉ xác nhận dòng đó hiện diện. Kiểm tra toàn bộ bản nháp bằng mắt.
6. Đóng composer/đổi chữ hoặc crop vùng có chữ trùng: phải BLOCKED nếu không xác định duy nhất, không click đoán. Với icon, bỏ OCR và chọn image matching.
7. Redesign v2, mở lại v1; tạo Override rồi quay Base. Thử maximize/fullscreen/restore ở zoom flow đã lưu, kiểm tra click đúng và zoom giữ nguyên. Khởi động lại xác nhận target/text/method/session còn lưu.

Nếu sai, ghi lại action, version, method, chữ chọn, confidence, message và ảnh debug cục bộ; không đưa cookies/session lên GitHub. Gặp checkpoint/CAPTCHA thì dừng để người dùng xử lý.
