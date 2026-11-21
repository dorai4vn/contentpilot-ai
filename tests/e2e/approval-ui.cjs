/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * End-to-end test of the M4 human-approval UI in a real browser against a LOCAL
 * app and a LOCAL, disposable Supabase stack. Fresh users sign up (email
 * confirmation is off locally). Direct database access is used only to set up
 * memberships (no invitation UI), to verify stored state and to move one request
 * 8 days into the past (expiry). It REFUSES to run unless BASE_URL and
 * LOCAL_DB_URL both point to localhost. Never run it against production or a
 * Vercel preview. No OpenAI.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 \
 *   LOCAL_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   [SCREENSHOT_DIR=/some/dir] node tests/e2e/approval-ui.cjs
 */
const { execFileSync } = require("node:child_process");
const { chromium, devices } = require("playwright");
const { shown, editorReady } = require("./lib/wait.cjs");

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const DB_URL = process.env.LOCAL_DB_URL || "";
const SHOTS = process.env.SCREENSHOT_DIR || "";
const LOCAL = /^(https?:\/\/|postgres(ql)?:\/\/[^@]*@)(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

if (!LOCAL.test(BASE_URL) || !LOCAL.test(DB_URL)) {
  console.error("Refusing to run: BASE_URL and LOCAL_DB_URL must both point to localhost / 127.0.0.1.");
  process.exit(2);
}

const stamp = Date.now();
const PASSWORD = "e2e-password-123";
const TZ = "Asia/Ho_Chi_Minh";
let failures = 0;
const browserErrors = [];

function check(condition, message) {
  if (condition) console.log(`  ok - ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL - ${message}`);
  }
}

function sql(query) {
  return execFileSync("psql", [DB_URL, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8" }).trim();
}
const q = (value) => `'${String(value).replace(/'/g, "''")}'`;

async function newUser(browser, label, contextOptions = {}) {
  const context = await browser.newContext({ timezoneId: TZ, locale: "en-GB", ...contextOptions });
  const page = await context.newPage();
  page.on("pageerror", (error) => browserErrors.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`${label}: ${message.text()}`);
  });
  const email = `appr-${label}-${stamp}@example.test`;
  await page.goto(`${BASE_URL}/signup`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });
  const id = sql(`select id from auth.users where email = ${q(email)}`);
  return { context, page, email, id };
}

/** Waits (up to 5 s) for the element: pages stream in after navigation. */
const visible = async (page, testId) =>
  page
    .locator(`[data-testid="${testId}"]`)
    .first()
    .waitFor({ state: "visible", timeout: 5000 })
    .then(
      () => true,
      () => false,
    );
const count = async (page, testId) => page.locator(`[data-testid="${testId}"]`).count();

function requestOf(postId) {
  return sql(
    `select json_build_object('id', id, 'status', status, 'version', post_version, 'decided_by', decided_by,
       'cancel_reason', cancel_reason, 'note', decision_note)::text
     from public.content_publish_requests where post_id = ${q(postId)} order by requested_at desc limit 1`,
  );
}
const req = (postId) => JSON.parse(requestOf(postId) || "null");
const postState = (postId) =>
  JSON.parse(sql(`select json_build_object('status', status, 'version', version, 'published', published_at is not null)::text from public.content_posts where id = ${q(postId)}`));

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

/** Member creates a draft through the project page and lands on its editor. */
async function createPost(user, projectUrl, title, body) {
  await user.page.goto(projectUrl);
  await user.page.click('[data-testid="new-post-toggle"]');
  await user.page.fill("#new-post-title", title);
  await user.page.fill("#new-post-body", body);
  await user.page.click('[data-testid="create-post-submit"]');
  await user.page.waitForURL(/\/posts\/[0-9a-f-]{36}$/, { timeout: 15000 });
  return { url: user.page.url(), id: user.page.url().split("/").pop() };
}

async function requestPublish(user, reason) {
  if (reason) await user.page.fill('[data-testid="request-publish-reason"]', reason);
  await user.page.click('[data-testid="request-publish-submit"]');
  await user.page.locator('[data-testid="publish-card-pending"]').waitFor({ timeout: 15000 });
}

(async () => {
  console.log(`Approval UI E2E against ${BASE_URL}`);
  const browser = await chromium.launch();
  try {
    const owner = await newUser(browser, "owner", { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
    const admin = await newUser(browser, "admin");
    const member = await newUser(browser, "member");
    const phone = await browser.newContext({ ...devices["iPhone 13"], timezoneId: TZ, locale: "en-GB" });
    check(Boolean(owner.id && admin.id && member.id), "three users signed up");

    // Setup: workspace and project through the UI, memberships in the LOCAL database.
    const wsName = `E2E Approval ${stamp}`;
    await owner.page.fill('input[name="name"]', wsName);
    await owner.page.click('button:has-text("Tạo không gian làm việc")');
    const wsLink = owner.page.locator(`[data-testid="workspace-link"]:has-text("${wsName}")`);
    await wsLink.waitFor({ timeout: 15000 });
    const workspaceId = (await wsLink.getAttribute("href")).split("/").pop();
    sql(`insert into public.workspace_members (workspace_id, user_id, role) values
         (${q(workspaceId)}, ${q(admin.id)}, 'admin'), (${q(workspaceId)}, ${q(member.id)}, 'member')`);
    await owner.page.goto(`${BASE_URL}/w/${workspaceId}`);
    await owner.page.fill("#new-project-name", "Blog duyệt bài");
    await owner.page.click('[data-testid="create-project-submit"]');
    await owner.page.locator('[data-testid="project-link"]:has-text("Blog duyệt bài")').click();
    await owner.page.waitForURL(/\/p\/[0-9a-f-]{36}$/);
    const projectUrl = owner.page.url();
    const approvalsUrl = `${BASE_URL}/w/${workspaceId}/approvals`;

    // 1. Member sends a publish request ---------------------------------------------------------
    const p1 = await createPost(member, projectUrl, "Ra mắt Trợ lý AI", "Trợ lý AI giúp đội ngũ nội dung làm việc nhanh hơn.");
    check(await visible(member.page, "request-publish-form"), "draft post offers 'Gửi yêu cầu xuất bản'");
    check(
      (await member.page.locator('[data-testid="request-publish-destination"]').textContent())?.trim() === "Đích xuất bản: Nội bộ",
      "request form names its destination: Nội bộ",
    );
    await requestPublish(member, "Đã kiểm tra chính tả");
    const r1 = req(p1.id);
    check(r1?.status === "pending" && r1.version === 1, "request stored as pending for version 1 (database)");
    check(postState(p1.id).status === "draft", "sending a request does not publish (database)");
    check(await visible(member.page, "post-pending-notice"), "post page warns that saving cancels the pending request");

    // 2. Member cannot decide ---------------------------------------------------------------------
    await member.page.goto(`${approvalsUrl}/${r1.id}`);
    check(await visible(member.page, "decision-not-allowed"), "member sees 'no permission to approve'");
    check((await count(member.page, "approve-start")) === 0 && (await count(member.page, "reject-form")) === 0, "member sees no Phê duyệt / Từ chối buttons");
    check(await visible(member.page, "cancel-request-form"), "member (requester) may cancel their own request");

    // 3. Navigation and queue ---------------------------------------------------------------------
    await owner.page.goto(`${BASE_URL}/w/${workspaceId}`);
    check((await owner.page.locator('[data-testid="approvals-pending-count"]').textContent())?.trim() === "1", "workspace nav shows 1 pending approval");
    await owner.page.click('[data-testid="open-approvals"]');
    await owner.page.waitForURL(/\/approvals$/);
    const item = owner.page.locator(`[data-testid="approval-item"][data-request-id="${r1.id}"]`);
    check(await item.waitFor({ timeout: 5000 }).then(() => true, () => false), "approvals page lists the request");
    check((await item.locator('[data-testid="publish-status-badge"]').textContent())?.trim() === "Chờ duyệt", "status shown as 'Chờ duyệt'");
    await shot(owner.page, "approvals-desktop");

    // 4. Owner reviews, confirmation step, no implicit approval -----------------------------------------
    await item.locator('[data-testid="approval-item-link"]').click();
    await owner.page.waitForURL(new RegExp(`/approvals/${r1.id}$`));
    check((await owner.page.locator('[data-testid="review-content-title"]').textContent())?.trim() === "Ra mắt Trợ lý AI", "review shows the title");
    check((await owner.page.locator('[data-testid="review-content-body"]').textContent())?.includes("làm việc nhanh hơn"), "review shows the body");
    check((await owner.page.locator('[data-testid="review-requested-version"]').textContent())?.trim() === "Phiên bản 1", "review shows the requested version");
    check((await owner.page.locator('[data-testid="review-destination"]').textContent())?.trim() === "Nội bộ", "review shows the destination");
    // The member set no display name: only the role is shown, never an id.
    check((await owner.page.locator('[data-testid="review-requester"]').textContent())?.trim() === "Thành viên", "review shows who requested (role only, no id)");
    check(await shown(owner.page.locator('[data-testid="review-requested-at"] time')), "review shows when it was requested");
    check(await shown(owner.page.locator('[data-testid="review-expires-at"] time')), "review shows the deadline");
    check(await visible(owner.page, "audit-trail"), "review shows the audit trail");
    check(req(p1.id).status === "pending", "opening the review page approves nothing (database)");
    check((await count(owner.page, "approve-confirm")) === 0, "no confirmation step until the owner asks for it");

    await owner.page.click('[data-testid="approve-start"]');
    check(await visible(owner.page, "approve-confirm"), "'Phê duyệt…' opens an explicit confirmation");
    check((await owner.page.locator('[data-testid="approve-confirm"]').textContent())?.includes("phiên bản 1"), "confirmation names the version to publish");
    check((await owner.page.locator('[data-testid="approve-confirm-destination"]').textContent())?.trim() === "Nội bộ", "confirmation names the destination");
    await shot(owner.page, "review-confirm-desktop");
    await owner.page.click('[data-testid="approve-cancel"]');
    check((await count(owner.page, "approve-confirm")) === 0 && req(p1.id).status === "pending", "'Quay lại' closes it without approving");
    await owner.page.click('[data-testid="approve-start"]');
    await owner.page.click('[data-testid="approve-confirm-submit"]');
    await owner.page.locator('[data-testid="review-approved"]').waitFor({ timeout: 15000 });
    const approved = req(p1.id);
    check(approved.status === "approved" && approved.decided_by === owner.id, "request approved by the owner (database)");
    const s1 = postState(p1.id);
    check(s1.status === "published" && s1.version === 2 && s1.published, "post published at version 2 (database)");
    check((await owner.page.locator('[data-testid="audit-event"]').count()) === 3, "audit trail: requested, approved, published");
    check((await owner.page.locator('[data-testid="review-delivery"]').textContent())?.trim() === "Đã xuất bản", "execution state shown: Đã xuất bản");
    check(
      sql(`select d.status || ':' || dest.kind from public.publish_deliveries d join public.publishing_destinations dest on dest.id = d.destination_id where d.request_id = ${q(r1.id)}`) === "succeeded:internal",
      "one succeeded delivery on the internal destination (database)",
    );

    // 5. Published post is read-only -----------------------------------------------------------
    await member.page.goto(p1.url);
    check(await visible(member.page, "post-published-notice"), "published post shows the 'đã xuất bản' notice");
    check((await member.page.locator('[data-testid="status-badge"]').first().textContent())?.trim() === "Đã xuất bản", "status badge 'Đã xuất bản'");
    check(await member.page.locator("#post-title").isDisabled(), "editor is read-only");
    // Still read-only once the client has hydrated (hydration safety must not unlock it).
    await editorReady(member.page);
    check(
      (await member.page.locator("#post-title").isDisabled()) && (await member.page.locator("#post-body").isDisabled()),
      "published post stays read-only after hydration",
    );
    for (const control of ["save-post", "status-switch", "archive-post", "request-publish-form"]) {
      check((await count(member.page, control)) === 0, `no '${control}' on a published post`);
    }
    await shot(member.page, "post-published");

    // 6. Reject with a reason ----------------------------------------------------------------------
    const p2 = await createPost(member, projectUrl, "Bài cần sửa", "Bản nháp còn lỗi.");
    await requestPublish(member);
    const r2 = req(p2.id);
    await admin.page.goto(`${approvalsUrl}/${r2.id}`);
    await admin.page.fill('[data-testid="reject-note"]', "Cần sửa tiêu đề");
    await admin.page.click('[data-testid="reject-submit"]');
    await admin.page.locator('[data-testid="review-rejected"]').waitFor({ timeout: 15000 });
    const rejected = req(p2.id);
    check(rejected.status === "rejected" && rejected.note === "Cần sửa tiêu đề" && rejected.decided_by === admin.id, "admin rejected with a note (database)");
    check(postState(p2.id).status === "draft", "rejected post stays a draft");
    await member.page.goto(p2.url);
    check((await member.page.locator('[data-testid="publish-card-last"]').textContent())?.includes("Cần sửa tiêu đề"), "post page shows the rejection reason");
    check(await visible(member.page, "request-publish-form"), "a new request can be sent after a rejection");

    // 7. Requester cancels ---------------------------------------------------------------------------
    const p3 = await createPost(member, projectUrl, "Bài sẽ rút lại", "Nội dung.");
    await requestPublish(member);
    await member.page.click('[data-testid="cancel-request-submit"]');
    await member.page.locator('[data-testid="request-publish-form"]').waitFor({ timeout: 15000 });
    const cancelled = req(p3.id);
    check(cancelled.status === "cancelled" && cancelled.cancel_reason === "withdrawn", "requester cancelled the request (database)");

    // 8. Post changed after the request: old request invalid ----------------------------------------------
    const p4 = await createPost(member, projectUrl, "Bài sẽ sửa tiếp", "Bản 1.");
    await requestPublish(member);
    const r4 = req(p4.id);
    await editorReady(member.page);
    await member.page.fill("#post-body", "Bản 2, sửa sau khi gửi yêu cầu.");
    await member.page.click('[data-testid="save-post"]');
    await member.page.locator('[data-testid="save-post-success"]').waitFor({ timeout: 15000 });
    check(req(p4.id).cancel_reason === "post_changed", "saving the post cancelled the request (post_changed)");
    await owner.page.goto(`${approvalsUrl}/${r4.id}`);
    check(await visible(owner.page, "review-stale"), "review page says the old request is no longer valid");
    check((await count(owner.page, "approve-start")) === 0, "no approve button for the stale request");
    check(postState(p4.id).status === "draft", "the new version was not published");

    // 9. Two approvers at once: the loser is told to reload ----------------------------------------------
    const p5 = await createPost(member, projectUrl, "Bài tranh chấp", "Nội dung tranh chấp.");
    await requestPublish(member);
    const r5 = req(p5.id);
    await owner.page.goto(`${approvalsUrl}/${r5.id}`);
    await owner.page.click('[data-testid="approve-start"]');
    await admin.page.goto(`${approvalsUrl}/${r5.id}`);
    await admin.page.click('[data-testid="approve-start"]');
    await admin.page.click('[data-testid="approve-confirm-submit"]');
    await admin.page.locator('[data-testid="review-approved"]').waitFor({ timeout: 15000 });
    await owner.page.click('[data-testid="approve-confirm-submit"]');
    await owner.page.locator('[data-testid="approve-error"]').waitFor({ timeout: 15000 });
    const raceMessage = (await owner.page.locator('[data-testid="approve-error"]').textContent()) ?? "";
    check(/đã được xử lý|cập nhật sau khi bạn mở/.test(raceMessage) && raceMessage.includes("Tải lại dữ liệu"), "second approver gets a Vietnamese message with 'Tải lại dữ liệu'");
    await shot(owner.page, "review-race-error");
    await owner.page.click('[data-testid="approve-reload"]');
    await owner.page.locator('[data-testid="review-approved"]').waitFor({ timeout: 15000 });
    check(true, "reloading shows the request as approved");
    check(postState(p5.id).version === 2, "published exactly once (database)");

    // 10. Expired request ----------------------------------------------------------------------------------------
    const p6 = await createPost(member, projectUrl, "Bài quá hạn", "Nội dung.");
    await requestPublish(member);
    const r6 = req(p6.id);
    sql(`set session_replication_role = replica;
         update public.content_publish_requests set requested_at = requested_at - interval '8 days', expires_at = expires_at - interval '8 days'
          where id = ${q(r6.id)};`);
    await owner.page.goto(`${approvalsUrl}/${r6.id}`);
    check(await visible(owner.page, "review-expired"), "expired request shown as 'Hết hạn'");
    check((await count(owner.page, "approve-start")) === 0, "no approve button for an expired request");
    await owner.page.goto(`${approvalsUrl}?status=expired`);
    check(
      await owner.page
        .locator(`[data-testid="approval-item"][data-request-id="${r6.id}"]`)
        .waitFor({ timeout: 5000 })
        .then(() => true, () => false),
      "expired tab lists it",
    );

    // 11. Mobile layout ------------------------------------------------------------------------------------------------
    const mobile = await phone.newPage();
    mobile.on("pageerror", (error) => browserErrors.push(`mobile: ${error.message}`));
    await mobile.goto(`${BASE_URL}/login`);
    await mobile.fill('input[name="email"]', owner.email);
    await mobile.fill('input[name="password"]', PASSWORD);
    await mobile.click('button[type="submit"]');
    await mobile.waitForURL(/\/dashboard/, { timeout: 20000 });
    const p7 = await createPost(member, projectUrl, "Bài xem trên điện thoại", "Nội dung dài để kiểm tra bố cục trên màn hình hẹp.");
    await requestPublish(member);
    await mobile.goto(`${approvalsUrl}/${req(p7.id).id}`);
    await mobile.click('[data-testid="approve-start"]');
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 0, `no horizontal scroll on mobile (overflow ${overflow}px)`);
    await shot(mobile, "review-confirm-mobile");
    check(req(p7.id).status === "pending", "mobile: confirmation shown, still pending");
    await mobile.goto(approvalsUrl);
    await shot(mobile, "approvals-mobile");

    check(browserErrors.length === 0, `no browser errors or hydration warnings${browserErrors.length ? `: ${browserErrors.join(" | ")}` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL - unexpected error: ${error.message}`);
  } finally {
    await browser.close();
  }

  console.log(failures === 0 ? "All approval UI E2E checks passed." : `${failures} approval UI E2E check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})();
