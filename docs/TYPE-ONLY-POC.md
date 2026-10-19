# TYPE_ONLY — contenteditable, keyboard và clipboard

## Thay đổi

`webContents.isFocused()` chỉ là tín hiệu focus của native browser view; nó không chứng minh editor của website có caret. Chẩn đoán mới ghi riêng `browser`, `editor` (sidebar), route tương tác gần nhất và **caret: unknown**. Khi focus native trả false nhưng cửa sổ đang active, sidebar không focus và input vẫn được route vào browser, runtime không từ chối chỉ vì một cờ native. Nếu sidebar/cửa sổ khác giữ focus hoặc không có bằng chứng route browser, TYPE_ONLY bị BLOCKED với chẩn đoán cụ thể. Không dùng DOM/AX tree/pseudo-DOM để tìm hoặc tạo caret.

TYPE_ONLY không click, không gọi focus, không tìm target khác. CLICK trước đó hoặc thao tác tay phải thực sự đặt caret. Khi chỉ mở composer mà website không tự focus ô nhập, cần một CLICK_TARGET riêng vào vùng nhập trước TYPE; không lén thêm click trong TYPE_ONLY. Nếu focus mất giữa quá trình nhập, có thể đã có một phần nội dung: quan sát bản nháp trước khi thử lại, tránh nhân đôi chữ.

## Test hai Step

Trong flow, lưu hai Step Base liên tiếp: **CLICK_TARGET → TYPE_ONLY**. Chọn Step TYPE đã lưu sẽ thấy `Test 2 Step · CLICK → TYPE (Base)` và thời gian chờ sau click (mặc định 800ms, tối đa 10s). Test dùng các version đang ghim của hai Step; Override không áp dụng trong cặp POC này. CLICK nhận diện và click thật, rồi TYPE chạy trong cùng runtime/lock, không về sidebar, không screenshot hay callback UI giữa hai Step. Nếu CLICK bị BLOCKED/FAILED thì không chạy TYPE. Delay chỉ chờ giao diện, không chứng minh caret sẵn sàng.

TYPE vẫn test đơn bằng phím tắt sau khi người dùng click thủ công ô nhập. Nút Test đơn trên sidebar có thể lấy focus và bị BLOCKED; đây không phải bằng chứng Facebook không nhận được bàn phím.

## Hai phương thức đã triển khai

- **Keyboard · native text + Shift+Enter**: CDP `Input.dispatchKeyEvent` type char theo Unicode code point trên chính WebContentsView (không có browser khác). Các dòng mới gửi chuỗi sự kiện keyDown/char/keyUp với Shift+Enter. Không gán DOM value, không executeJavaScript để nhập, không tự đổi caret. CRLF/CR chuẩn hóa thành LF. Đây là keyboard text dispatch, không giả lập physical keyDown/keyUp cho từng chữ và không cam kết giống IME vật lý.
- **Clipboard paste**: đọc/materialize snapshot mọi MIME format mà Electron cung cấp, giữ trong RAM; clipboard tạm chỉ chứa bản nháp dạng text; gọi native `webContents.paste()`. Chờ 500ms cho lệnh paste bất đồng bộ, sau đó so fingerprint clipboard hiện tại với bản tạm. Chỉ khôi phục snapshot cũ nếu clipboard chưa đổi. Nếu người dùng/app khác copy trong lúc paste, giữ bản mới và báo `changed`. Nếu không đọc/khôi phục được, báo lỗi hoặc `restore_failed`; không cố ghi đè khi không xác định ownership. Không lưu clipboard cũ vào DB/log/Git. Đây là best effort: clipboard Windows không có compare-and-swap; app thoát/crash hoặc paste rất chậm không bảo đảm phục hồi/đọc kịp. Các định dạng OS không được Electron cung cấp không thể cam kết giữ nguyên.

Không tự fallback giữa hai phương thức. Chọn method trong TYPE editor và **lưu Base/Redesign** trước khi test; method đã dùng và chẩn đoán hiển thị trong kết quả. Payload cũ không có method mặc định keyboard, version cũ và Override không bị ghi đè.

CLICK_TARGET và TYPE_ONLY không tự chụp ảnh sau input để giữ browser/caret. Ảnh debug chụp theo yêu cầu có thể làm mất native focus; trước lần TYPE tiếp theo click thủ công vùng nhập nếu cần.

## Trạng thái

Gửi keyboard hoặc native paste chỉ trả **ACTION_SENT**, kể cả khi website bỏ qua input do chưa có caret. Không tự suy ra chữ đã xuất hiện hoặc `VERIFIED`. Sau khi quan sát đúng nội dung, dấu, emoji và dòng trống, chọn Đúng để xác nhận đúng lần test TYPE; hoặc dùng WAIT/VERIFY riêng. Chọn Sai mở Redesign của Step tương ứng, Base giữ nguyên đến khi lưu version mới.

## Bằng chứng fixture

`node scripts/browser-test.mjs typing` mở Electron thật với session local riêng và fixture contenteditable. Chỉ đọc DOM trong test để đo kết quả; chữ/caret không được gán bằng test injection. Fixture tự mở editor/focus như phản hồi của website sau click. Đã kiểm chứng:

- Test cặp qua UI: click mở editor sau delay, keyboard nhập đúng `Nháp tiếng Việt: Đặng Thị Ánh 👋🏽🚀`, English, nhiều dòng và dòng trống; input trusted; native focus vẫn trong browser. Chỉ một screenshot cho nhận diện CLICK, không screenshot giữa hai Step/sau TYPE.
- Native paste tạo paste/input thật và nhận đúng cùng nội dung. Kiểm tra snapshot text, HTML, custom MIME và pixel ảnh PNG được phục hồi.
- Native focus được mock false trong khi route/caret thật vẫn ở browser: TYPE không bị từ chối chỉ vì cờ đó; sidebar focus thật thì bị chặn, không auto focus/click.
- Composer mở nhưng không có caret: TYPE không tự chọn editor, không có chữ và vẫn chỉ ACTION_SENT; cần xác nhận/VERIFY.
- CLICK không khớp thì cặp dừng trước TYPE; từ chối thứ tự không hợp lệ. TYPE chỉ VERIFIED sau explicit review.
- Unit tests bổ sung cho phục hồi clipboard, exception, concurrent copy, mất focus, snapshot/restore failure và ownership không rõ. Hồi quy first/second/ux/ocr kiểm tra session, version, Override, click/crop, zoom/window modes và manual review.

Các lỗi đã phát hiện và xử lý khi thử: Enter keyDown/keyUp đơn thuần chưa tạo dòng mới; Enter thường tạo lệch dòng trống trên contenteditable nên chuyển Shift+Enter. Thử `webContents.insertText` đã gây nhập vào editable cũ sau khi focus chuyển sang nút trong hồi quy zoom; implementation cuối dùng keyboard dispatch và đã kiểm tra lại ca đó. Lệnh CDP char không nhận cả dòng dài, nên gửi từng code point. Không giữ các cách nhập lỗi làm fallback.

Report máy: `artifacts/browser-typing.json`; ảnh ghép shell + native browser fixture: `artifacts/typing-native-review.png`. Ảnh này do test yêu cầu, không phải screenshot tự động của runtime TYPE. Phím tắt Ctrl+Shift+T bằng bàn phím vật lý và focus/screenshot khi ẩn view vẫn cần kiểm tra theo môi trường.

## Facebook thật — cần người dùng kiểm tra

Agent chưa kiểm thử bản sửa trên composer Facebook có đăng nhập; toàn bộ bằng chứng ở trên là fixture. Không có phiên Facebook live được dùng trong bài test tự động.

1. `npm start`, mở Group bằng session local của bạn. Đóng composer/bản nháp thử trước để bắt đầu đúng trạng thái.
2. Lưu CLICK_TARGET OCR mở composer, rồi lưu TYPE_ONLY ngay sau với nội dung có dấu, emoji, xuống dòng và dòng trống. Chọn Keyboard và lưu.
3. Ở Step TYPE, bấm `Test 2 Step · CLICK → TYPE (Base)`. Nếu composer render chậm, tăng delay. Quan sát chữ thật, kiểm tra không nhập lặp, không Publish. `ACTION_SENT` không phải acceptance; chỉ chọn Đúng khi chữ đúng.
4. Nếu composer mở nhưng không có caret/chữ: **không retry mù**. Tạo CLICK_TARGET riêng vào ô nhập, đặt ngay trước TYPE, rồi test cặp đó khi composer đang mở. TYPE không tự bổ sung bước focus.
5. Để thử clipboard, lưu Redesign TYPE với Clipboard paste. Copy trước một nội dung dễ kiểm tra vào clipboard, đưa trang về đúng trạng thái rồi test cặp. Kiểm tra chữ/dòng/emoji trên Facebook và paste clipboard sau test vào ứng dụng khác để xác nhận nội dung cũ còn nguyên. Không copy nội dung khác trong 500ms paste nếu muốn kiểm tra nhánh restore.
6. Để test TYPE đơn: click thủ công ô nhập, nhấn Ctrl+Shift+T rồi thả các phím; không bấm nút Test sidebar sau khi đặt caret. Nếu bị BLOCKED, ghi message và các trường browser/editor/route/caret cùng method, version và ảnh hiện tại.
7. Chỉ xác nhận Đúng hoặc chạy VERIFY riêng sau khi quan sát; chọn Sai để Redesign nếu lỗi. Không Publish; gặp checkpoint thì dừng xử lý thủ công.

Tham khảo API chính thức: [Electron webContents](https://www.electronjs.org/docs/latest/api/web-contents/), [Electron Clipboard](https://www.electronjs.org/docs/latest/api/clipboard), [CDP Input.dispatchKeyEvent](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchKeyEvent).
