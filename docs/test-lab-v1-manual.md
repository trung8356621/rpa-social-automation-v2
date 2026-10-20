# UI fixes + Test Lab V1 — kiểm tra thủ công

## Phạm vi

- Main Tab duy nhất nhớ trang Scenarios / Browser Sessions / Test Lab / Settings vừa chọn; Creator và Case Tabs vẫn giữ riêng. Đóng tab workspace cuối quay về Main Tab.
- Steps giữ bên phải. Chỉ chỉnh độ rộng/sidebar scroll: tận dụng tối đa 420px khi có chỗ trống, giữ 320px khi Editor nằm cạnh. Không sửa geometry viewport Browser.
- Test Group, Test Case và Last Result lưu trong settings SQLite (`testLab`), không migration. Case Values khởi tạo từ Default Pattern, dùng validation Variables hiện có; không ghi Values trở lại Scenario.
- Case chạy bằng cùng `playSequential`, Runtime, Network snapshot và delay giữa Step như Creator Play All. Runtime chỉ thêm Flow snapshot riêng cho batch để resolve Values. Không sửa thuật toán Actions/matching/capture.
- Chờ main-frame Start URL tải thành công, tối đa 30 giây; lỗi HTTP/tải trang dừng trước Step. Đây không phải xác nhận SPA/website đã ổn định về nghiệp vụ. Không retry.
- `PASS` chỉ khi tất cả Result của Runtime là `VERIFIED`. Nếu có thao tác `ACTION_SENT`, Last Result vẫn là `ACTION_SENT`, cần kiểm tra website. BLOCKED/FAILED lưu tên/ID/Version Step và lý do nếu đã xác định Step.
- Mỗi Case chạy toàn bộ Base Version đã ghim của Scenario; không dùng draft, Override hoặc Block/Skip đang giữ trong bộ nhớ của tab Creator. Creator Play All giữ nguyên hành vi cũ.
- Sau lượt chạy, giữ Browser để quan sát; nút **Cấu hình Case** trở về Editor. Editor Scenario bị khóa trong chế độ Case.
- Tabs/draft chỉ giữ trong lần mở ứng dụng. Đóng/reload hỏi từng tab dirty, tái sử dụng confirm hiện có. Không autosave.
- Delete Scenario bị chặn nếu còn tab sử dụng hoặc Case tham chiếu (có số lượng). Xóa Flow, các Step/Version/Override thuộc riêng Flow và bản ghi runs liên quan trong transaction. Không xóa Step dùng chung hoặc Browser Sessions. Giữ các file target/evidence/log trên đĩa để tránh xóa nhầm tài nguyên dùng chung.
- Delete Case yêu cầu đóng tab Case trước. Session có Case tham chiếu cũng bị chặn xóa.

## Checklist

1. Chọn lần lượt bốn menu sidebar: Main Tab đổi tên/nội dung, không thêm tab; Creator Tabs cũ còn nguyên. Chuyển Creator rồi bấm Main Tab phải trở lại đúng menu gần nhất.
2. Resize cửa sổ lớn/nhỏ, mở/đóng Editor: Steps sát Browser bên phải, scroll tới Step cuối, không che Browser/Editor/Target Modal; viewport không đổi quy tắc.
3. Scenario menu → Delete: tên đúng, Hủy/Esc không xóa. Khi còn Creator tab (clean/dirty), phải chặn và giữ draft. Sau khi đóng tab, xóa Scenario thử nghiệm không dùng bởi Case; Scenario khác và Sessions còn nguyên.
4. Tạo/đổi tên/thu gọn Test Group; tạo hai Case trong cùng Group dùng Scenario khác nhau. Move to Group và xóa Group: Case về Chưa phân nhóm. Restart ứng dụng: dữ liệu còn nguyên.
5. Tạo Case A/B cùng Scenario nhưng Values khác. Lưu, mở lại và kiểm tra Values riêng; Default Pattern và Step Versions của Scenario không đổi. Thử Text, File/Files, Integer và Number (âm/vô hạn/sai kiểu theo validator hiện có).
6. Sửa Case A chưa lưu → Creator → Case B → A: draft còn. Mở Case đã có tab không tạo trùng. Đóng Case dirty: Lưu & đóng / Không lưu / Ở lại / Esc / X đúng; thử Save lỗi URL hoặc Variable: không đóng, không mất draft.
7. Để Case/Creator nền dirty rồi đóng/reload: được hỏi lần lượt, Save thất bại hoặc Ở lại giữ dữ liệu. Case đã Save không hỏi lại khi không thay đổi.
8. Chạy Case với đúng Session và Start URL; kiểm tra Values riêng được nhập vào website. Chạy lại dùng Start URL/config đã lưu. URL lỗi HTTP/không tải xong không gửi Step. Chỉ thực hiện trên website/kịch bản bạn chủ động cho phép.
9. Khi Case chạy và trong khoảng delay giữa Steps, thử đổi tab/menu/Session, đóng tab, Run Case khác: bị khóa. Không có Browser thứ hai, cookie Default và Session thử nghiệm giữ nguyên. Sau chạy chuyển Creator A: đúng Flow/Session/URL/draft A.
10. Tạo lỗi Variable/viewport/target: kiểm tra BLOCKED/FAILED, Step/Version/lý do. Kiểm tra `ACTION_SENT` không thành PASS; PASS không khẳng định nghiệp vụ website hoàn tất.
11. Tạo nhiều Case tham chiếu Scenario, thử Delete Scenario: hiển thị đúng số Case và chặn. Sửa/xóa Case trước rồi xóa Scenario. Thử xóa Session có Case tham chiếu: chặn.
12. Kiểm tra lại Creator Play Step, Ctrl+Shift+T, Play All, Group, Sortable, Block/Skip, Variables, Version, QUICK_TAG, SLEEP và Network Mode như trước.

Chưa chạy test, build, typecheck, Electron hoặc fixture; không điều khiển chuột theo yêu cầu.
