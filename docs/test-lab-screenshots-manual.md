# Test Lab UI, execution và screenshot

## Thay đổi

- Danh sách Group → Case gọn, có cột tên, Scenario, Session, Last Result, Run, Chi tiết và menu. URL/Variables nằm trong chi tiết; CRUD/Move to Group giữ nguyên.
- Run từ danh sách, Editor và Run Again đều mở/focus tab Case hiện có rồi gọi cùng `runTestCase` → `playSequential` → Runtime. Không tạo Case/Browser/engine mới. Case có draft chưa lưu phải lưu hoặc bỏ draft trước khi chạy.
- Mỗi Run có UUID riêng, snapshot tên/ID Case, Scenario, Session, Start URL, thời gian, trạng thái và các Step Version đã lưu. Values riêng vẫn chỉ dùng cho batch; không ghi Default Pattern.
- RUNNING cập nhật theo Step; lỗi mới dùng ERROR, BLOCKED giữ nguyên; Step chưa thực thi sau khi dừng được ghi SKIPPED. Case rỗng là SKIPPED. FAILED cũ vẫn đọc và hiển thị ERROR. PASS yêu cầu Runtime trả VERIFIED; ACTION_SENT vẫn hiển thị riêng, không khẳng định hoàn tất nghiệp vụ website.
- Start URL chờ main-frame load thành công, tối đa 30 giây. Sau đó kiểm tra Values trước khi gửi bất kỳ Step nào. Không kiểm tra login/DOM hoặc tự retry.

## Ảnh và lưu trữ

- Dùng `browser.view.webContents.capturePage()` của Electron, chỉ chụp nội dung Browser đang test. Không đổi Target Capture/OCR/Actions, không chụp desktop, không upload.
- Lỗi Step: chụp ngay khi Runtime trả kết quả lỗi/throw, trước progress kết thúc, cleanup hoặc thay Browser. Thành công: chờ thêm tối đa 500ms từ Step Delay snapshot hiện có rồi chụp trước khi kết thúc batch. Không thay Settings hay timing thực thi Step.
- Lưu local tại `.local/creator/test-runs/<case-id>/<run-id>/final.png` và `metadata.json`. DB chỉ lưu metadata/đường dẫn tương đối, không base64. Data URL chỉ dùng tạm để hiển thị ảnh qua IPC, không ghi log.
- Mỗi Run ghi file mới qua file tạm rồi rename. Chỉ sau khi lưu Last Result mới dọn ảnh cũ; giữ lượt mới nhất và một lượt trước mỗi Case. Chỉ dọn các file tên đã biết trong thư mục UUID của kho Test Run; bỏ qua thư mục có nội dung lạ. Xóa Case đã xác nhận dọn evidence thuộc Case đó; đóng tab không xóa ảnh.
- Chi tiết/Last Result có ảnh thu nhỏ, click mở lớn bằng UiPopover hiện có, Run Again và danh sách trạng thái Steps. Mở lại ứng dụng vẫn đọc ảnh local của Last Result.
- Lỗi chụp/lưu ảnh được ghi riêng, không thay status hoặc lý do lỗi chính. Nếu không mở được đúng Session/Scenario, không chụp Browser của workspace khác: Last Result giải thích vì sao không có ảnh. Các Run cũ không được tạo ảnh hồi tố.
- Nếu tiến trình bị dừng giữa chừng, RUNNING cũ chuyển ERROR khi mở lại, giữ cấu hình và ảnh đã lưu nếu có; không thể bảo đảm ảnh cuối khi hệ điều hành đóng cưỡng bức.

## Checklist thủ công

1. Tạo/mở Case đã lưu. Danh sách không chứa URL/Variables/ảnh lớn, Group collapse/CRUD/Move vẫn hoạt động.
2. Bấm Run ngay từ hàng Case, kiểm tra tab không trùng, đúng Session/Start URL, Saved Versions và Values Case; Scenario Default Pattern không đổi.
3. Quan sát từng Step RUNNING → PASS/ACTION_SENT; khi lỗi có BLOCKED/ERROR, đúng tên/ID/Version Step và các Step chưa chạy là SKIPPED. Thử Scenario rỗng.
4. Dùng Case có Step Runtime xác nhận VERIFIED: kết thúc PASS, có ảnh sau Step cuối, thời điểm/path đúng Run ID. Click ảnh phóng lớn rồi đóng bằng X/Esc; Browser không bị hide/reload bởi viewer.
5. Tạo lỗi target/viewport/Variable: kiểm tra dừng, ảnh đúng Browser lúc lỗi, lý do chính còn nguyên. URL tải lỗi không gửi Step, có ảnh trang lỗi nếu đã mở đúng Session.
6. Nếu thử lỗi quyền ghi ảnh/API chụp, kiểm tra status/lý do Runtime vẫn giữ, có cảnh báo ảnh riêng; không dùng ảnh cũ gắn nhầm Run mới.
7. Run Again nhiều lần: Case ID/số lượng Case không đổi, Run ID/ảnh mới riêng. Kiểm tra thư mục chỉ giữ tối đa hai lượt đã ghi xong mỗi Case; ảnh cũ không bị ghi đè trong lúc lượt mới đang ghi.
8. Đóng tab, đóng/mở ứng dụng → từ Test Lab mở Chi tiết: Last Result/ảnh gần nhất còn và xem lớn được. Thử đọc Case cũ chưa có ảnh.
9. Trong Run và trong lúc chụp/lưu ảnh, thử chuyển tab/Session/menu/chạy Case khác: khóa một Browser. Xong quay lại Creator A kiểm tra draft/Session/URL A giữ nguyên, Play All thông thường vẫn hoạt động.

Chỉ rà source/diff; không chạy test/build/typecheck/Electron/fixture và không điều khiển chuột theo yêu cầu.
