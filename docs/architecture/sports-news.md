# Tin thể thao từ RSS

ContentPilot AI lấy RSS từ Bóng Đá 24h, BongDa.com.vn và các chuyên mục bóng đá của Thể Thao 247. Tuổi Trẻ và Thanh Niên là nguồn bổ sung. Mỗi lượt chỉ xét bài có thời điểm xuất bản trong **cùng ngày theo múi giờ Asia/Dubai** với thời điểm chạy (`publishedToday` trong `src/lib/sports-news/publication-day.ts`); bài có timestamp ở tương lai bị loại. Mốc 48 giờ **không** phải cửa sổ xét tin: đó chỉ là lịch sử dùng để chống trùng (xem bên dưới) — URL hoặc tiêu đề chuẩn hóa đã xử lý trong cùng dự án trong 48 giờ gần nhất (tối đa 800 bản ghi) bị bỏ qua. Điểm từ 0 đến 10 kết hợp độ nhận diện cao nhất của cầu thủ, đội hoặc giải, tầm quan trọng của sự kiện và độ mới. Trọng số mặc định (barem `sports-v1`) là 45% / 40% / 15%; mô hình ước lượng độ nhận diện theo độc giả Việt Nam. Điểm tự giảm khi tin cũ đi.

Barem `sports-v1` được dùng lại giữa các lượt. Độ nhận diện lấy điểm cao nhất trong ba mục cầu thủ, đội và giải. Sự kiện từ 9–10 là chung kết, chức vô địch hoặc kết quả lớn; 6–8 là diễn biến đáng chú ý; 0–5 là tin thường kỳ hoặc đồn đoán. Độ mới bắt đầu ở 10 điểm, giảm 1 điểm mỗi 4,8 giờ.

### Cấu hình chấm điểm theo dự án

Mặc định: trọng số reach/importance/freshness = 45/40/15, ngưỡng **8** (biến `SPORTS_NEWS_MIN_SCORE=8` khi dự án chưa có cấu hình riêng), chế độ dự phòng `highest`. Owner/Admin có thể đặt cấu hình riêng cho từng cặp workspace/dự án (bảng `sports_news_scoring_configs`, RPC `set_sports_news_scoring_config`; tổng trọng số phải bằng 100, ngưỡng 0–10, `fallback_mode` là `highest` hoặc `strict`; mỗi lần đổi tăng `version`). Worker đọc cấu hình ở đầu mỗi lượt. Cấu hình mới chỉ áp dụng cho tin được chấm từ lượt đó trở đi: quyết định đã ghi (kèm phiên bản barem, điểm thành phần, ngưỡng, trọng số) **không** bị chấm lại hay đổi kết quả một cách âm thầm.

Tin được đưa vào chấm theo thứ tự Ngoại hạng Anh → Cúp C1 → các giải lớn như World Cup, EURO, Copa América và các giải VĐQG lớn châu Âu → bóng đá Việt Nam → bóng đá khác → môn khác. Khi chọn bài, xếp theo điểm tổng trước, sau đó theo ưu tiên giải đấu và cuối cùng là độ mới. Nếu không có tin đạt ngưỡng, chế độ `highest` chọn đúng một tin có điểm cao nhất và ghi rõ lý do trong yêu cầu duyệt; chế độ `strict` không chọn tin nào.

Với tin được chọn, AI viết caption tiếng Việt từ tiêu đề và tóm tắt RSS. Caption có tiêu đề ngắn, bắt mắt và emoji mở đầu mỗi đoạn, với giọng văn gần gũi trên mạng xã hội. Link bài báo hiển thị trong màn hình duyệt. Hệ thống tìm ảnh JPEG tư liệu phù hợp trên Wikimedia Commons, ưu tiên ảnh đúng hai đội và ngày. Nếu thiếu, thử ảnh hai đội từng gặp hoặc ảnh thi đấu của một đội, lưu trạng thái ảnh tư liệu trong dữ liệu nội bộ. Bỏ qua ảnh sân vận động chung và chỉ dùng ảnh có giấy phép CC0 hoặc Public Domain theo metadata của nguồn. Nguồn ảnh và giấy phép được lưu nội bộ, caption công khai chỉ chứa nội dung bài. Khi không có ảnh phù hợp, bài chỉ có caption. Hạn mức mỗi lượt (chế độ thường): worker đưa tối đa **20** tin mới (chưa trùng URL/tiêu đề/sự kiện) vào bước AI chấm điểm, rồi chọn tối đa `SPORTS_NEWS_MAX_PER_RUN = 10` tin đạt ngưỡng; do đó tối đa **10 lần AI viết bản nháp** (draft) mỗi lượt, kể cả các lần thử tin thay thế khi tin dẫn đầu của một sự kiện bị lỗi (xem phần FN05). Đây là hạn mức *nháp/yêu cầu duyệt*, không phải hạn mức gửi. Mỗi tin đã có quyết định lưu phiên bản barem, điểm thành phần, lý do AI, ngưỡng và kết quả chọn. Tin dưới ngưỡng đã ghi nhận giữ quyết định cũ khi thay đổi ngưỡng. Tin đạt ngưỡng nhưng vượt giới hạn 10 bài của lượt không được ghi nhận, nên có thể được xét lại ở lượt sau nếu vẫn thuộc cùng ngày Asia/Dubai.

Ảnh được crop tự động thành JPEG vuông 1080 × 1080 cho màn hình duyệt và khi gửi. Telegram và Discord in đậm dòng tiêu đề. Facebook Page dùng tiêu đề dạng văn bản thường. Bài xuất hiện trong dự án dưới dạng bản nháp. Mỗi đích được cấu hình có một yêu cầu duyệt riêng; theo mặc định yêu cầu này chờ Human Approval, trừ ngoại lệ Temporary Auto Publish nêu ở phần riêng bên dưới. Màn hình duyệt hiển thị nội dung, đích, nguồn, điểm và ảnh của đúng phiên bản xin duyệt. Nếu người dùng sửa bài, yêu cầu cũ bị hủy. Người dùng có thể gửi lại yêu cầu từ trang bài viết. Phiên bản sửa gửi ảnh nếu có ảnh gắn riêng với phiên bản đó.

Theo mặc định, Owner/Admin phải duyệt từng yêu cầu (đúng phiên bản). Ngoại lệ duy nhất là bản nháp đủ điều kiện nằm trong cửa sổ Temporary Auto Publish đang hiệu lực do Owner/Admin chủ động bật (xem phần Temporary Auto Publish); ngoài cửa sổ đó, hoặc với tin phải duyệt thủ công, vẫn là Human Approval. Worker gửi phiên bản đã duyệt đến từng đích vào lượt tiếp theo. Sau lỗi HTTP 429, worker thử lại tối đa ba lần với khoảng chờ tăng dần. Nếu kết quả gửi không rõ, màn hình duyệt báo cần kiểm tra trực tiếp trên kênh. Worker giữ nguyên bài đã duyệt và ghi mã bài do nền tảng trả về khi gửi thành công.

Production dùng Supabase Cron để gọi pipeline mỗi 2 giờ. GitHub Actions là một cách đặt lịch cho môi trường thử nghiệm. Worker chỉ xét và gửi tin được xuất bản cùng ngày theo múi giờ Asia/Dubai (`publishedToday`; bài có timestamp tương lai bị loại). Tin đã duyệt nhưng qua ngày trước khi gửi sẽ được bỏ qua. Khi bản tin có yêu cầu mới chờ duyệt, bot gửi một tin nhắn Telegram riêng gồm tiêu đề, độ hot và link mở từng yêu cầu. Nếu gửi lỗi, worker thử lại ở lượt kế tiếp khi yêu cầu vẫn còn hiệu lực.

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

Giữ biến URL của GitHub Actions trống nếu Supabase đang lên lịch cho cùng môi trường. Để thử một tin từ ngày trước, worker có chế độ POST có xác thực với `mode=test&date=YYYY-MM-DD`. Chế độ test dùng giới hạn riêng: chỉ xét bài của đúng ngày `date` (Asia/Dubai), đưa tối đa **16** tin vào chấm điểm, chọn tối đa **một** tin đạt ngưỡng (không dùng dự phòng "cao nhất dưới ngưỡng"), chỉ cho đích Telegram đã cấu hình, và bài test cho phép gửi trong 24 giờ sau khi duyệt (`testPublishUntil`). Chế độ test **không bao giờ** vào Temporary Auto Publish: worker không mở cửa sổ tự động trong lượt test và cơ sở dữ liệu từ chối bài có `testPublishUntil`. Lượt test vẫn cần Owner/Admin duyệt như thường.

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

**Human Approval là chế độ mặc định.** Temporary Auto Publish là cửa sổ có thời hạn, do Owner/Admin chủ động bật rõ ràng (RPC `set_sports_auto_publish_control`) cho đúng một workspace, một dự án và một đích Telegram đang hoạt động; không có cửa sổ nào được bật mặc định. Khi không có cửa sổ hoặc cửa sổ đã hết hạn/bị tắt (tắt = dừng khẩn cấp, đóng cửa sổ ngay), worker tự trở về Human Approval. Worker vẫn là Member.

Giới hạn (khớp `AUTO_PUBLISH_MAX_*` trong `temporary-auto-publish.ts` và các ràng buộc trong migration):

| Giới hạn | Giá trị tối đa | Ghi chú |
| --- | --- | --- |
| Độ dài cửa sổ | 8 giờ | Owner/Admin chọn 1–8 giờ; DB có `check (ends_at <= starts_at + interval '8 hours')`. |
| Mỗi lượt chạy (`AUTO_PUBLISH_MAX_PER_RUN`) | 10 lần thử gửi | Tối đa 10 bản nháp đủ điều kiện được đưa vào `sendTemporarySportsPost`. Đây là hạn mức *thử gửi* của worker, tách biệt với hạn mức ≤10 lần AI viết nháp ở trên. |
| Mỗi khoảng hai giờ (`max_per_slot`) | 10 | Khoảng tính từ lúc bắt đầu cửa sổ (7200 giây); giá trị đặt 1–10, mặc định 10. |
| Toàn cửa sổ (`max_per_window`) | 40 | Giá trị đặt từ bằng `max_per_slot` đến 40, mặc định 40. |

Các hạn mức này là *giới hạn trên*; Owner/Admin có thể đặt thấp hơn. `claim_sports_auto_publish` đếm lại trong DB nên chạy lại hoặc chạy song song cũng không vượt hạn mức; số thực tế đã gửi là số ghi trong sổ cái, không phải con số cấu hình. Chỉ bản nháp RSS mới tạo trong cửa sổ, vòng đời hợp lệ (cùng ngày Asia/Dubai, barem `sports-v1`, quyết định `threshold_met` hoặc `highest_below_threshold`) và không phải bài test mới đủ điều kiện. Barem, bộ lọc tin cùng ngày, chống trùng và ảnh vuông được dùng như luồng thường.

Kết quả gửi tự động được ghi riêng trong `contentpilot_private.sports_auto_publish_deliveries`. Nếu Telegram xác nhận đã gửi hoặc kết quả chưa xác định, hệ thống chặn gửi lại cùng bài đến cùng kênh. Lỗi xác định chưa gửi giữ yêu cầu duyệt để xử lý thủ công.

### Chỉ duyệt thủ công (manual review only)

Các trường hợp sau luôn cần con người duyệt và **không bao giờ** vào Temporary Auto Publish. Cột `sports_news_items.manual_review_reason` ghi lý do (worker đặt, DB dẫn xuất lại từ payload nên payload cũ hoặc giả mạo không mở được đường tự động):

- `unresolved_identity`: không xác định được danh tính sự kiện (thiếu đội/tên, tiêu đề trộn nhiều loại tin...).
- `follow_up`: tin tiếp nối hoặc có sự kiện/dữ kiện vật chất mới (nhận định → kết quả, tin đồn → chính thức, đổi tỷ số...).
- `uncertain_facts`: giải đấu hoặc dữ kiện không chắc chắn (ví dụ cùng cặp đội nhưng giải chỉ biết ở một phía, hoặc dữ kiện đổi giá trị).
- `reconsidered`: sự kiện từng có bài đã lưu trữ hoặc bị từ chối hoàn toàn mà chưa được gửi, nay được đề xuất lại.

Lớp bảo vệ: worker chỉ đưa bản nháp có `manual === null` vào cửa sổ, và `claim_sports_auto_publish` từ chối mọi mục có `manual_review_reason` khác null (migration `20261127120000_sports_news_semantic_dedup.sql`).

## Khử trùng sự kiện theo ngữ nghĩa (FN05)

Trạng thái release: FN05 đã được squash merge vào `main` (PR #34, `44ebaf37`); Owner xác nhận migration và triển khai Production đã được xác minh. **Chưa có bằng chứng kiểm chứng ngữ nghĩa trên bài báo thật**, và tại thời điểm kiểm tra release Temporary Auto Publish đang tắt (Human Approval là mặc định). Tài liệu này mô tả code hiện tại; không khẳng định gửi ngoài thật thành công.

**Thứ tự ưu tiên**: (1) URL và tiêu đề chuẩn hoá đã xử lý trong 48 giờ (lịch sử chống trùng, tối đa 800 bản ghi) vẫn được xét trước và giữ nguyên; (2) sau đó mới tới danh tính sự kiện. Danh tính sự kiện (`EVENT_IDENTITY_VERSION = "event-v4"`) do bộ trích xuất tất định tính (`src/lib/sports-news/event-identity.ts`, không gọi LLM hay API trả phí). Danh tính chỉ "cụ thể" (`specific`) khi nêu được MỘT sự kiện:

- **Trận đấu**: đúng 2 đội trong từ điển (không phân biệt thứ tự), giải đấu, ngày, loại (nhận định/kết quả) và tỷ số. Cùng cặp đội ở hai giải khác nhau là hai trận khác nhau.
- **Cá nhân** (chuyển nhượng, chấn thương, HLV, kỷ luật): 1–2 tên người cụ thể + loại tin + ngày; chuyển nhượng/HLV còn cần cùng tập CLB. Cầu thủ khác nhau của cùng CLB, cùng ngày, cùng loại **không bao giờ** gộp. Họ đơn lẻ chỉ khớp tên đầy đủ khi cùng CLB và họ đó là duy nhất trong lịch sử gần đây.
- **Không cụ thể** (thiếu đội/tên, tiêu đề trộn nhiều loại tin, tổng hợp nhiều trận, loại "other"): `identity_not_specific` → **fail open có kiểm soát**: không bỏ qua và không chặn, tin được chấm điểm bình thường nhưng chỉ duyệt thủ công (`unresolved_identity`), không lưu `event_key/cluster_key`.

Hai báo cáo cùng chủ thể khi cùng loại sự kiện và ngày lệch tối đa 1 ngày. Quyết định, kèm bằng chứng và lý do có cấu trúc lưu ở `sports_news_event_matches` (hiển thị ở trang Luồng tin → "Nhật ký trùng sự kiện"):

- `duplicate`: cùng sự kiện, không có thông tin vật chất mới → bỏ qua.
- `follow_up`: có thông tin vật chất mới (nhận định → kết quả, tin đồn → chính thức, đổi tỷ số, dữ kiện mới) → vẫn qua chấm điểm và duyệt, liên kết sự kiện gốc, chỉ duyệt thủ công.
- `new`: không liên quan, hoặc danh tính chưa đủ cụ thể để kết luận.

**Chỉ bài đã thành post mới chặn được** (TS: `blocksLaterReports`; DB: `contentpilot_private.sports_item_blocks_event`, cùng quy tắc):

- Bài đã xuất bản (`published`), hoặc có giao nội dung `queued`/`sending`/`succeeded`, hoặc có giao tự động `sending`/`succeeded`/`uncertain` **vẫn chặn kể cả khi đã lưu trữ**. Sổ cái tự động là private nên lớp TS không thấy được; DB kiểm tra lại là chốt cuối và ghi bằng chứng `database_recheck`.
- Bài khác chỉ chặn khi chưa lưu trữ và chưa bị từ chối toàn bộ yêu cầu duyệt. Bài đã lưu trữ/bị từ chối mà chưa từng gửi có thể được đề xuất lại — luôn chỉ duyệt thủ công (`reconsidered`).
- Bài điểm thấp, không được chọn, lỗi hoặc chỉ mới phát hiện (không có post) **không bao giờ chặn** bài mạnh hơn, dù cùng lượt quét, lượt sau hay lúc DB kiểm tra lại.

**Cùng lượt quét**: sau khi chấm điểm, bản điểm cao nhất của mỗi sự kiện là bản dẫn đầu; bản yếu hơn là *bản thay thế* và không chiếm chỗ. Bằng chứng bỏ qua của bản thay thế chỉ được lưu sau khi sự kiện đã thật sự thành post. Nếu bản dẫn đầu lỗi trước khi có post, các bản thay thế được thử lần lượt theo thứ hạng (chỉ bản đạt ngưỡng, hoặc khi đang ở chế độ dự phòng), với tổng số lần AI viết nháp không vượt `SPORTS_NEWS_MAX_PER_RUN` (10). Nếu kết quả là bản trùng bị DB từ chối thì không kích hoạt dự phòng.

**Chạy đồng thời**: `record_sports_news_event_assessment` lấy advisory lock theo dự án rồi kiểm tra lại `event_key` và `cluster_key` (gồm cửa sổ ngày −1/0/+1 và giải đấu) — chỉ khi lệnh sắp tạo post (`p_title` khác null) và danh tính cụ thể. Phê duyệt thủ công, hạn mức, Auto Publish có thời hạn và dừng khẩn cấp không đổi.

**Dữ liệu lịch sử**: không backfill, không ghi dữ liệu cũ. Với mục gần đây (cửa sổ 2 ngày, tối đa 150 post) chưa có `event_identity`, worker dựng danh tính bảo thủ tại bộ nhớ từ tiêu đề đã ghi và nội dung post; kết quả không cụ thể thì bị bỏ qua. Bằng chứng ghi `matchedOrigin: "derived"`. Danh tính dẫn xuất không có khóa DB nên chỉ được lớp TS kiểm tra.

**Dữ kiện vật chất** (một phần của `eventKey`): thời gian/chẩn đoán chấn thương, phí chuyển nhượng, hợp đồng, hệ quả bảng xếp hạng — chỉ theo mẫu cố định, không dùng AI. Dữ kiện mới → `follow_up`; giá trị thay đổi → `fact_changed` (chỉ duyệt thủ công). Dữ kiện ngoài các mẫu này không được phát hiện, nên bài diễn đạt lại sẽ bị coi là trùng.

**Cách ly và ACL**: mọi truy vấn lọc theo workspace/dự án; bảng bằng chứng bật RLS (thành viên chỉ đọc); hai RPC `SECURITY DEFINER` chỉ cấp cho `authenticated` và kiểm tra worker đã đăng ký; hàm chặn nằm ở schema private. Lỗi ghi bằng chứng được đếm vào `eventEvidenceFailures`/`itemFailures`.

**Giới hạn đã biết**: từ điển đội/giải nhỏ (đội ngoài từ điển → không cụ thể → không gộp); tên người dựa vào chữ hoa trong tiêu đề; tỷ số không phân biệt chủ/khách; hai trận cùng cặp đội và giải trong cửa sổ ±1 ngày bị coi là một; tiêu đề trộn nhiều loại tin không bị gộp (an toàn nhưng có thể bỏ sót trùng). Áp dụng migration trước khi triển khai worker mới.

## Phạm vi và những điều chưa được xác nhận

- Tài liệu này mô tả hành vi theo code; không khẳng định đã gửi thành công ra kênh ngoài thật hay kết quả vận hành Production.
- Ảnh tư liệu chỉ được lọc theo metadata giấy phép do nguồn khai báo; chưa có kiểm chứng độc lập về quyền sử dụng ảnh. Module xác minh giấy phép ảnh và kiểm chứng sự thật của tin nằm ngoài phạm vi hiện tại.
