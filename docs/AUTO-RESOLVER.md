# AUTO Visual Target Resolver

Quyết định này thay lựa chọn Image/OCR thủ công trong các tài liệu POC trước. Không thay đổi Action-first, CLICK_AND_TYPE, TYPE_ONLY, Step Version hay Base/Override.

## Cách dùng

Creator không còn menu chọn Image/OCR. Crop target, tùy chọn xác nhận một dòng/từ OCR làm dữ liệu dự phòng, lưu Action/target rồi Test. Resolver tự chọn phương thức cho mỗi lần chạy; **không lưu Redesign/version mới chỉ vì engine đổi phương thức**. Target không có chữ vẫn dùng ảnh bình thường. Nếu thêm/sửa ảnh, chữ xác nhận, nội dung hoặc Action thì đó là thay đổi thiết kế và vẫn lưu version như trước.

Runtime áp dụng AUTO cả khi payload cũ có `method: image` hoặc `method: ocr`, và cả khi không có field method. Hint cũ được giữ nguyên trong SQLite/Base/Override và ghi trong Debug; không có migration hay ghi lại version. Payload mới từ editor ghi `method: auto`. Các version và lịch sử runs cũ không bị sửa.

## Thứ tự và điều kiện an toàn

1. Image Matching chạy trên screenshot hiện tại trong ROI ±64 DIP. Ảnh phải đạt score ≥max(0.96, threshold đã lưu), không ambiguous. Score ảnh không phải xác suất đúng.
2. Khi ảnh chưa đủ tin cậy, thử OCR **chỉ với chữ user đã xác nhận**. Giữ khớp chính xác NFC/khoảng trắng/hoa-thường, giữ dấu Việt; cần một vị trí duy nhất và confidence ≥80, bounding box nằm trong vùng tìm. Không có chữ xác nhận hoặc OCR thất bại thì không bịa target.
3. Khi ảnh đủ rõ và có chữ xác nhận, OCR được đọc để đối chiếu an toàn trên **cùng screenshot**. OCR không đọc được/thiếu chữ/confidence thấp không phủ định ảnh rõ; engine vẫn chọn ảnh. Đây không phải fallback sang OCR và không bắt user đổi method để cứu một ảnh đã khớp.
4. Image có nhiều vị trí gần tương đương: chặn ngay, không dùng OCR để bỏ qua ambiguity ảnh. OCR có nhiều vị trí cùng chữ: chặn, kể cả ảnh có vẻ rõ. Cần crop target đặc trưng/hẹp hơn.
5. Nếu cả hai có bằng chứng vị trí đáng kể, so vị trí OCR mới với anchor chữ đã lưu được dịch theo vị trí ảnh. Không so tâm chữ với tâm toàn ROI vì hai tâm đó có thể khác nhau ngay từ thiết kế. Với image score ≥0.94, chênh anchor quá max(12 DIP, 25% kích thước bbox chữ) theo một trục là mâu thuẫn và bị chặn. Candidate ảnh yếu hơn 0.94 không đủ làm bằng chứng mâu thuẫn; OCR duy nhất/đủ tin cậy có thể làm fallback.
6. Resolver chỉ trả vị trí cuối cùng hoặc lỗi BLOCKED; không có click trong resolver. Runtime gọi `BrowserCore.click` đúng **một lần** sau khi resolve xong. CLICK_AND_TYPE sau đó nhập ngay trong cùng runtime. Không click thử, không đổi tọa độ và click lại, không trộn/trung bình tọa độ hai engine.

Quy tắc ambiguity cố ý thận trọng: có thể cần Redesign ROI khi nhãn xuất hiện nhiều lần trong vùng tìm. Chưa tìm toàn trang hay chứng nhận đúng ngữ nghĩa nghiệp vụ; vẫn phải quan sát và xác nhận/VERIFY.

## Debug và kết quả

UI thường chỉ hiển thị trạng thái/action và hướng dẫn xác nhận. Mục **Debug** mặc định đóng chứa phương thức thực chọn, Image score, OCR confidence, tọa độ, lý do fallback/chặn, các lần thử và hint method cũ nếu có. Hình ảnh target đã dùng và chẩn đoán input/focus/clipboard cũng nằm trong Debug.

`resolution` được lưu cùng run metadata trong SQLite và JSON local dưới `.local/`, không ghi vào Step. Ví dụ: image score thấp → OCR matched 95% → selectedMethod=ocr; hoặc image matched → OCR không đọc được → selectedMethod=image; hoặc hai vị trí mâu thuẫn → BLOCKED, clickSent=false. UI không trình bày ACTION_SENT thành business PASS. CLICK/CLICK_AND_TYPE chỉ VERIFIED sau xác nhận đúng hoặc điều kiện VERIFY riêng; engine đổi phương pháp không phải lý do tạo version.

## Kiểm chứng tự động

- Typecheck/build và 20 unit tests, gồm Image thắng, OCR không đọc được nhưng Image rõ vẫn dùng được, OCR fallback với lý do/confidence, cả hai thất bại, thiếu OCR xác nhận, confidence thấp, ảnh trùng, chữ trùng, hai phương pháp mâu thuẫn và legacy method không thay Base/version/Override.
- Fixture Electron contenteditable kiểm tra cùng Step v1: ảnh gốc chọn Image; đổi màu vùng nhập khiến ảnh yếu → OCR fallback thành công, đúng nội dung và **một click**, không save/version mới. Không còn menu method; Debug mặc định đóng, mở mới thấy trace.
- Fixture inject confidence thấp, duplicate và OCR error trên ảnh đã đổi màu: cả hai phương thức không dùng được hoặc ambiguous thì không có click/input. Inject OCR dịch vị trí trong khi ảnh vẫn khớp: BLOCKED trước click/input. CLICK_AND_TYPE keyboard/clipboard, manual review và Override vẫn được hồi quy.
- Các phase first/second/ux/ocr/typing chạy Electron thật, dùng session test riêng. Report: `artifacts/browser-*.json`; dữ liệu/ảnh/log bị Git ignore. Không xem fixture là Facebook acceptance.

## Thử lại Facebook

1. `npm start`, mở composer bằng Step CLICK_TARGET đã có. Chọn Step CLICK_AND_TYPE đã lưu — kể cả bản trước ghi method OCR. **Không cần Redesign để đổi phương pháp.**
2. Test từ sidebar khi composer đang mở và target còn hiển thị. Nếu ảnh khớp rõ dù OCR không tìm chữ, Action vẫn click vùng nhập một lần rồi gõ. Quan sát nội dung, không Publish; chỉ chọn Đúng sau khi bản nháp đúng.
3. Mở Debug: kiểm tra selected method, score/confidence, OCR đối chiếu và lý do fallback nếu có. Đóng Debug để quay lại giao diện xác nhận gọn.
4. Nếu giao diện thay đổi khiến ảnh yếu nhưng chữ đã xác nhận còn đọc được, test cùng Step/version; Debug phải ghi OCR fallback. Không tạo version chỉ vì fallback. Không cố thay đổi giao diện Facebook bằng code để ép ca này; fixture đã kiểm chứng nhánh đó.
5. Nếu thiếu chữ dự phòng, có thể crop/xác nhận chữ rồi lưu Redesign vì **target data thay đổi**. Không tự chọn tất cả chữ.
6. Với nhãn trùng/mâu thuẫn hoặc cả hai thất bại: phải BLOCKED trước click/nhập. CLICK_AND_TYPE tự mở Redesign; sửa ROI rõ hơn, không retry mù hay nhập lặp lên bản nháp cũ.
7. Thử mở Base version cũ và Override; xác nhận dữ liệu còn nguyên. Đưa composer về đúng trạng thái trước mỗi lần test; không Publish, gặp checkpoint thì dừng xử lý thủ công.

AUTO Facebook ở bản này chưa được agent kiểm thử trực tiếp. Người dùng đã báo Image Matching nhập được trên Facebook ở bản trước; đó là bằng chứng cho bản trước, không phải xác nhận AUTO mới.
