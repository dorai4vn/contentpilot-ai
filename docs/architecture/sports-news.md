# Tin thể thao từ RSS

ContentPilot AI lấy RSS từ Bóng Đá 24h, BongDa.com.vn và các chuyên mục bóng đá của Thể Thao 247. Tuổi Trẻ và Thanh Niên là nguồn bổ sung. Mỗi lượt chỉ xét tin trong 48 giờ, bỏ qua URL hoặc tiêu đề chuẩn hóa đã xử lý trong cùng dự án. Điểm từ 0 đến 10 kết hợp độ phổ biến cao nhất của cầu thủ, đội hoặc giải (30%), tầm quan trọng của sự kiện (25%), độ mới theo giờ đăng nguồn (25%) và tiềm năng thảo luận/chia sẻ vốn có của nội dung (engagement, 20%). Mỗi lượt quét chọn tối đa 3 tin. Mô hình ước lượng độ nhận diện theo độc giả Việt Nam. Điểm tự giảm khi tin cũ đi.

Barem `sports-v2` (cấu hình cũ giữ nguyên trọng số với engagement 0) được dùng lại giữa các lượt. Độ nhận diện lấy điểm cao nhất trong ba mục cầu thủ, đội và giải. Sự kiện từ 9–10 là chung kết, chức vô địch hoặc kết quả lớn; 6–8 là diễn biến đáng chú ý; 0–5 là tin thường kỳ hoặc đồn đoán. Độ mới bắt đầu ở 10 điểm, giảm 1 điểm mỗi 4,8 giờ.

Tin được đưa vào chấm theo thứ tự Ngoại hạng Anh → Cúp C1 → các giải lớn như World Cup, EURO, Copa América và các giải VĐQG lớn châu Âu → bóng đá Việt Nam → bóng đá khác → môn khác. Khi chọn bài, xếp theo điểm tổng trước. Ưu tiên giải đấu và sau đó là độ mới để phân định khi bằng điểm. Nếu không có tin từ ngưỡng trở lên, hệ thống chọn đúng một tin có điểm cao nhất và ghi rõ lý do chọn trong yêu cầu duyệt.

Với tin được chọn, AI viết caption tiếng Việt từ tiêu đề và tóm tắt RSS. Caption có tiêu đề ngắn, bắt mắt và emoji mở đầu mỗi đoạn, với giọng văn gần gũi trên mạng xã hội. Link bài báo hiển thị trong màn hình duyệt. Hệ thống tìm ảnh JPEG tư liệu phù hợp trên Wikimedia Commons, ưu tiên ảnh đúng hai đội và ngày. Nếu thiếu, thử ảnh hai đội từng gặp hoặc ảnh thi đấu của một đội, lưu trạng thái ảnh tư liệu trong dữ liệu nội bộ. Bỏ qua ảnh sân vận động chung và chỉ dùng giấy phép CC0 hoặc Public Domain đã xác minh. Nguồn ảnh và giấy phép được lưu nội bộ, caption công khai chỉ chứa nội dung bài. Khi không có ảnh phù hợp, bài chỉ có caption. Mỗi lượt xét tối đa tám tin và tạo tối đa hai bài. Mỗi tin đã có quyết định lưu phiên bản barem, điểm thành phần, lý do AI, ngưỡng và kết quả chọn. Tin dưới ngưỡng đã ghi nhận giữ quyết định cũ khi thay đổi ngưỡng. Tin đạt ngưỡng nhưng vượt giới hạn hai bài được xét lại ở lượt sau.

Ảnh được crop tự động thành JPEG vuông 1080 × 1080 cho màn hình duyệt và khi gửi. Telegram và Discord in đậm dòng tiêu đề. Facebook Page dùng tiêu đề dạng văn bản thường. Bài xuất hiện trong dự án dưới dạng bản nháp. Mỗi đích được cấu hình có một yêu cầu duyệt riêng. Màn hình duyệt hiển thị nội dung, đích, nguồn, điểm và ảnh của đúng phiên bản xin duyệt. Nếu người dùng sửa bài, yêu cầu cũ bị hủy. Người dùng có thể gửi lại yêu cầu từ trang bài viết. Phiên bản sửa gửi ảnh nếu có ảnh gắn riêng với phiên bản đó.

Owner/Admin phải duyệt từng yêu cầu. Worker gửi phiên bản đã duyệt đến từng đích vào lượt tiếp theo. Sau lỗi HTTP 429, worker thử lại tối đa ba lần với khoảng chờ tăng dần. Nếu kết quả gửi không rõ, màn hình duyệt báo cần kiểm tra trực tiếp trên kênh. Worker giữ nguyên bài đã duyệt và ghi mã bài do nền tảng trả về khi gửi thành công.

Production dùng Supabase Cron để gọi pipeline mỗi 2 giờ. GitHub Actions là một cách đặt lịch cho môi trường thử nghiệm. Worker chỉ xét và gửi tin được xuất bản cùng ngày theo múi giờ Asia/Dubai. Tin đã duyệt nhưng qua ngày trước khi gửi sẽ được bỏ qua. Khi bản tin có yêu cầu mới chờ duyệt, bot gửi một tin nhắn Telegram riêng gồm tiêu đề, độ hot và link mở từng yêu cầu. Nếu gửi lỗi, worker thử lại ở lượt kế tiếp khi yêu cầu vẫn còn hiệu lực.

## Khôi phục lịch production

Production dùng Supabase Cron và `pg_net`. Trên Vercel Production, lưu bearer vào `CRON_SECRET`. Trong Supabase Vault, lưu cùng giá trị dưới tên `contentpilot_sports_news_cron_bearer`. Sau khi migration, worker, đích Telegram và biến môi trường đã sẵn sàng, đăng ký lịch sau bằng SQL Editor:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.schedule('contentpilot-sports-news', '0 */2 * * *', $job$
  select net.http_post(
    url := 'https://contentpilot-social.vercel.app/api/cron/sports-news',
    params := '{"source":"supabase-cron"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || decrypted_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 190000
  )
  from vault.decrypted_secrets where name = 'contentpilot_sports_news_cron_bearer';
$job$);
```

Giữ biến URL của GitHub Actions trống nếu Supabase đang lên lịch cho cùng môi trường. Để thử một tin từ ngày trước, worker có chế độ POST có xác thực với `mode=test&date=YYYY-MM-DD`. Chế độ này chọn tối đa một tin đạt ngưỡng cho đích Telegram đã cấu hình và cho phép đăng trong 24 giờ sau khi duyệt.

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

4. Cấu hình biến môi trường từ `.env.example` trên ứng dụng thử nghiệm. `SPORTS_NEWS_SOCIAL_TOKENS` chứa cặp UUID đích và token tương ứng, ví dụ `{"<destination-uuid>":"<token>"}`. Chỉ đích có token mới được worker đề xuất và gửi. Để lưu bản nháp trước, dùng `{}`.
5. Để nhận thông báo, mở chat riêng của bot trên Telegram và bấm **Start**. Đặt token bot vào `SPORTS_NEWS_REVIEW_TELEGRAM_BOT_TOKEN`, ID số của chat riêng vào `SPORTS_NEWS_REVIEW_TELEGRAM_CHAT_ID` và địa chỉ HTTPS của ứng dụng vào `SPORTS_NEWS_REVIEW_SITE_ORIGIN`. Có thể dùng bot riêng cho thông báo. Nếu bot này cũng được cấp quyền đăng trên một kênh Telegram, đặt UUID đích vào `SPORTS_NEWS_TELEGRAM_DESTINATION_ID` để dùng lại token đã lưu.
6. Trong GitHub Actions, đặt biến `SPORTS_NEWS_CRON_URL` thành URL HTTPS của trang thử nghiệm cộng với `/api/cron/sports-news`. Đặt secret `SPORTS_NEWS_CRON_SECRET` có cùng giá trị với `CRON_SECRET` ở ứng dụng.
7. Chạy workflow **Sports news automation** thủ công hoặc gọi endpoint bằng POST với bearer token. Mở **Yêu cầu xuất bản**, duyệt bản tin và chạy một lượt nữa. Xác nhận bài có ảnh trên đúng kênh và trạng thái giao nội dung là **Đã xuất bản**. Lịch GitHub Actions chạy mỗi 2 giờ trên nhánh mặc định khi được cấu hình, có thể trễ tùy hàng đợi GitHub.

## Temporary Auto Publish

Một cửa sổ do quản trị production bật có thời hạn tối đa tám giờ, gắn với một workspace, một dự án và một đích Telegram. Worker vẫn là Member. Trong cửa sổ, tối đa hai tin trong mỗi khoảng hai giờ và tám tin toàn kỳ được phép gửi tự động, kể cả khi chạy lại. Chỉ bản nháp RSS mới tạo trong cửa sổ đủ điều kiện. Barem, bộ lọc tin cùng ngày, chống trùng và ảnh vuông được dùng như luồng thường.

Kết quả gửi tự động được ghi riêng trong `contentpilot_private.sports_auto_publish_deliveries`. Nếu Telegram xác nhận đã gửi hoặc kết quả chưa xác định, hệ thống chặn gửi lại cùng bài đến cùng kênh. Lỗi xác định chưa gửi giữ yêu cầu duyệt để xử lý thủ công. Khi quá hạn, worker tự trở về Human Approval.

## Khử trùng sự kiện theo ngữ nghĩa (FN05)

Ngoài khử trùng theo URL và tiêu đề chuẩn hoá (vẫn được xử lý trước, giữ nguyên), worker tính **danh tính sự kiện** (`event-v2`) bằng bộ trích xuất tất định (`src/lib/sports-news/event-identity.ts`, không gọi LLM/API trả phí). Danh tính chỉ "cụ thể" (`specific`) khi nêu được MỘT sự kiện:

- **Trận đấu**: đúng 2 đội trong từ điển (không phân biệt thứ tự), ngày, loại (nhận định/kết quả), tỷ số (không phân biệt hướng).
- **Cá nhân** (chuyển nhượng, chấn thương, HLV, kỷ luật): 1–2 tên người cụ thể + loại tin + ngày; chuyển nhượng/HLV còn cần cùng tập CLB. Cầu thủ khác nhau của cùng CLB, cùng ngày, cùng loại **không bao giờ** gộp. Họ đơn lẻ ("Rashford") chỉ khớp tên đầy đủ khi cùng CLB và họ đó là duy nhất trong lịch sử gần đây.
- **Không cụ thể** (thiếu đội/tên, tiêu đề trộn nhiều loại tin, tổng hợp nhiều trận, loại "other"): `identity_not_specific` → **fail open**: chấm điểm và duyệt thủ công như bình thường, không bỏ qua, không chặn, không lưu `event_key/cluster_key`.

Quyết định: `duplicate` (cùng sự kiện, không có gì mới → bỏ qua, ghi bằng chứng + lý do có cấu trúc vào `sports_news_event_matches`, hiển thị ở trang Luồng tin → "Nhật ký trùng sự kiện"); `follow_up` (nhận định → kết quả, tin đồn → chính thức, đổi tỷ số → vẫn qua chấm điểm/duyệt, liên kết sự kiện gốc); `new`.

**Chỉ bài đã thành post mới chặn được.** Chỉ mục có `post_id`, post chưa lưu trữ và chưa bị từ chối toàn bộ yêu cầu duyệt mới chặn báo cáo sau (TS: `blocksLaterReports`; DB: `contentpilot_private.sports_item_blocks_event`, cùng quy tắc). Bài điểm thấp, không được chọn, lỗi hoặc chỉ mới phát hiện không bao giờ chặn bài mạnh hơn (cùng lượt quét, lượt sau, hay lúc DB kiểm tra lại). Cùng lượt quét: sau khi chấm điểm, chỉ giữ bản điểm cao nhất của mỗi sự kiện; bản yếu hơn không chiếm chỗ nhưng cũng không chặn bản mạnh. Post đã lưu trữ hoặc bị từ chối hoàn toàn không còn chặn (có thể được đề xuất lại qua duyệt thủ công); post đang chờ/đã duyệt/đã hủy do hết hạn vẫn chặn để tránh gửi trùng.

**Chạy đồng thời**: `record_sports_news_event_assessment` lấy advisory lock theo dự án rồi kiểm tra lại `event_key`/`cluster_key` — chỉ khi lệnh này sắp tạo post (`p_title` khác null) và danh tính cụ thể. Phê duyệt thủ công, quota, Auto Publish có thời hạn, dừng khẩn cấp không đổi. TS và DB cùng quy tắc, DB là chốt cuối.

**Dữ liệu lịch sử**: không backfill, không ghi dữ liệu cũ. Với mục gần đây (cửa sổ 2 ngày, tối đa 150 post) chưa có `event_identity`, worker dựng danh tính bảo thủ tại bộ nhớ từ tiêu đề đã ghi (`assessment.title`) và nội dung post; kết quả không cụ thể thì bị bỏ qua. Bằng chứng ghi `matchedOrigin: "derived"`. Danh tính dẫn xuất không có khóa DB nên không được DB kiểm tra lại (chỉ lớp TS).

**Cách ly/ACL**: bảng bằng chứng bật RLS (thành viên chỉ đọc); hai RPC `SECURITY DEFINER` chỉ cấp cho `authenticated`, kiểm tra worker đã đăng ký; hàm chặn nằm ở schema private, không client nào gọi được. Lỗi ghi bằng chứng được đếm vào `eventEvidenceFailures`/`itemFailures`.

**Giới hạn đã biết**: từ điển đội/giải nhỏ (đội ngoài từ điển → không cụ thể → không gộp); tên người dựa vào chữ hoa trong tiêu đề; tỷ số không phân biệt chủ/khách; khóa cụm theo ngày Dubai chính xác (±1 ngày chỉ ở lớp TS); hai trận giống hệt cặp đội trong cùng ngày bị coi là một; tiêu đề trộn nhiều loại tin không bị gộp (an toàn nhưng có thể bỏ sót trùng). Áp dụng migration trước khi triển khai worker mới.

## FN05 acceptance remediation (blocking, manual-only, facts, fallback)

- **Blocking**: a post blocks later reports if it is published, has a queued/sending/succeeded delivery, or has a
  sending/succeeded/uncertain temporary auto-publish delivery, **even when archived**. Otherwise it blocks only while
  not archived and not fully rejected. An archived/rejected, never-sent post may be reconsidered. The auto-publish
  ledger is private, so the TS pre-filter cannot see it: the database recheck (`sports_item_blocks_event`) is
  authoritative and rejects the duplicate with `database_recheck` evidence.
- **Manual review only**: `sports_news_items.manual_review_reason` (`unresolved_identity`, `follow_up`,
  `reconsidered`, `uncertain_facts`) is set by the worker and re-derived by the database.
  `claim_sports_auto_publish` refuses such items, and the worker only sends regular eligible drafts to the window.
- **Material facts** (`facts`, part of `eventKey`): injury duration/diagnosis, transfer fee, contract, standings
  implication, from fixed patterns only (no AI). New fact → follow-up; changed value → `fact_changed`.
  Limitation: facts outside these patterns are not detected, so such a rewording is a duplicate.
- **Same-run fallback**: weaker reports of one event are alternates; skip evidence is stored only after the event
  became a post. If the lead fails, alternates are tried in rank order while total draft calls stay
  ≤ `SPORTS_NEWS_DRAFT_CALL_BUDGET` (10; tách biệt với trần 3 bài đầu ra mỗi lượt `SPORTS_NEWS_OUTPUT_PER_SCAN`).
