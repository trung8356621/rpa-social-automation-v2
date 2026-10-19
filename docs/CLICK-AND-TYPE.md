# CLICK_AND_TYPE — focus vùng nhập và nhập trong một lần Test

## Quyết định hiện tại

Hai click thuộc **hai Step khác nhau**:

1. `CLICK_TARGET`: mở composer.
2. `CLICK_AND_TYPE`: composer đã mở; nhận diện vùng nhập → click trái một lần vào target → nhập ngay trong cùng runtime.

Không double-click, không tự replay Step mở composer. Người dùng có thể quay về Creator để thiết kế/lưu/test Step 2; không cần click tay vào ô nhập trước Test Step 2. `TYPE_ONLY` vẫn giữ nguyên cho flow cũ và trường hợp caret đã được thiết lập. Test cặp CLICK → TYPE cũ vẫn hoạt động.

## Editor và runtime

Chọn `CLICK_AND_TYPE` trước, điền bản nháp và chọn Keyboard hoặc Clipboard paste. Crop ROI nhãn/placeholder **bên trong vùng nhập**, không crop nút mở composer. Xác nhận một dòng/từ OCR rồi chọn OCR matching, hoặc giữ Image Matching cho target phù hợp. Không tự chọn toàn bộ text; cần lưu Base/Redesign/Override trước khi Test.

Runtime dùng chung resolver với CLICK_TARGET: screenshot phục vụ nhận diện, OCR local chính xác với confidence ≥80 và đúng một vị trí, hoặc image score ≥0.96 và không ambiguous. Khi nhận diện chưa đủ tin cậy, `BLOCKED`, không click và không nhập; Creator tự mở đúng Step/version để Redesign và vẫn có nút `Redesign Step bị chặn` trong kết quả. Base không thay đổi; chỉ lưu Redesign mới append version mới cùng ID.

Khi nhận diện đạt điều kiện, `BrowserCore.click` gửi một chuỗi mouseMove/mouseDown/mouseUp với `clickCount: 1`. Sau đó gọi ngay cùng implementation nhập liệu của TYPE_ONLY, không trả về renderer, không screenshot và không chuyển sang sidebar giữa hai thao tác. Keyboard dùng native key dispatch + Shift+Enter; clipboard dùng native paste với snapshot/restore best effort như [TYPE_ONLY](TYPE-ONLY-POC.md). Không gán DOM value hoặc inject JavaScript để nhập/click/focus.

Không tự chụp sau input; browser live giữ nguyên để quan sát. `ACTION_SENT` chỉ cho biết click/nhập đã gửi. Chỉ chọn **Đúng — Hoàn thành Step** sau khi nhìn thấy đúng bản nháp mới thành `VERIFIED`; có thể dùng VERIFY riêng. Chọn **Sai — Redesign Step** giữ Base. Kết quả ghi rõ OCR/Image, chữ hoặc ảnh, tọa độ, input method và clipboard status.

Nếu đã click nhưng nhập lỗi/mất focus giữa chừng, kết quả ghi rõ click đã gửi và có thể đã nhập một phần (`clickSent: true`). Không mô tả trường hợp đó như bị chặn trước click. Quan sát nội dung trước khi test lại để tránh nhân đôi chữ. Action không tự thử lại, không tự tìm target khác và không tự gửi Publish.

Lưu ý: click vào nhãn nằm ngoài vùng nhập có thể không tạo caret. Kể cả nhận diện đúng và gửi input, engine vẫn không tự khẳng định chữ đã xuất hiện. Chọn lại ROI/đơn vị OCR hoặc image target nếu cần; giữ xác nhận thủ công.

## Bằng chứng fixture

- Typecheck, build, 15 unit tests: payload cần cả target lẫn text, hai input method, OCR cần chữ xác nhận, TYPE_ONLY cũ còn nguyên, Base/version/Override được bảo toàn.
- Electron phase `typing` có 11 nhóm checks, giữ 7 nhóm TYPE_ONLY trước và thêm 4 nhóm CLICK_AND_TYPE.
- Composer fixture được mở bằng click riêng và cố tình **không tự tạo caret**. Từ sidebar, chọn Action mới, crop ROI thật, OCR placeholder tiếng Việt, lưu và Test độc lập. Một click vùng nhập với detail=1, không dblclick, không replay nút mở composer; nhận đúng tiếng Việt, emoji, dòng trống; một screenshot duy nhất để nhận diện; browser/caret ở vùng nhập sau chạy.
- OCR + keyboard; OCR + clipboard với phục hồi clipboard; Image Matching qua Override + clipboard đều nhận đúng nội dung. Manual Đúng/Sai đổi trạng thái tương ứng; Redesign v2 giữ v1, Override giữ Base.
- Confidence thấp/chữ trùng/engine error được injection vào OCR trên ảnh có chữ thật. Kiểm tra đúng nguyên nhân BLOCKED, `clickSent=false`, không có input hoặc click mới, nội dung không đổi và editor tự mở Redesign; không tự lưu version.
- Hồi quy first/second/ux/ocr kiểm tra session, input, click/crop/zoom, window modes, version và manual review. Báo cáo máy `artifacts/browser-*.json`; ảnh ghép shell + native fixture `artifacts/click-and-type-review.png` (chụp theo yêu cầu của test, không phải screenshot tự động giữa click và nhập).

Facebook thật chưa được agent kiểm thử ở bản này; fixture không phải acceptance Facebook. Phím tắt vật lý và screenshot/focus khi ẩn view vẫn có giới hạn theo môi trường.

## Thử trên Facebook thật

1. `npm start`, mở Group bằng session local của bạn. Chạy CLICK_TARGET OCR mở composer như đã kiểm chứng ở phiên trước.
2. Quay về Creator, tạo Step mới, chọn **CLICK_AND_TYPE**. Điền bản nháp có tiếng Việt, emoji và xuống dòng; chọn Keyboard.
3. Chụp/crop placeholder hoặc chữ nằm **trong ô soạn thảo đang mở**. Chọn đúng dòng/từ OCR rồi chọn OCR matching, hoặc Image Matching khi thích hợp; lưu Base.
4. Bấm **Test step đã lưu** ngay từ sidebar. Không click tay vào ô nhập trước. Composer phải giữ mở; Action click vùng nhập một lần rồi gõ. Không dùng test cặp để chạy Action này.
5. Kiểm tra toàn bộ bản nháp. `ACTION_SENT` chưa đủ; chọn Đúng chỉ khi nội dung thực sự đúng, hoặc Sai để Redesign. Nếu BLOCKED do OCR, xác nhận không có click/nhập ngoài ý muốn và editor tự về Redesign.
6. Để thử Clipboard, lưu Redesign với method Clipboard paste. Đưa composer về trạng thái phù hợp bằng thao tác tay, tránh nhập lặp lên bản nháp cũ. Copy trước một nội dung dễ nhận biết; Test độc lập từ sidebar và kiểm tra nội dung clipboard cũ sau paste.
7. Thử mở lại v1, chạy Override và chuyển về Base. **Không Publish**. Nếu checkpoint/CAPTCHA, dừng để xử lý thủ công.
