/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * End-to-end test of M4.5.2 user profiles in a real browser against a LOCAL app
 * and a LOCAL, disposable Supabase stack: sign-up with an optional display name,
 * the account page, and names (never ids or emails) in the approval history.
 * Direct database access is used only to set up memberships, verify stored state
 * and delete one account. REFUSES to run unless BASE_URL and LOCAL_DB_URL point
 * to localhost. No OpenAI.
 *
 *   BASE_URL=http://127.0.0.1:3100 LOCAL_DB_URL=postgresql://...@127.0.0.1:54322/postgres \
 *   node tests/e2e/profiles.cjs        (or: npm run test:e2e:local -- profiles)
 */
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const { shown } = require("./lib/wait.cjs");

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
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|#[0-9a-f]{8}/;

async function signUp(browser, label, displayName) {
  const context = await browser.newContext({ timezoneId: "Asia/Ho_Chi_Minh", locale: "en-GB" });
  const page = await context.newPage();
  page.on("pageerror", (error) => browserErrors.push(`${label}: ${error.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") browserErrors.push(`${label}: ${m.text()}`);
  });
  const email = `prof-${label}-${stamp}@example.test`;
  await page.goto(`${BASE_URL}/signup`);
  if (displayName) await page.fill('[data-testid="signup-display-name"]', displayName);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });
  const id = sql(`select id from auth.users where email = ${q(email)}`);
  return { context, page, email, id };
}
const profileName = (id) => sql(`select coalesce((select display_name from public.user_profiles where user_id = ${q(id)}), '<none>')`);

async function createPost(user, projectUrl, title) {
  await user.page.goto(projectUrl);
  await user.page.click('[data-testid="new-post-toggle"]');
  await user.page.fill("#new-post-title", title);
  await user.page.fill("#new-post-body", "Nội dung.");
  await user.page.click('[data-testid="create-post-submit"]');
  await user.page.waitForURL(/\/posts\/[0-9a-f-]{36}$/, { timeout: 15000 });
  return user.page.url().split("/").pop();
}

(async () => {
  console.log(`Profiles E2E against ${BASE_URL}`);
  const browser = await chromium.launch();
  try {
    // 1. Sign-up with and without a display name ------------------------------------------
    const owner = await signUp(browser, "owner", "  Chủ   An ");
    const member = await signUp(browser, "member", "Bình Trần");
    const admin = await signUp(browser, "admin");
    check(profileName(owner.id) === "Chủ An", "sign-up with a name creates the profile (trimmed)");
    check(profileName(member.id) === "Bình Trần", "second user's name saved");
    check(profileName(admin.id) === "<none>", "sign-up without a name works and creates no profile");
    check(
      sql(`select count(*) from information_schema.columns where table_name = 'user_profiles' and column_name ilike '%email%'`) === "0",
      "profiles store no email",
    );

    // Existing login still works.
    const relogin = await browser.newContext();
    const loginPage = await relogin.newPage();
    await loginPage.goto(`${BASE_URL}/login`);
    await loginPage.fill('input[name="email"]', owner.email);
    await loginPage.fill('input[name="password"]', PASSWORD);
    await loginPage.click('button[type="submit"]');
    await loginPage.waitForURL(/\/dashboard/, { timeout: 20000 });
    check(true, "login still works for a user with a profile");
    await relogin.close();

    // 2. Account page --------------------------------------------------------------------------
    await admin.page.click('[data-testid="account-link"]');
    await admin.page.waitForURL(/\/account$/);
    check(await shown(admin.page.locator('[data-testid="profile-missing"]')), "account page says no name is set yet");
    await admin.page.fill('[data-testid="profile-display-name"]', "Quản trị Chi");
    await admin.page.click('[data-testid="profile-save"]');
    check(await shown(admin.page.locator('[data-testid="profile-save-success"]')), "saving shows 'Đã lưu tên hiển thị'");
    check(profileName(admin.id) === "Quản trị Chi", "account page saved the name (database)");
    await admin.page.reload();
    check((await admin.page.locator('[data-testid="profile-display-name"]').inputValue()) === "Quản trị Chi", "name shown after reload");
    check((await admin.page.locator('[data-testid="profile-missing"]').count()) === 0, "no 'missing name' notice any more");
    if (SHOTS) await admin.page.screenshot({ path: `${SHOTS}/account.png`, fullPage: true });

    // 3. Names in the approval history ---------------------------------------------------------
    const wsName = `E2E Profiles ${stamp}`;
    await owner.page.fill('input[name="name"]', wsName);
    await owner.page.click('button:has-text("Tạo không gian làm việc")');
    const wsLink = owner.page.locator(`[data-testid="workspace-link"]:has-text("${wsName}")`);
    await wsLink.waitFor({ timeout: 15000 });
    const workspaceId = (await wsLink.getAttribute("href")).split("/").pop();
    sql(`insert into public.workspace_members (workspace_id, user_id, role) values
         (${q(workspaceId)}, ${q(admin.id)}, 'admin'), (${q(workspaceId)}, ${q(member.id)}, 'member')`);
    await owner.page.goto(`${BASE_URL}/w/${workspaceId}/studio`);
    await owner.page.fill("#new-project-name", "Blog hồ sơ");
    await owner.page.click('[data-testid="create-project-submit"]');
    await owner.page.locator('[data-testid="project-link"]:has-text("Blog hồ sơ")').click();
    await owner.page.waitForURL(/\/p\/[0-9a-f-]{36}$/);
    const projectUrl = owner.page.url();

    const postId = await createPost(member, projectUrl, "Bài có tên người gửi");
    await member.page.click('[data-testid="request-publish-submit"]');
    await member.page.locator('[data-testid="publish-card-pending"]').waitFor({ timeout: 15000 });
    const requestId = sql(`select id from public.content_publish_requests where post_id = ${q(postId)}`);
    const reviewUrl = `${BASE_URL}/w/${workspaceId}/approvals/${requestId}`;

    await admin.page.goto(reviewUrl);
    await admin.page.click('[data-testid="approve-start"]');
    await admin.page.click('[data-testid="approve-confirm-submit"]');
    await admin.page.locator('[data-testid="review-approved"]').waitFor({ timeout: 15000 });

    await owner.page.goto(reviewUrl);
    await owner.page.locator('[data-testid="audit-trail"]').waitFor({ timeout: 10000 });
    const requester = (await owner.page.locator('[data-testid="review-requester"]').textContent())?.trim();
    check(requester === "Bình Trần (Thành viên)", `requester shown by name and role (${requester})`);
    const trail = (await owner.page.locator('[data-testid="audit-trail"]').textContent()) ?? "";
    check(trail.includes("Bình Trần (Thành viên)") && trail.includes("Quản trị Chi (Quản trị viên)"), "audit trail names requester and approver");
    const approvedNotice = (await owner.page.locator('[data-testid="review-approved"]').textContent()) ?? "";
    check(approvedNotice.includes("Quản trị Chi (Quản trị viên)"), "approval notice names the approver");
    const pageText = (await owner.page.locator("main").textContent()) ?? "";
    check(!UUID.test(pageText), "no user id visible on the review page");
    check(!pageText.includes("@example.test"), "no email visible on the review page");
    if (SHOTS) await owner.page.screenshot({ path: `${SHOTS}/review-names.png`, fullPage: true });

    await owner.page.goto(`${BASE_URL}/w/${workspaceId}/approvals?status=approved`);
    const item = owner.page.locator(`[data-testid="approval-item"][data-request-id="${requestId}"]`);
    check(await shown(item), "approved request listed");
    check(((await item.textContent()) ?? "").includes("gửi bởi Bình Trần (Thành viên)"), "approval list shows the requester's name");

    // The member sees their own name marked "(bạn)".
    await member.page.goto(reviewUrl);
    await member.page.locator('[data-testid="review-requester"]').waitFor({ timeout: 10000 });
    check((await member.page.locator('[data-testid="review-requester"]').textContent())?.trim() === "Bình Trần (bạn)", "own name marked '(bạn)'");

    // 4. Renaming updates the history display; old entries still render ---------------------------------
    await member.page.goto(`${BASE_URL}/account`);
    await member.page.fill('[data-testid="profile-display-name"]', "Bình T.");
    await member.page.click('[data-testid="profile-save"]');
    await member.page.locator('[data-testid="profile-save-success"]').waitFor({ timeout: 10000 });
    await owner.page.goto(reviewUrl);
    await owner.page.locator('[data-testid="review-requester"]').waitFor({ timeout: 10000 });
    check((await owner.page.locator('[data-testid="review-requester"]').textContent())?.trim() === "Bình T. (Thành viên)", "renamed member shown with the new name");

    // 5. A deleted account is 'Người dùng đã xóa' -------------------------------------------------------
    sql(`delete from auth.users where id = ${q(admin.id)}`);
    await owner.page.goto(reviewUrl);
    await owner.page.locator('[data-testid="audit-trail"]').waitFor({ timeout: 10000 });
    const afterDelete = (await owner.page.locator('[data-testid="audit-trail"]').textContent()) ?? "";
    check(afterDelete.includes("Người dùng đã xóa") && !afterDelete.includes("Quản trị Chi"), "deleted approver shown as 'Người dùng đã xóa'");
    check(postId && sql(`select status from public.content_posts where id = ${q(postId)}`) === "published", "approval and publication are unchanged");

    check(browserErrors.length === 0, `no browser errors or hydration warnings${browserErrors.length ? `: ${browserErrors.join(" | ")}` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL - unexpected error: ${error.message}`);
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? "All profiles E2E checks passed." : `${failures} profiles E2E check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})();
