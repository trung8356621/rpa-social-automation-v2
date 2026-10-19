# UPLOAD_FILE — Creator POC

Chưa refactor UX tổng thể. Chỉ thêm Action, input chọn ảnh và xác nhận preview trong editor/Test & Debug hiện có. Không có thao tác Publish/Đăng.

## Cơ chế chọn file đã kiểm tra

Đã đọc API/type definitions của Electron 44.9 đang cài: WebContents không cung cấp event `file-chooser` công khai để gán file. Native `dialog.showOpenDialog` được dùng **ở Creator** để user chọn input của Step, với `openFile` và `multiSelections`.

**Trong WebContentsView**: runtime dùng AUTO Visual Target Resolver hiện có tìm nút Ảnh/Video; chỉ sau khi target đủ tin cậy mới click một lần. Trước click, listener và `Page.setInterceptFileChooserDialog` được bật riêng cho operation này. Chooser do website mở trả `Page.fileChooserOpened` với mode và `backendNodeId`; runtime dùng đúng ID đó trong `DOM.setFileInputFiles`. Đây là bridge chọn file của browser, không tìm element bằng selector/DOM tree, không click bằng JavaScript và không giả lập thumbnail hay network upload. Không mở browser khác/Puppeteer.

Đã chạy Electron thật xác nhận event chooser và backend ID hoạt động trên input file của fixture. Sau mỗi lần chạy, listener bị tháo và interception tắt trong finally. Không có global modal handler. Timeout mặc định 8 giây sau click; picker không có backend ID hoặc không hỗ trợ thì dừng, không đoán file input khác. Nhiều ảnh nhưng picker chỉ nhận một file thì báo lỗi, không cắt danh sách hoặc tự click lại. Nếu cleanup báo lỗi, dừng test và mở lại app trước khi tiếp tục.

Tham khảo chính thức: [Electron dialog](https://www.electronjs.org/docs/latest/api/dialog), [Electron webContents/debugger](https://www.electronjs.org/docs/latest/api/debugger), [CDP file chooser interception](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-setInterceptFileChooserDialog), [DOM.setFileInputFiles](https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-setFileInputFiles). Method DOM duy nhất dùng cho upload là chọn file từ chooser vừa nhận; Visual Resolver vẫn độc lập DOM.

## Tạo và chạy Step

1. Mở composer bằng CLICK_TARGET đã có; nhập bản nháp bằng CLICK_AND_TYPE nếu cần.
2. Tạo Step mới, chọn **UPLOAD_FILE trước**. Bấm `Chọn ảnh local`: hỗ trợ 1–20 PNG/JPEG/WebP/GIF; POC hiện chỉ upload ảnh dù nút Facebook có nhãn Ảnh/Video.
3. File được tham chiếu bằng đường dẫn local tuyệt đối trong payload; không copy ảnh vào source hay tự nhúng vào flow. Giữ file còn tồn tại/đọc được khi chạy. Trước click, runtime kiểm tra đường dẫn, file thường có dữ liệu, header ảnh thực, định dạng được hỗ trợ và file trùng.
4. Crop đúng nút Ảnh/Video **ở trạng thái composer hiện tại**. Có thể xác nhận OCR dự phòng; resolver vẫn AUTO. Lưu Base/Redesign hoặc Override như hiện có.
5. Test. Sau khi chooser chấp nhận file, trạng thái là **ACTION_SENT**, `files_selected`, preview **unverified**. Đây chỉ là chọn file, không chứng minh Facebook nhận file, xử lý xong hay hiển thị ảnh.
6. Runtime chụp ảnh trước và sau để ghi bằng chứng; không tự mở ảnh thay trang live. Chờ khoảng 750ms trước ảnh sau chỉ để có frame quan sát, không phải logic xác nhận upload. Preview có thể tới chậm hơn; tiếp tục nhìn browser live hoặc chủ động chụp trạng thái hiện tại.
7. Quan sát đủ số **thumbnail/preview ảnh thật**, kiểm tra đúng ảnh, không còn processing spinner/lỗi upload. Chỉ lúc đó bấm **Đã thấy đủ preview — Hoàn thành Step**. Backend yêu cầu explicit preview confirmation; lời xác nhận chỉ chứng nhận preview người dùng nhìn thấy, không chứng nhận bài đã đăng. Nếu sai, dùng Redesign; Base không bị ghi đè.

Debug chứa chooser mode, số file giao, phase, preview status, cleanup warning và trace AUTO. Kết quả/file paths/ảnh bằng chứng ở `.local/`, bị Git ignore. Không đưa ảnh riêng tư/session lên GitHub.

## Modal hoặc giao diện thay đổi

Nếu nút chỉ mở một modal chọn nguồn ảnh thay vì chooser, Action chờ 8s rồi FAILED và ghi screenshot sau cùng message mô tả không nhận được chooser. Không tự tìm nút trong modal. Xem ảnh, mô tả trạng thái và dùng CLICK_TARGET riêng để mở đúng màn hình trước UPLOAD_FILE, hoặc Redesign ROI. Chooser đã chọn file nhưng site từ chối/không có preview vẫn không tự VERIFIED; quan sát lỗi trước khi thử lại để tránh chọn trùng ảnh.

Khi target không chắc hoặc file mất, chặn trước click. Không tự retry click, không tự dismiss modal/checkpoint. Nếu ảnh debug không chụp được, result giữ trạng thái và báo evidenceWarning, không tự nhận preview thành công. Ảnh sau upload có thể ảnh hưởng native focus; lần nhập tiếp theo nên dùng CLICK_AND_TYPE hoặc thao tác focus đúng như trước.

## Bằng chứng tự động

`npm run typecheck`, `npm test` (24 tests), `npm run build`; `node scripts/browser-test.mjs upload` chạy Electron thật trên session test riêng. Có 8 nhóm kiểm chứng upload:

- Action-first chọn ảnh, crop nút và lưu Base v1 qua UI/IPC. **Hộp thoại chọn ảnh của Creator được stub kết quả trong test**; options/parent, IPC và kiểm tra file là thật. Dialog Windows cần thử tay. **Chooser của WebContentsView là thật**, phát event CDP và chọn file qua backend ID thật.
- Một PNG có tên tiếng Việt: click nút một lần, input change trusted, file được POST dưới dạng byte thật tới HTTP fixture. SHA-256 phía server khớp file gốc; thumbnail lấy ảnh server trả về, browser giải mã đúng 80×60. Chỉ ACTION_SENT trước khi user xác nhận; review không có preview confirmation bị từ chối.
- Hai ảnh: một chooser/chuỗi click, hai POST, hai preview giải mã 80×60 và 72×54; version mới không thay Base v1.
- Nhập bản nháp tiếng Việt/emoji dài 70 dòng bằng keyboard native, quay sidebar rồi upload hai ảnh: text giữ nguyên, toolbar dùng được và đủ preview ảnh. Fixture dùng vùng soạn thảo cuộn nội bộ; không đại diện mọi layout Facebook.
- Site nhận file nhưng cố tình không hiển thị preview: vẫn ACTION_SENT/unverified, không tự VERIFIED.
- Picker single nhận request nhiều ảnh: FAILED, không cắt bớt/giao file, ghi ảnh; listener/interception cleanup.
- Modal phụ không mở chooser: FAILED sau timeout, đúng một click, không input change; ảnh `artifacts/upload-modal.png` và mô tả lỗi. Không xây global handler.
- File mất chặn trước click; Override nhiều ảnh chạy cùng runtime và Base giữ nguyên.

Unit tests thêm validation file, version/Override, chooser event ID, một click, mode mismatch, missing backend ID, timeout và cleanup. Các phase first/second/ux/ocr/typing vẫn hồi quy chức năng cũ.

Report máy: `artifacts/browser-upload.json`; ảnh ghép shell + native browser sau text dài `artifacts/upload-after-long-text.png`. File ảnh/test ở `.local/upload-fixtures-*`, không commit. POC không tự đếm thumbnail Facebook bằng DOM, không coi CDP chọn file hoặc HTTP response là preview thành công. Xác nhận trên Facebook là bước quan sát thủ công.

## Facebook thật cần người dùng xác nhận

Agent chưa chạy UPLOAD_FILE trên phiên Facebook có đăng nhập. Việc CLICK_AND_TYPE nhập text dài hoạt động trên Group do người dùng xác nhận ở bản trước; không phải bằng chứng upload.

1. `npm start`, mở đúng Group/composer bằng session local. Chọn một ảnh test không nhạy cảm qua `Chọn ảnh local`; crop nút Ảnh/Video đúng vị trí hiện tại và lưu UPLOAD_FILE.
2. Test từ sidebar. Xác nhận nút mở picker phù hợp, ảnh thật hiện trong composer. Kiểm tra đúng ảnh, chờ xử lý xong, rồi mới xác nhận đủ preview. Không Publish/Đăng.
3. Xóa ảnh test/đưa composer về trạng thái sạch bằng thao tác tay. Chọn 2–3 ảnh, lưu Redesign hoặc Step riêng; Test và kiểm tra đủ ảnh, không bị chỉ lấy một ảnh hoặc ảnh trùng. Kiểm tra version cũ vẫn còn.
4. Dùng CLICK_AND_TYPE nhập text dài như đã kiểm chứng, sau đó UPLOAD_FILE. Nếu toolbar đã đổi vị trí/ẩn, ghi screenshot và scroll/crop lại đúng trạng thái trước khi chạy; không giả định ROI cũ luôn đúng. Xác nhận text còn nguyên và đủ preview.
5. Nếu có modal lạ/không hiện preview, không bấm xác nhận thành công hoặc retry mù. Mở Debug và Ảnh sau, ghi Step/version, số file, mode/phase, message và mô tả giao diện. Cần CLICK riêng hay Redesign ROI thì sửa flow thủ công; chưa có global handler.
6. Thử mở lại flow/Override và chọn file sau khi đổi thư mục (phải báo file mất trước click). Thử dialog Creator hủy chọn: danh sách cũ phải giữ nguyên. Gặp checkpoint/CAPTCHA thì dừng xử lý thủ công.
