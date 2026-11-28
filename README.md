**Thông tin về webapp ContentPilot AI**

ContentPilot AI là ứng dụng quản lý nội dung tích hợp AI Agent, cho phép người dùng đăng nhập, quản lý dự án và bài viết trong workspace, giao nhiệm vụ thao tác dữ liệu thật cho AI và kiểm soát hành động xuất bản bằng cơ chế Human Approval (con người phê duyệt).
Trạng thái: M1–M4 đã triển khai trên môi trường Production và được kiểm thử thực tế. M5 (xuất bản Telegram/Discord) là định hướng phát triển tiếp theo, chưa triển khai.

Football News Control Center (tin bóng đá từ RSS, chấm điểm, chống trùng sự kiện, Temporary Auto Publish) là hướng phát triển riêng, **chưa nằm trong phạm vi đã xác minh trên Production ở trên**. Phần chống trùng sự kiện theo ngữ nghĩa (FN05) đã được squash merge vào `main` (PR #34, commit `44ebaf37`); Owner xác nhận migration và triển khai Production cho FN05 đã được xác minh. Tuy nhiên **chưa có bằng chứng kiểm chứng ngữ nghĩa trên bài báo thật**, và tại thời điểm kiểm tra release Temporary Auto Publish đang tắt. Human Approval vẫn là chế độ mặc định.

- Ứng dụng trực tuyến: https://contentpilot-social.vercel.app
- Mã nguồn: https://github.com/dorai4vn/contentpilot-ai
- Công nghệ: Next.js 16 (App Router, TypeScript, Tailwind CSS 4), Supabase (PostgreSQL, Authentication, Row Level Security), Vercel, Vitest và GitHub Actions.
- 
**1. Mục tiêu dự án**
  
ContentPilot AI minh họa cách xây dựng một ứng dụng AI Agent không chỉ trả lời hội thoại mà còn có thể thao tác với dữ liệu thực trong hệ thống. Các thao tác quan trọng được bảo vệ bằng xác thực người dùng, phân quyền theo workspace và quy trình yêu cầu phê duyệt.

**2. Tiến độ triển khai**
  
Giai đoạn	Chức năng	Trạng thái
- M1: Nền tảng	Đăng nhập/đăng ký, workspace, PostgreSQL, phân quyền RLS, API kiểm tra hệ thống	✅ Hoàn thành
- M2: Quản lý nội dung	Quản lý dự án, bài viết và các phiên bản nội dung	✅ Hoàn thành
- M3: AI Agent	AI đọc, tạo và cập nhật dữ liệu thật; ghi nhật ký hoạt động	✅ Hoàn thành
- M4: Human Approval	Tạo yêu cầu xuất bản, phê duyệt bởi Owner/Admin, chặn AI tự duyệt, ghi nhận kết quả	✅ Hoàn thành, đã kiểm thử trên Production
- M5: Xuất bản ra nền tảng ngoài	Telegram/Discord/Facebook/Instagram Publisher	📌 Định hướng tương lai, chưa nằm trong bài tập Capstone 2
- Football News Control Center (RSS thể thao, chấm điểm, Temporary Auto Publish)	Mã nguồn có trong repository; chưa được xác nhận độc lập là đã chạy gửi ngoài thật	🔧 Đang phát triển, không thuộc phần Production đã xác minh
- FN05: Khử trùng sự kiện theo ngữ nghĩa	Danh tính sự kiện, bằng chứng, chỉ duyệt thủ công cho ca không chắc chắn	✅ Đã merge và triển khai (Owner xác nhận); ⏳ chưa có bằng chứng kiểm chứng trên bài báo thật


**3. Các chức năng chính**

3.1. Xác thực và workspace
- Đăng ký, đăng nhập, đăng xuất qua Supabase Auth.
- Mỗi người dùng làm việc trong workspace và được phân quyền Owner, Admin hoặc Member.
- PostgreSQL và Row Level Security (RLS) giới hạn truy cập dữ liệu theo quyền thành viên.
- Tài khoản không có quyền không được xem hoặc thao tác dữ liệu của workspace khác.

3.2. Quản lý nội dung
- Tạo và quản lý dự án nội dung.
- Tạo, xem và chỉnh sửa bài viết.
- Lưu các phiên bản nội dung và theo dõi lịch sử thay đổi.

3.3. AI Agent thao tác dữ liệu thật
- AI Agent có khả năng thực hiện các thao tác với dữ liệu ứng dụng:
- Nhóm thao tác	Ý nghĩa	Ví dụ kiểm thử
- READ	Đọc dữ liệu được phép truy cập	Yêu cầu AI liệt kê dự án hoặc bài viết hiện có
- CREATE	Tạo bản ghi trong database	Yêu cầu AI tạo bài viết nháp mới
- UPDATE	Cập nhật bản ghi có sẵn	Yêu cầu AI sửa nội dung một bài viết


Các thao tác được thực hiện thông qua backend và cơ chế phân quyền của ứng dụng, không chỉ là nội dung trả lời giả lập. Hoạt động của Agent được ghi nhật ký để có thể kiểm tra.

**4. Human Approval — Phê duyệt trước khi xuất bản**

Quy trình:
- Người dùng hoặc AI Agent tạo yêu cầu xuất bản cho bài viết.
- Yêu cầu ở trạng thái Pending; bài viết chưa được xuất bản.
- Owner/Admin xem nội dung và chủ động Approve hoặc Reject.
- Với điểm xuất bản Internal, khi được phê duyệt, hệ thống ghi nhận bài viết đã xuất bản và tạo kết quả giao nội dung tương ứng.

**5. Log và history để kiểm tra.**

Giới hạn quan trọng: AI Agent được phép đề xuất hoặc tạo yêu cầu xuất bản, nhưng không được tự phê duyệt. Phạm vi M1–M4 đã xác minh chỉ hỗ trợ xuất bản nội bộ; chưa tự đăng lên Telegram, Discord hoặc Facebook. Việc gửi Telegram của Football News Control Center là hướng phát triển riêng (xem mục 10), mặc định vẫn qua Human Approval.

**4. Kết quả kiểm thử Production**

Các bước sau đã được thực hiện trên website thật:
- ✅ Triển khai đủ bốn migration của M4 và xác minh các bảng/ràng buộc cần thiết.
- ✅ Vercel Production triển khai thành công; đăng nhập hoạt động.
- ✅ Tạo yêu cầu xuất bản và thấy trạng thái Pending.
- ✅ Owner phê duyệt; yêu cầu chuyển Approved, bài viết chuyển Published.
- ✅ Bản ghi giao nội dung có trạng thái Succeeded; có sự kiện audit.
- ✅ AI Agent tự tạo được yêu cầu xuất bản Pending.
- ✅ Thử yêu cầu AI tự phê duyệt: hệ thống chặn thành công.
Đây là kết quả kiểm thử đã thực hiện cho bản triển khai hiện tại; không phải cam kết mọi tình huống hay mọi tài khoản đều đã được kiểm thử.

**5. Hướng dẫn thầy Phong đẹp trai check in webapp**

Bước 1 — Truy cập ứng dụng: Vào trình duyệt mở https://contentpilot-social.vercel.app

Bước 2 — Đăng nhập: sử dụng tài khoản demo do người nộp bài cung cấp riêng. Không đưa mật khẩu, API key hoặc token vào README công khai. Nếu được phép tự đăng ký, có thể tạo tài khoản mới; tài khoản mới không mặc nhiên có quyền vào workspace demo.

Bước 3 — Kiểm tra dữ liệu: mở workspace, xem dự án và các bài viết.

Bước 4 — Thử AI Agent: lần lượt yêu cầu Agent liệt kê bài viết (READ), tạo bản nháp (CREATE) và cập nhật bản nháp đó (UPDATE). Kiểm tra dữ liệu thay đổi thực tế sau khi tải lại trang.

Bước 5 — Thử Human Approval: yêu cầu Agent tạo yêu cầu xuất bản cho một bản nháp, xác nhận trạng thái Pending. Thử yêu cầu Agent tự phê duyệt để quan sát cơ chế từ chối.

Bước 6 — Duyệt bằng con người: đăng nhập tài khoản Owner/Admin được cấp quyền, mở yêu cầu đang chờ và bấm Approve. Xác nhận bài viết được xuất bản nội bộ và sự kiện được ghi nhận.
Lưu ý: Quyền Owner/Admin là bắt buộc để duyệt yêu cầu. Nên chuẩn bị tài khoản demo có sẵn workspace, ít nhất một bài viết nháp và quyền phù hợp. Không dùng dữ liệu cá nhân hay kênh xuất bản thật để demo.

**6. Kiến trúc và bảo mật**

Người dùng / AI Agent
         │
         ▼
Next.js (giao diện + server actions/API)
         │
         ▼
Supabase Auth + PostgreSQL + RLS
         │
         ├── Workspace / Projects / Posts / Versions
         ├── Agent Actions (nhật ký thao tác)
         └── Publish Requests (Pending)
                      │
                      ▼
               Owner/Admin duyệt
                      │
                      ▼
             Internal Delivery + Audit
Nguyên tắc bảo mật: xác thực người dùng ở backend; RLS theo workspace; các hành động nhạy cảm được kiểm soát bằng quyền Owner/Admin; AI không thể vượt qua bước phê duyệt; không lưu Supabase service-role key trong mã nguồn hoặc README.

**7. Chạy ứng dụng ở môi trường phát triển**

Yêu cầu: Node.js từ phiên bản 20.9 trở lên, npm và dự án Supabase (hoặc Docker để dùng Supabase Local).
npm install
cp .env.example .env.local

Điền các biến môi trường phù hợp trong .env.local
npm run dev

Mở http://localhost:3000. Để dựng schema database, áp dụng các file SQL trong supabase/migrations/ theo thứ tự tên file trên database thử nghiệm. Không chạy migration tùy tiện trên Production.

Các biến môi trường cần thiết và cách cấu hình chi tiết được mô tả trong .env.example và mã nguồn. Không commit .env.local hay secret lên GitHub.

**8. Kiểm thử và chất lượng**

Lệnh	Mục đích
- npm run lint	Kiểm tra quy tắc ESLint
- npm run typecheck	Kiểm tra kiểu TypeScript
- npm test	Chạy unit test
- npm run build	Build bản Production
- npm run check	Chạy bộ kiểm tra tổng hợp
- npm run test:db	Kiểm tra migration và bảo mật database trên môi trường thử nghiệm
- BASE_URL=... npm run test:e2e	Kiểm thử giao diện theo cấu hình của dự án


Workflow CI được lưu trong .github/workflows/. Cần cấu hình môi trường thử nghiệm và các biến phù hợp trước khi chạy các bài kiểm thử tích hợp.

**9. Triển khai**

Ứng dụng được triển khai bằng Vercel và sử dụng Supabase làm backend xác thực và database. Môi trường Production đã có M1–M4.
- Website: https://contentpilot-social.vercel.app
- API kiểm tra hệ thống: https://contentpilot-social.vercel.app/api/health
- GitHub: https://github.com/dorai4vn/contentpilot-ai

**10. Hướng phát triển tiếp theo**
Tính năng thử nghiệm RSS thể thao và xuất bản sau khi duyệt được mô tả trong [Tin thể thao từ RSS](docs/architecture/sports-news.md). Tóm tắt theo code hiện tại (chưa phải kết quả Production):

- Mỗi lượt chỉ xét bài xuất bản cùng ngày Asia/Dubai (bài có timestamp tương lai bị loại); mốc 48 giờ chỉ dùng làm lịch sử chống trùng.
- Điểm 0–10 theo barem mặc định 45/40/15 (độ nhận diện / tầm quan trọng / độ mới), ngưỡng mặc định 8, cấu hình riêng theo workspace/dự án; quyết định cũ không bị chấm lại âm thầm khi đổi cấu hình.
- Hạn mức mỗi lượt: tối đa 10 lần AI viết bản nháp (`SPORTS_NEWS_MAX_PER_RUN = 10`). Theo mặc định mọi bản nháp cần Owner/Admin duyệt đúng phiên bản; ngoại lệ duy nhất là bản đủ điều kiện trong cửa sổ Temporary Auto Publish đang hiệu lực (bullet kế tiếp).
- Temporary Auto Publish **không bật mặc định**: chỉ là cửa sổ có thời hạn do Owner/Admin chủ động bật, tối đa 8 giờ, tối đa 10 lần thử gửi mỗi lượt, 10 bài mỗi khoảng hai giờ và 40 bài mỗi cửa sổ; có thể tắt ngay. Tin chưa rõ danh tính, tin tiếp nối, tin không chắc chắn và tin được xét lại luôn chỉ duyệt thủ công, và cơ sở dữ liệu chặn chúng khỏi Auto Publish.
- Chế độ test có giới hạn riêng và không bao giờ vào Auto Publish.
- Chưa có xác nhận độc lập về việc gửi thật ra kênh ngoài hay kiểm chứng giấy phép ảnh; module kiểm chứng giấy phép ảnh và kiểm chứng sự thật của tin nằm ngoài phạm vi.

M5 — Telegram/Discord/Facebook/Instagram Publisher: thêm điểm xuất bản bên ngoài, lưu thông tin kết nối an toàn, worker xử lý hàng đợi, retry có kiểm soát, chống gửi trùng ở mức khả thi và nhật ký lỗi. Mặc định mọi hoạt động gửi ra nền tảng ngoài đi qua Human Approval M4; ngoại lệ hiện có duy nhất là cửa sổ Temporary Auto Publish có thời hạn của Football News (mục trên), M5 không mở rộng ngoại lệ này. Do bận đi kiếm tiền nên M5 tạm thời chưa thể triển khai trong phiên bản nộp bài này. Có thời gian em sẽ phát triển tiếp.
