# Scenario Groups và Workspace Tabs V1

## Phạm vi lưu dữ liệu

- Scenario Groups, membership và trạng thái thu gọn được lưu trong settings SQLite hiện có (`scenarioOrganization`). Không sửa Flow hoặc Step Version, không migration.
- Tabs và bản nháp Editor chỉ tồn tại trong lần mở ứng dụng hiện tại. Không autosave Step. Khi đóng/reload, các tab có thay đổi chưa lưu được hỏi lần lượt bằng confirm hiện có.
- Mỗi tab nhớ Flow ID, Session ID và URL; chỉ một BrowserCore/runtime được sử dụng. Website có thể tải lại khi chuyển tab; DOM, modal và scroll website không được giữ riêng theo tab.
- Cookie/partition vẫn do Browser Sessions hiện tại quản lý. Để xóa Session mà tab đang nhớ, đóng các tab đó trước.
- Chuyển tab bị chặn khi đang chạy Step/Play All, crop hoặc đọc OCR. Không thay đổi thuật toán OCR, matching, Actions hoặc execution engine.

## Kiểm tra thủ công (chưa chạy tự động)

1. Các Scenario cũ xuất hiện trong **Chưa phân nhóm**. Tạo/đổi tên/thu gọn Group, Move to Group, đóng/mở ứng dụng và kiểm tra metadata còn nguyên.
2. Xóa Group: các Scenario trở về Chưa phân nhóm; Step, Variables và Version còn nguyên.
3. Mở A và B; mở lại A không tạo tab trùng. Chuyển tab kiểm tra đúng Flow, Step List, Step đã chọn và Editor mở/đóng.
4. Sửa tên/Action/target form A chưa lưu → B → A: form còn nguyên, có dấu dirty, không tạo Version. Kiểm tra cả draft Step mới và draft OCR text đang sửa.
5. Đóng tab dirty (kể cả tab nền): kiểm tra **Lưu & đóng / Không lưu / Ở lại**, Esc/X. Thử Save bị validation từ chối: tab và draft phải còn.
6. Đóng tab sạch không hỏi; đóng tab cuối quay về Scenarios. Để tab nền dirty rồi đóng ứng dụng/reload: phải được hỏi trước khi thoát.
7. Chọn Session/URL khác nhau cho hai tab; chuyển qua lại kiểm tra Session, URL bar, Domain Tags và đăng nhập Facebook/WordPress giữ nguyên. Đổi Session ở Scenarios rồi mở lại tab cũ phải khôi phục Session của tab đó.
8. Chạy Step bằng nút và Ctrl+Shift+T trên từng tab; kiểm tra đúng Flow. Chạy Play All, thử chuyển/đóng tab trong Step và giữa các Step: Browser không được đổi context.
9. Kiểm tra Block/Skip, Step Groups, Sortable, Variables, Version và Network Mode như trước.
10. Kiểm tra màn lớn/nhỏ: tab Scenarios luôn truy cập được, header giữ 36px và Browser vẫn bắt đầu tại y=88; Settings/modal không bị Browser đè.

Không chạy test, build, typecheck, Electron, fixture hoặc điều khiển chuột trong quá trình triển khai theo yêu cầu.
