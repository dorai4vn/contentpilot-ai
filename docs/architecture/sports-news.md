# Tin thể thao từ RSS

ContentPilot AI lấy tin thể thao từ Tuổi Trẻ và Thanh Niên. Mỗi lượt chỉ xét tin trong 48 giờ, bỏ qua URL hoặc tiêu đề chuẩn hóa đã xử lý trong cùng dự án. Điểm từ 0 đến 10 kết hợp độ nhận diện cao nhất của cầu thủ, đội hoặc giải (45%), tầm quan trọng của sự kiện (40%) và độ mới (15%). Mô hình ước lượng độ nhận diện theo độc giả Việt Nam. Điểm tự giảm khi tin cũ đi.

Với tin đạt ngưỡng mặc định 8/10, AI viết caption tiếng Việt từ tiêu đề và tóm tắt RSS. Caption có một dòng mở bài bắt mắt, các đoạn ngắn và emoji hợp ngữ cảnh. Hệ thống gắn link nguồn và tạo ảnh minh họa JPEG. Mỗi lượt xét tối đa tám tin và tạo tối đa hai bài. Tin dưới ngưỡng đã ghi nhận giữ quyết định cũ khi thay đổi ngưỡng.

Bài xuất hiện trong dự án dưới dạng bản nháp. Mỗi đích được cấu hình có một yêu cầu duyệt riêng. Màn hình duyệt hiển thị nội dung, đích, nguồn, điểm và ảnh của phiên bản đầu. Nếu người dùng sửa bài, yêu cầu cũ bị hủy. Người dùng có thể gửi lại yêu cầu từ trang bài viết. Phiên bản sửa chỉ gửi nội dung văn bản.

Owner/Admin phải duyệt từng yêu cầu. Worker gửi phiên bản đã duyệt đến từng đích vào lượt tiếp theo. Sau lỗi HTTP 429, worker thử lại tối đa ba lần với khoảng chờ tăng dần. Nếu kết quả gửi không rõ, màn hình duyệt báo cần kiểm tra trực tiếp trên kênh. Worker giữ nguyên bài đã duyệt và ghi mã bài do nền tảng trả về khi gửi thành công.

GitHub Actions gọi pipeline mỗi 2 giờ khi đã cấu hình. Khi bản tin có yêu cầu mới chờ duyệt, bot gửi một tin nhắn Telegram riêng gồm tiêu đề, độ hot và link mở từng yêu cầu. Nếu gửi lỗi, worker thử lại ở lượt kế tiếp khi yêu cầu vẫn còn hiệu lực.

## Cấu hình trên môi trường thử nghiệm

1. Áp dụng migration RSS lên Supabase thử nghiệm. Tạo một dự án nhận tin trong workspace đó.
2. Tạo một tài khoản Supabase Auth chuyên dụng, xác minh email và thêm tài khoản vào workspace với quyền **Member**. Đăng ký UUID tài khoản cho worker bằng SQL Editor của Supabase.

   ```sql
   insert into contentpilot_private.sports_news_workers (workspace_id, user_id)
   values ('<workspace-uuid>', '<worker-user-uuid>');
   ```

3. Tạo đích cho kênh hoặc trang thử nghiệm và lấy UUID của từng đích.

   ```sql
   insert into public.publishing_destinations (workspace_id, kind, name, target_ref)
   values
     ('<workspace-uuid>', 'telegram', 'Kênh Telegram thử nghiệm', '<numeric-chat-id>'),
     ('<workspace-uuid>', 'discord', 'Kênh Discord thử nghiệm', '<numeric-channel-id>'),
     ('<workspace-uuid>', 'facebook', 'Facebook Page thử nghiệm', '<numeric-page-id>')
   returning id, kind, name;
   ```

   - Telegram dùng bot token và ID số của kênh bắt đầu bằng `-100`. Bot phải có quyền đăng bài trên kênh.
   - Discord dùng bot token và ID số của kênh. Bot cần quyền xem kênh, gửi tin và đính kèm tệp.
   - Facebook dùng Page access token có quyền đăng trên Page, bao gồm `pages_manage_posts` và `pages_read_engagement` khi ứng dụng Meta yêu cầu. Đặt phiên bản Graph API phù hợp với ứng dụng và kiểm tra quyền ở chế độ triển khai tương ứng.

4. Cấu hình biến môi trường từ `.env.example` trên ứng dụng thử nghiệm. Dùng tài khoản OpenAI có quyền tạo ảnh cho `SPORTS_NEWS_IMAGE_MODEL`. `SPORTS_NEWS_SOCIAL_TOKENS` chứa cặp UUID đích và token tương ứng, ví dụ `{"<destination-uuid>":"<token>"}`. Chỉ đích có token mới được worker đề xuất và gửi. Để lưu bản nháp trước, dùng `{}`.
5. Để nhận thông báo, mở chat riêng của bot trên Telegram và bấm **Start**. Đặt token bot vào `SPORTS_NEWS_REVIEW_TELEGRAM_BOT_TOKEN`, ID số của chat riêng vào `SPORTS_NEWS_REVIEW_TELEGRAM_CHAT_ID` và địa chỉ HTTPS của ứng dụng vào `SPORTS_NEWS_REVIEW_SITE_ORIGIN`. Có thể dùng bot riêng cho thông báo.
6. Trong GitHub Actions, đặt biến `SPORTS_NEWS_CRON_URL` thành URL HTTPS của trang thử nghiệm cộng với `/api/cron/sports-news`. Đặt secret `SPORTS_NEWS_CRON_SECRET` có cùng giá trị với `CRON_SECRET` ở ứng dụng.
7. Chạy workflow **Sports news automation** thủ công hoặc gọi endpoint bằng POST với bearer token. Mở **Yêu cầu xuất bản**, duyệt bản tin và chạy một lượt nữa. Xác nhận bài có ảnh trên đúng kênh và trạng thái giao nội dung là **Đã xuất bản**. Lịch GitHub Actions chạy mỗi 2 giờ trên nhánh mặc định khi được cấu hình, có thể trễ tùy hàng đợi GitHub.
