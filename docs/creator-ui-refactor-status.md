# Creator: Editor dạng cột và chẩn đoán pointer

Branch `feature/creator-ui-refactor`; không merge main. Giữ nguyên thư mục untracked `rpa-social-automation-v2/`.

## Trạng thái xác nhận

**Lỗi click trên Facebook chưa được xác nhận đã sửa.** Chưa đủ bằng chứng để kết luận click mất ở Step List, Editor, Debug hay browser trên desktop người dùng. Không dùng kết quả synthetic `sendInputEvent` để tuyên bố native hit-testing đã đạt.

Phát hiện trong bài test cũ: `self-test.ts` gọi lại `addChildView(browser.view)`, đưa browser lên đầu stack, làm khác z-order production. Đã bỏ thao tác đó. Đây là lỗi trong kiểm thử, chưa phải bằng chứng về nguyên nhân click mất trên Facebook.

Kiểm tra tĩnh/bố cục cũ cho thấy Editor và Debug có bounds riêng trên browser; không che Step List theo bounds đã khai báo. Bản mới bỏ native Editor hoàn toàn: Editor nằm trong DOM shell, không có native surface vô hình của Editor phía trên Facebook. Chỉ Debug là native overlay trên browser.

## Bố cục mới

- Step List rộng 320 DIP. Nút Editor trên thanh danh sách mở/ẩn cột; mặc định ẩn, tạo/chọn Step sẽ mở.
- Editor là cột DOM x320/y88, rộng 352, cao 560 DIP.
- Browser khi ẩn Editor: x320/y88, 1024 × 560 DIP. Khi mở: x672/y88, 672 × 560 DIP. Giữ cùng webContents, session và zoom; không reload chủ động.
- Fullscreen/restore giữ hai chiều rộng chuẩn này. Debug bám đáy content window, x bắt đầu tại browser, không có lề đáy 8 DIP cũ.
- Debug mở cao 200 DIP; thu gọn native bounds xuống 36 DIP. Native background đục và bounds khớp panel. Mở/đóng Debug không đổi kích thước browser.

## ROI và chạy Step

Thay đổi chiều rộng có thể làm Facebook reflow. Không scale ROI hay đổi tọa độ target để đoán vị trí mới.

Target crop mới lưu `environment = {width,height,zoom}` từ đúng ảnh chụp; validate ROI trong kích thước ảnh đó. Target cũ không có metadata giữ môi trường 1024 × 560 tại zoom của flow. Version và Override giữ riêng môi trường target.

Runtime kiểm tra toàn bộ kế hoạch Visual Step trước capture/input (CLICK_TARGET, CLICK_AND_TYPE, UPLOAD_FILE, WAIT_VERIFY, kể cả Test cặp/Override). Khác viewport/zoom sẽ từ chối và báo chưa gửi input. UI có nút **Khôi phục viewport target** để người dùng chủ động mở/ẩn Editor. Có thể crop lại và lưu version mới thay thế. Không sửa thuật toán Browser Core, visual matching/OCR hay tọa độ click, không tạo browser/session khác.

## Kiểm thử hiện tại

Typecheck/build và 28/28 unit tests pass. Electron fixture hiện tại: creator-ui 7, first 27, restart 3, UX 16, OCR 8, typing 13, upload 8, address 14 — tổng 96 checks pass. Phase `first` vẫn partial với hai mục hạn chế/thủ công: capture khi ẩn view có thể timeout và Ctrl+Shift+T vật lý chưa xác nhận.

Đã tái hiện trong fixture một lỗi UI: nút Test dùng `position: sticky` che control khi cuộn Debug; click “Tạo Step tiếp theo” có thể chạy Test thêm (click-count 4 thay vì 3). Đã tách Test thành thanh cố định ngoài vùng cuộn, và kiểm tra `elementFromPoint` trong fixture để từ chối điểm click đang bị control khác che. Regression OCR/review/next-step đã pass, không còn click thừa. Fixture URL cũng được sửa để đợi URL đích trước khi kiểm tra navigation.

Sau khi được phép dừng phiên cũ, kiểm tra cho thấy PID 30400 và các Electron đã thoát; không cần dừng app live. Các fixture đã chạy trong phiên riêng. Native OS mouse fixture được thử nhưng không qua vì `SetCursorPos` thất bại trong automation desktop. Báo cáo `browser-creator-native.json` vẫn `incomplete`; đây không phải native hit-testing pass. **Lỗi click vật lý trên Facebook vẫn chưa xác nhận đã sửa**, cần bài thử Windows bên dưới.

[Ảnh UI hiện tại](images/creator-ui.png) ghép từ capture thật của shell, browser và Debug theo bounds, không phải screenshot desktop nguyên khối.

![Editor dạng cột và Debug sát đáy](images/creator-ui.png)

```powershell
Set-Location D:\workspace-2026\rpa\new
npm run typecheck
npm test
npm run test:browser
```

Sau khi đóng hẳn mọi Creator, trên desktop Windows đang mở khóa:

```powershell
npm run test:browser -- creator-native
```

Bài native dùng OS mouse vào Step List/Editor, Debug và button browser local nằm trong phần bounds được trả lại sau thu gọn. Không thao tác Facebook trong fixture. Báo cáo mới tại `artifacts/browser-*.json`, lỗi tại `artifacts/failure-*.txt`; kiểm tra timestamp mới, không dùng báo cáo cũ. Runner đặt báo cáo thành `incomplete` trước mỗi lần khởi chạy và chỉ nhận `passed`/`partial` mới, nên lỗi startup/lock không tái sử dụng kết quả pass cũ.

## Bài thử pointer ngắn trên Facebook

1. Thoát hẳn Creator cũ, chạy `npm run diagnose:pointer`, mở Group test. Không Publish. Editor ban đầu ẩn; browser phải rộng 1024, cao 560 DIP.
2. Click **+ Step mới**, thử Action/input trong cột Editor, click Step đã lưu. Kiểm tra cột mở cạnh Step List và browser rộng 672, cao 560, zoom không đổi. Click **Ẩn Editor**: browser trở về 1024; trang không reload.
3. Thu gọn Debug bằng −. Click ô nhập hoặc nút Facebook an toàn trong vùng vừa được trả lại, phía trên thanh Debug 36 DIP; thử cả vùng browser phía trên Debug. Mở lại Debug rồi thử nút của panel. Không click Publish để thử hit-testing.
4. Chọn Step cũ khi Editor mở và bấm Test: phải báo viewport không khớp, không gửi click/type/upload. Bấm **Khôi phục viewport target**, rồi Test lại. Thử target mới crop ở 672 và đóng Editor: cũng phải bị chặn cho tới khi mở đúng viewport.
5. Với viewport đúng, kiểm lại CLICK_TARGET → CLICK_AND_TYPE → UPLOAD_FILE, chờ preview thật rồi Đúng/Sai/Redesign; kiểm lại Base version/Override. Thử F11/restore: height/zoom không đổi, Debug sát đáy và vùng browser không bị che còn tương tác.
6. Ghi click nào không nhận và thời điểm. Đọc `D:\workspace-2026\rpa\new\.local\creator\pointer-routing.jsonl`. Cần xác nhận vật lý từ người dùng trước khi đóng lỗi này.

Log chỉ bật khi `--pointer-trace`: native mouseDown/up của shell/browser/debug; DOM pointer/click chỉ trong UI shell/Debug; command type, webContents ID, focus/route, native bounds/visibility, cursor và thứ tự stack. Không chèn script vào Facebook, không ghi nội dung nhập hay đường dẫn file upload.

Cách đọc: `expected` là view dự kiến theo cursor và bounds; `view` là nơi thực nhận native event. Click trong Step List/Editor phải đến shell, nút Debug đến debug, vùng Facebook không bị che đến browser. Có native event nhưng thiếu DOM click ở UI: kiểm tra chuỗi pointer/disabled/render; có DOM click nhưng không có command tương ứng: kiểm tra handler/UI state. Nếu `expected=browser` nhưng `view=debug` sau thu gọn, đính kèm dòng log có bounds và stack. Nếu không view nào nhận event, ghi nhận là chưa tới webContents, không quy lỗi cho OCR/runtime.
