/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Interactive E2E of the bulk approval in the review queue (issue #26) in a real
 * browser against a LOCAL app and a LOCAL, disposable Supabase stack. Posts and
 * requests are created through the UI by a member; approvals go to the built-in
 * INTERNAL destination only (no Telegram or any other external delivery exists
 * in this stack). Direct SQL is used only to verify stored state and to add
 * memberships. REFUSES to run unless BASE_URL and LOCAL_DB_URL are localhost.
 *
 * Usage (see scripts/e2e-local.sh):
 *   BASE_URL=http://127.0.0.1:3100 LOCAL_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   [SCREENSHOT_DIR=/some/dir] node tests/e2e/bulk-approval.cjs
 */
const { execFileSync } = require("node:child_process");
const { chromium, devices } = require("playwright");
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
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const tid = (id) => `[data-testid="${id}"]`;
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function newUser(browser, label, contextOptions = {}) {
  const context = await browser.newContext({ locale: "en-GB", ...contextOptions });
  const page = await context.newPage();
  page.on("pageerror", (e) => browserErrors.push(`${label}: ${e.message}`));
  page.on("console", (m) => {
    // A non-member legitimately gets a 404 for the workspace.
    if (m.type() === "error" && label !== "outsider") browserErrors.push(`${label}: ${m.text()}`);
  });
  const email = `bulk-${label}-${stamp}@example.test`;
  await page.goto(`${BASE_URL}/signup`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });
  return { context, page, email, id: sql(`select id from auth.users where email = ${q(email)}`) };
}

async function createPendingPost(user, projectUrl, title) {
  await user.page.goto(projectUrl);
  await user.page.click(tid("new-post-toggle"));
  await user.page.fill("#new-post-title", title);
  await user.page.fill("#new-post-body", `Nội dung của ${title}.`);
  await user.page.click(tid("create-post-submit"));
  await user.page.waitForURL(/\/posts\/[0-9a-f-]{36}$/, { timeout: 15000 });
  const url = user.page.url();
  const id = url.split("/").pop();
  await user.page.click(tid("request-publish-submit"));
  await user.page.locator(tid("publish-card-pending")).waitFor({ timeout: 15000 });
  const requestId = sql(`select id from public.content_publish_requests where post_id = ${q(id)} order by requested_at desc limit 1`);
  return { id, url, requestId, title };
}
const reqStatus = (id) => sql(`select status from public.content_publish_requests where id = ${q(id)}`);
const deliveries = (id) => Number(sql(`select count(*) from public.publish_deliveries where request_id = ${q(id)}`));
const boxOf = (page, post) => page.locator(`${tid("approval-item")}[data-request-id="${post.requestId}"] ${tid("bulk-item-checkbox")}`);
const rows = (page) => page.locator(tid("approval-item"));

(async () => {
  console.log(`Bulk approval E2E against ${BASE_URL}`);
  const browser = await chromium.launch();
  try {
    const owner = await newUser(browser, "owner", { viewport: { width: 1280, height: 900 } });
    const member = await newUser(browser, "member");
    const outsider = await newUser(browser, "outsider");

    const wsName = `E2E Bulk ${stamp}`;
    await owner.page.fill('input[name="name"]', wsName);
    await owner.page.click('button:has-text("Tạo không gian làm việc")');
    const wsLink = owner.page.locator(`[data-testid="workspace-link"]:has-text("${wsName}")`);
    await wsLink.waitFor({ timeout: 15000 });
    const workspaceId = (await wsLink.getAttribute("href")).split("/").pop();
    sql(`insert into public.workspace_members (workspace_id, user_id, role) values (${q(workspaceId)}, ${q(member.id)}, 'member')`);
    await owner.page.goto(`${BASE_URL}/w/${workspaceId}/studio`);
    await owner.page.fill("#new-project-name", "Bulk");
    await owner.page.click(tid("create-project-submit"));
    await owner.page.locator('[data-testid="project-link"]:has-text("Bulk")').click();
    await owner.page.waitForURL(/\/p\/[0-9a-f-]{36}$/);
    const projectUrl = owner.page.url();
    const queue = `${BASE_URL}/w/${workspaceId}/approvals`;

    // 0. Empty queue ----------------------------------------------------------------------
    await owner.page.goto(queue);
    check(await shown(owner.page.locator("text=Không có yêu cầu nào đang chờ duyệt")), "empty queue shows the empty state");
    check((await owner.page.locator(tid("bulk-toolbar")).count()) === 0, "empty queue: no bulk toolbar");

    // Setup: five pending requests by a member.
    const posts = [];
    for (const t of ["Bài A", "Bài B", "Bài C", "Bài D", "Bài E"]) posts.push(await createPendingPost(member, projectUrl, `${t} ${stamp}`));
    const [A, B, C, D, E] = posts;

    // Member and outsider never see bulk controls.
    await member.page.goto(queue);
    check(await shown(member.page.locator(tid("approval-item"))), "member sees the queue");
    check((await member.page.locator(tid("bulk-toolbar")).count()) === 0 && (await member.page.locator(tid("bulk-item-checkbox")).count()) === 0, "member: no checkboxes / bulk button");
    await outsider.page.goto(queue);
    check((await outsider.page.locator(tid("bulk-item-checkbox")).count()) === 0, "non-member (cross-workspace): no bulk controls");

    // 1. Selection, select-all, keyboard, one, clear ------------------------------------------
    const p = owner.page;
    await p.goto(queue);
    await rows(p).first().waitFor({ timeout: 10000 });
    check((await rows(p).count()) === 5 && (await p.locator(tid("bulk-item-checkbox")).count()) === 5, "5 pending rows, 5 accessible checkboxes");
    const label = await p.locator(tid("bulk-item-checkbox")).first().getAttribute("aria-label");
    check(/^Chọn “.+” \(phiên bản \d+\) để phê duyệt$/.test(label || ""), "checkbox has an accessible name with title and version");
    check((await p.locator(tid("bulk-count")).textContent()).includes("Đã chọn 0/5") && (await p.locator(tid("bulk-approve-start")).isDisabled()), "nothing selected: count 0/5, approve disabled");
    await p.locator(tid("bulk-item-checkbox")).first().focus();
    await p.keyboard.press("Space");
    check((await p.locator(tid("bulk-count")).textContent()).includes("Đã chọn 1/5"), "keyboard Space selects one row (1/5)");
    check(await p.locator(tid("bulk-approve-start")).isEnabled(), "approve enabled with one selected");
    await p.click(tid("bulk-clear"));
    check((await p.locator(tid("bulk-count")).textContent()).includes("Đã chọn 0/5"), "clear selection resets to 0");
    await p.locator(tid("bulk-select-all")).focus();
    await p.keyboard.press("Space");
    check((await p.locator(tid("bulk-count")).textContent()).includes("Đã chọn 5/5"), "select-all via keyboard selects 5/5");
    await boxOf(p, E).uncheck();
    check((await p.locator(tid("bulk-count")).textContent()).includes("Đã chọn 4/5") && !(await p.locator(tid("bulk-select-all")).isChecked()), "unchecking one clears select-all (4/5)");

    // 2. Confirmation / cancel / keyboard -----------------------------------------------------
    await p.click(tid("bulk-approve-start"));
    await shown(p.locator(tid("bulk-confirm")));
    const summary = await p.locator(tid("bulk-confirm-summary")).textContent();
    check(summary.includes("4") && summary.includes("Nội bộ"), "confirmation names count (4) and destination (Nội bộ)");
    check(await p.evaluate(() => document.activeElement?.getAttribute("data-testid") === "bulk-confirm"), "focus moves to the confirmation dialog on open");
    await p.keyboard.press("Escape");
    check((await p.locator(tid("bulk-confirm")).count()) === 0 && (await reqStatus(A.requestId)) === "pending", "Escape cancels the confirmation, nothing approved");
    check(await p.evaluate(() => document.activeElement?.getAttribute("data-testid") === "bulk-approve-start"), "focus returns to the approve button after Escape");
    await p.click(tid("bulk-approve-start"));
    await p.click(tid("bulk-confirm-cancel"));
    check((await p.locator(tid("bulk-confirm")).count()) === 0 && (await reqStatus(B.requestId)) === "pending", "'Quay lại' cancels, nothing approved");
    // Stale confirmation cannot change the payload: changing selection closes it.
    await p.click(tid("bulk-approve-start"));
    await shown(p.locator(tid("bulk-confirm")));
    await boxOf(p, D).uncheck();
    check((await p.locator(tid("bulk-confirm")).count()) === 0, "changing the selection invalidates an open confirmation");
    await boxOf(p, D).check();

    // 3. Navigation resets selection and confirmation -------------------------------------------
    await p.click(tid("bulk-approve-start"));
    await shown(p.locator(tid("bulk-confirm")));
    await p.click(tid("approvals-tab-all"));
    await p.waitForURL(/status=all/);
    await rows(p).first().waitFor();
    check((await p.locator(tid("bulk-confirm")).count()) === 0, "switching filter closes the confirmation");
    await p.click(tid("approvals-tab-pending"));
    await p.waitForURL((u) => !u.search.includes("status"));
    await p.locator(tid("bulk-toolbar")).waitFor();
    check((await p.locator(tid("bulk-count")).textContent()).includes("Đã chọn 0/5"), "returning to the pending filter starts with an empty selection");

    // 4. Mixed outcome: B is withdrawn by the member after the owner confirmed -----------------------------
    await p.click(tid("bulk-select-all"));
    await boxOf(p, E).uncheck(); // leave E out
    await p.click(tid("bulk-approve-start"));
    await shown(p.locator(tid("bulk-confirm")));
    await member.page.goto(B.url);
    await member.page.click(tid("cancel-request-submit"));
    await member.page.locator(tid("request-publish-form")).waitFor({ timeout: 15000 });
    check((await reqStatus(B.requestId)) === "cancelled", "setup: B withdrawn by the member (database)");
    await shot(p, "bulk-confirm-desktop");
    await p.click(tid("bulk-confirm-submit"));
    await p.locator(tid("bulk-result")).waitFor({ timeout: 20000 });
    check((await p.locator(tid("bulk-result")).getAttribute("data-ok-count")) === "3" && (await p.locator(tid("bulk-result")).getAttribute("data-fail-count")) === "1", "result report: 3 succeeded, 1 failed");
    check((await reqStatus(A.requestId)) === "approved" && (await reqStatus(C.requestId)) === "approved" && (await reqStatus(D.requestId)) === "approved", "A, C, D approved (database)");
    check((await reqStatus(B.requestId)) === "cancelled" && (await reqStatus(E.requestId)) === "pending", "B stays cancelled and unselected E stays pending (database)");
    check(deliveries(A.requestId) === 1 && deliveries(C.requestId) === 1 && deliveries(D.requestId) === 1, "one internal delivery per approved request");
    await p.locator(tid("bulk-result-row")).first().waitFor();
    const reportText = await p.locator(tid("bulk-result")).textContent();
    check([A, B, C, D].every((x) => reportText.includes(x.title)), "report lists every item with its title");
    const failRow = p.locator(`${tid("bulk-result-row")}[data-ok="false"]`);
    check((await failRow.count()) === 1 && (await failRow.textContent()).includes(B.title) && /Không phê duyệt được/.test(await failRow.textContent()), "failed row shows title and error");
    check((await failRow.getAttribute("data-still-eligible")) === "false" && (await p.locator(tid("bulk-result-gone")).count()) === 1, "failure no longer eligible is reported explicitly and not retained");
    check((await p.locator(tid("bulk-count")).textContent()).includes("Đã chọn 0/1"), "after refresh only E remains, nothing selected");
    await shot(p, "bulk-mixed-desktop");

    // 5. Dark mode, then double submit + all-success empty queue ------------------------------------
    await p.evaluate(() => localStorage.setItem("football-news-theme", "dark"));
    await p.reload();
    await p.locator(tid("bulk-toolbar")).waitFor();
    await p.locator(tid("bulk-item-checkbox")).first().check();
    await p.click(tid("bulk-approve-start"));
    await shown(p.locator(tid("bulk-confirm")));
    const dark = await p.evaluate(() => {
      const bg = (t) => getComputedStyle(document.querySelector(`[data-testid="${t}"]`)).backgroundColor;
      const fg = (t) => getComputedStyle(document.querySelector(`[data-testid="${t}"]`)).color;
      return { dark: document.documentElement.classList.contains("dark"), toolbar: bg("bulk-toolbar"), confirm: bg("bulk-confirm"), confirmFg: fg("bulk-confirm") };
    });
    check(dark.dark && dark.toolbar === "rgb(27, 38, 50)", `dark: toolbar uses --surface (${dark.toolbar})`);
    check(dark.confirm === "rgb(25, 61, 52)" && dark.confirmFg === "rgb(241, 245, 249)", `dark: confirmation uses --accent with light text (${dark.confirm} / ${dark.confirmFg})`);
    await shot(p, "bulk-confirm-dark");
    // Double submit: two rapid clicks must still approve exactly once.
    await p.evaluate(() => {
      const b = document.querySelector('[data-testid="bulk-confirm-submit"]');
      b.click();
      b.click();
    });
    await p.locator(tid("bulk-result")).waitFor({ timeout: 20000 });
    check((await reqStatus(E.requestId)) === "approved" && deliveries(E.requestId) === 1, "double submit approved once, one delivery (database)");
    check((await p.locator(tid("bulk-result")).getAttribute("data-ok-count")) === "1", "report shows 1/1 after double click");
    check(await shown(p.locator("text=Không có yêu cầu nào đang chờ duyệt")) && (await p.locator(tid("bulk-result")).count()) === 1, "all-success: empty queue AND the result report both stay visible");
    check((await p.locator(tid("bulk-toolbar")).count()) === 0, "empty queue hides the toolbar");
    await shot(p, "bulk-success-empty-dark");
    await p.reload();
    check((await p.locator(tid("bulk-result")).count()) === 0, "report is session-local: a manual reload clears it");
    await p.evaluate(() => localStorage.setItem("football-news-theme", "light"));
    await p.reload();
    await shown(p.locator("text=Không có yêu cầu nào đang chờ duyệt"));
    check(await p.evaluate(() => !document.documentElement.classList.contains("dark")), "light theme restored");

    // 6. Existing single approval still works ------------------------------------------------------------
    const F = await createPendingPost(member, projectUrl, `Bài F ${stamp}`);
    await p.goto(`${queue}/${F.requestId}`);
    await p.click(tid("approve-start"));
    await p.click(tid("approve-confirm-submit"));
    await p.locator(tid("review-approved")).waitFor({ timeout: 15000 });
    check((await reqStatus(F.requestId)) === "approved", "single-item approval regression: still approves");

    // 7. Mobile + System theme ----------------------------------------------------------------------------------
    const G = await createPendingPost(member, projectUrl, `Bài G ${stamp}`);
    const H = await createPendingPost(member, projectUrl, `Bài H ${stamp}`);
    const phone = await browser.newContext({ ...devices["iPhone 13"], locale: "en-GB", colorScheme: "dark" });
    const m = await phone.newPage();
    m.on("pageerror", (e) => browserErrors.push(`mobile: ${e.message}`));
    await m.goto(`${BASE_URL}/login`);
    await m.fill('input[name="email"]', owner.email);
    await m.fill('input[name="password"]', PASSWORD);
    await m.click('button[type="submit"]');
    await m.waitForURL(/\/dashboard/, { timeout: 20000 });
    await m.goto(queue);
    await m.locator(tid("bulk-toolbar")).waitFor({ timeout: 10000 });
    check(await m.evaluate(() => document.documentElement.classList.contains("dark")), "System theme + OS dark scheme resolves to dark on mobile");
    await m.click(tid("bulk-select-all"));
    await m.click(tid("bulk-approve-start"));
    await shown(m.locator(tid("bulk-confirm")));
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 0, `mobile: no horizontal scroll (${overflow}px)`);
    const box = await m.locator(tid("bulk-confirm-submit")).boundingBox();
    check(box && box.x >= 0 && box.x + box.width <= 390, "mobile: confirm button inside the viewport");
    await shot(m, "bulk-confirm-mobile-dark");
    await m.click(tid("bulk-confirm-submit"));
    await m.locator(tid("bulk-result")).waitFor({ timeout: 20000 });
    check((await reqStatus(G.requestId)) === "approved" && (await reqStatus(H.requestId)) === "approved", "mobile: both approved (database)");
    await shot(m, "bulk-success-mobile-dark");

    check(browserErrors.length === 0, `no browser errors${browserErrors.length ? `: ${browserErrors.join(" | ")}` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL - unexpected error: ${error.stack || error.message}`);
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? "All bulk approval E2E checks passed." : `${failures} bulk approval E2E check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})();
