/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Browser test of the M3 AI assistant page (/w/[workspaceId]/agent) against a
 * LOCAL app and a LOCAL, disposable Supabase stack (`npx supabase start`).
 *
 * - Real: sign-up, workspace/project/post data, RLS, the agent_actions log and
 *   the "Recent AI activity" list (seeded as the signed-in user, under RLS).
 * - Mocked: only POST /api/agent, intercepted IN THE BROWSER by Playwright, so
 *   OpenAI is never called. Start the app with dummy OPENAI_API_KEY /
 *   OPENAI_MODEL values so the page shows the chat (they are never used).
 *
 * Refuses to run unless BASE_URL and LOCAL_DB_URL both point to localhost.
 * Never run it against production or a Vercel Preview.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-test-local-dummy-00000000000000000000 OPENAI_MODEL=test-model npx next start -p 3000
 *   BASE_URL=http://localhost:3000 \
 *   LOCAL_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   [SCREENSHOT_DIR=/tmp/shots] node tests/e2e/agent-ui.cjs
 */
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
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
  return execFileSync("psql", [DB_URL, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", query], {
    encoding: "utf8",
  }).trim();
}

/** Runs SQL as the given user with RLS (role authenticated + JWT sub), like PostgREST. */
function sqlAsUser(userId, query) {
  return sql(
    `begin; select set_config('request.jwt.claims', '${JSON.stringify({ sub: userId, role: "authenticated" })}', true);
     set local role authenticated; ${query}; commit;`,
  );
}

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

function watchErrors(page, label) {
  page.on("pageerror", (e) => browserErrors.push(`${label}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && browserErrors.push(`${label}: ${m.text()}`));
}

/** Mocked /api/agent responses, served in order. Records what the page sent. */
function mockAgentApi(page, responses) {
  const sent = [];
  return page
    .route("**/api/agent", async (route) => {
      sent.push(JSON.parse(route.request().postData() || "null"));
      const next = responses.shift() || { status: 500, body: { error: { code: "internal_error", message: "x" } } };
      await route.fulfill({
        status: next.status,
        contentType: "application/json",
        headers: next.headers || {},
        body: JSON.stringify(next.body),
      });
    })
    .then(() => sent);
}

const success = (turnId, reply, actions, stopReason = "completed") => ({
  status: 200,
  body: {
    turnId,
    reply,
    actions,
    stopReason,
    stats: {
      toolCalls: actions.length,
      writes: actions.filter((a) => a.kind !== "read").length,
      logging: { recorded: actions.length, failed: 0 },
    },
  },
});
const apiError = (status, code, message, headers) => ({ status, headers, body: { error: { code, message } } });

async function ask(page, text) {
  await page.fill('[data-testid="agent-input"]', text);
  await page.click('[data-testid="agent-send"]');
}

(async () => {
  console.log(`Agent UI E2E against ${BASE_URL}`);
  const browser = await chromium.launch();
  try {
    // --- Setup: a real user, workspace, project and posts in the LOCAL database ------------------
    const desktop = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
      timezoneId: TZ,
      locale: "vi-VN",
    });
    const page = await desktop.newPage();
    watchErrors(page, "desktop");
    const email = `agent-ui-${Date.now()}@example.test`;
    await page.goto(`${BASE_URL}/signup`);
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/dashboard/, { timeout: 20000 });
    await page.fill('input[name="name"]', "Studio Nội dung");
    await page.click('button:has-text("Tạo không gian làm việc")');
    const wsLink = page.locator('[data-testid="workspace-link"]').first();
    await wsLink.waitFor({ timeout: 15000 });
    const ws = (await wsLink.getAttribute("href")).split("/").pop();
    const uid = sql(`select id from auth.users where email = '${email}'`);

    const project = randomUUID();
    const post1 = randomUUID();
    const post2 = randomUUID();
    const turn = randomUUID();
    sqlAsUser(uid, `insert into public.content_projects (id, workspace_id, name) values ('${project}', '${ws}', 'Blog công ty')`);
    sqlAsUser(
      uid,
      `insert into public.content_posts (id, workspace_id, project_id, title, body) values ('${post1}', '${ws}', '${project}', 'Giới thiệu sản phẩm', 'Bản nháp đầu tiên')`,
    );
    // An agent-written post with a real agent version, so the log rows below are accepted by RLS.
    sqlAsUser(
      uid,
      `insert into public.content_posts (id, workspace_id, project_id, title, body, last_change_source) values ('${post2}', '${ws}', '${project}', 'Bài do AI tạo', 'Mở đầu', 'agent')`,
    );
    sqlAsUser(uid, `select public.update_content_post('${post2}', 1, 'Bài do AI tạo', 'Rút gọn', 'draft', null, 'agent')`);
    const log = (cols, vals) =>
      sqlAsUser(uid, `insert into public.agent_actions (workspace_id, turn_id, ${cols}) values ('${ws}', '${turn}', ${vals})`);
    log("tool, kind, status, post_id, version_after", `'get_post', 'read', 'success', '${post1}', 1`);
    log("tool, kind, status, project_id, post_id, version_after", `'create_post', 'create', 'success', '${project}', '${post2}', 1`);
    log(
      "tool, kind, status, project_id, post_id, version_before, version_after, fields",
      `'update_post', 'update', 'success', '${project}', '${post2}', 1, 2, array['body']`,
    );
    log("tool, kind, status, error_code, post_id", `'update_post', 'update', 'error', 'version_conflict', '${post1}'`);

    // --- 1. Entry points and page --------------------------------------------------------------
    await page.goto(`${BASE_URL}/w/${ws}`);
    check(
      (await page.locator('[data-testid="open-agent"]').getAttribute("href")) === `/w/${ws}/agent`,
      "workspace page links to Trợ lý AI",
    );
    await page.goto(`${BASE_URL}/w/${ws}/p/${project}`);
    await page.click('[data-testid="open-agent"]');
    await page.waitForURL(new RegExp(`/w/${ws}/agent\\?project=${project}$`));
    await page.locator('[data-testid="agent-privacy-notice"]').waitFor();
    check(await shown(page.locator('[data-testid="agent-chat"]')), "chat is shown (agent configured)");
    check(
      (await page.locator('[data-testid="agent-privacy-notice"]').textContent()).includes("OpenAI"),
      "notice says content is processed by OpenAI",
    );
    check((await page.locator('[data-testid="agent-project-select"]').inputValue()) === project, "project preselected from the link");

    // --- 2. Recent AI activity: real agent_actions rows read under RLS -------------------------
    const activity = page.locator('[data-testid="agent-activity"] [data-testid="action-item"]');
    check((await activity.count()) === 4, "recent AI activity lists the 4 logged actions from the database");
    const activityText = await page.locator('[data-testid="agent-activity"]').textContent();
    check(activityText.includes("Phiên bản 1 → 2") && activityText.includes("Thất bại"), "activity shows versions and failures");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/agent-desktop-empty.png`, fullPage: true });

    // --- 3. Suggestions, sending and server-reported actions (mocked /api/agent) ---------------
    const sent = await mockAgentApi(page, [
      success(turn, "Mình đã đọc bài “Giới thiệu sản phẩm” và rút gọn phần nội dung.", [
        { tool: "get_post", label: "x", kind: "read", status: "success", effect: { kind: "read", postId: post1, versionAfter: 1 }, log: "recorded" },
        {
          tool: "update_post",
          label: "x",
          kind: "update",
          status: "success",
          effect: { kind: "update", postId: post1, projectId: project, versionBefore: 1, versionAfter: 2, fields: ["body"] },
          log: "recorded",
        },
      ]),
      success(
        turn,
        "Mình đã tạo một bài nháp nhưng dịch vụ AI gặp lỗi trước khi hoàn tất.",
        [
          { tool: "create_post", label: "x", kind: "create", status: "success", effect: { kind: "create", postId: post2, projectId: project, versionAfter: 1 }, log: "recorded" },
          { tool: "update_post", label: "x", kind: "update", status: "error", code: "not_draft", log: "recorded" },
        ],
        "model_error",
      ),
      apiError(502, "service_unavailable", "Dịch vụ AI tạm thời không phản hồi. Vui lòng thử lại sau."),
      apiError(504, "timeout", "Trợ lý AI phản hồi quá lâu. Vui lòng thử lại."),
      apiError(429, "rate_limited", "Bạn gửi yêu cầu quá nhanh. Vui lòng đợi một chút rồi thử lại.", { "retry-after": "30" }),
    ]);

    check((await page.locator('[data-testid="agent-suggestions"] button').count()) === 4, "4 quick suggestions shown");
    check(await page.locator('[data-testid="agent-send"]').isDisabled(), "send is disabled while the input is empty");
    await page.locator('[data-testid="agent-suggestions"] button').nth(3).click();
    const suggested = await page.locator('[data-testid="agent-input"]').inputValue();
    check(suggested.startsWith("Đọc bài viết"), "a suggestion fills the input (without sending)");
    check(sent.length === 0, "nothing sent before pressing Gửi");
    await page.click('[data-testid="agent-send"]');
    const firstReply = page.locator('[data-testid="chat-assistant"]').first();
    await firstReply.waitFor({ timeout: 15000 });

    check(
      JSON.stringify(Object.keys(sent[0]).sort()) === JSON.stringify(["messages", "projectId", "timeZone", "workspaceId"]),
      `request has only the schema fields (${Object.keys(sent[0]).join(", ")})`,
    );
    check(sent[0].workspaceId === ws && sent[0].projectId === project, "request carries the workspace and selected project");
    check(["Asia/Ho_Chi_Minh", "Asia/Saigon"].includes(sent[0].timeZone), `request carries the browser time zone (${sent[0].timeZone})`);
    check(!/userId|user_id|"role"\s*:\s*"(owner|admin|member)"|apiKey|sk-/.test(JSON.stringify(sent[0])), "no user id, role or key sent");
    check(
      sent[0].messages.length === 1 && sent[0].messages[0].role === "user" && sent[0].messages[0].content === suggested,
      "first request contains only the user's question",
    );
    check((await page.locator('[data-testid="chat-user"]').first().textContent()).trim() === suggested, "the question is shown in the chat");
    check((await firstReply.textContent()).includes("Thao tác đã thực hiện"), "reply has 'Thao tác đã thực hiện'");
    const firstItems = firstReply.locator('[data-testid="action-item"]');
    check((await firstItems.count()) === 2, "reply lists the 2 actions reported by the server");
    check((await firstItems.nth(1).textContent()).includes("Cập nhật bài viết"), "actions use Vietnamese tool names");
    check((await firstItems.nth(1).textContent()).includes("Phiên bản 1 → 2"), "update shows version before → after");
    check(
      (await firstReply.locator('[data-testid="action-post-link"]').first().getAttribute("href")) === `/w/${ws}/posts/${post1}`,
      "action links to the post",
    );

    // --- 4. Partial result -------------------------------------------------------------------
    await ask(page, "Tạo thêm một bài nháp về khuyến mãi");
    await page.locator('[data-testid="agent-partial"]').waitFor({ timeout: 15000 });
    check(true, "partial-result warning when the agent stopped after a write");
    const secondReply = page.locator('[data-testid="chat-assistant"]').nth(1);
    check(
      (await secondReply.locator('[data-testid="action-item"][data-status="success"]').count()) === 1 &&
        (await secondReply.locator('[data-testid="action-item"][data-status="error"]').count()) === 1,
      "partial reply shows one success and one failure",
    );
    check(
      sent[1].messages.length === 3 && sent[1].messages[1].role === "assistant" && sent[1].messages[2].role === "user",
      "follow-up sends the session history (user, assistant, user)",
    );

    // --- 5. API errors ------------------------------------------------------------------------
    await ask(page, "Viết thêm một bài");
    await page.locator('[data-testid="chat-error"][data-kind="service"]').waitFor({ timeout: 15000 });
    check(true, "502 shows the 'service unavailable' message");
    await ask(page, "Thử lại");
    await page.locator('[data-testid="chat-error"][data-kind="timeout"]').waitFor({ timeout: 15000 });
    check(true, "504 shows the timeout message");
    check(
      !sent[3].messages.some((m) => m.content.includes("Dịch vụ AI tạm thời")),
      "error messages are not sent back to the API as chat history",
    );

    // --- 6. Rate limit ------------------------------------------------------------------------
    await ask(page, "Làm thêm nữa");
    await page.locator('[data-testid="chat-error"][data-kind="rate_limited"]').waitFor({ timeout: 15000 });
    check(await shown(page.locator('[data-testid="agent-cooldown"]')), "rate limit shows a countdown");
    await page.fill('[data-testid="agent-input"]', "Gửi ngay");
    check(await page.locator('[data-testid="agent-send"]').isDisabled(), "send stays disabled during the countdown");
    const sentBefore = sent.length;
    await page.press('[data-testid="agent-input"]', "Enter");
    await page.waitForTimeout(300);
    check(sent.length === sentBefore, "Enter does not send during the countdown");
    check(await noOverflow(page), "desktop: no horizontal overflow with replies");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/agent-desktop-chat.png`, fullPage: true });

    // --- 7. Refresh: chat kept in this browser tab (sessionStorage), log from the database -----
    await page.reload();
    await page.locator('[data-testid="chat-assistant"]').first().waitFor({ timeout: 15000 });
    check((await page.locator('[data-testid="chat-assistant"]').count()) === 2, "after refresh: both replies are still shown");
    check((await page.locator('[data-testid="chat-error"]').count()) === 3, "after refresh: the error notices are still shown");
    check((await activity.count()) === 4, "after refresh: recent activity still read from the database");
    check(
      sql(`select count(*) from public.agent_actions where workspace_id = '${ws}'`) === "4",
      "the mocked chat added no rows to agent_actions",
    );
    check(
      sql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name ~ '(chat|message|conversation)'`) === "0",
      "no database table stores chat messages",
    );
    await page.click('[data-testid="agent-reset"]');
    check((await page.locator('[data-testid="agent-empty"]').count()) === 1, "'Cuộc trò chuyện mới' clears the chat");

    // --- 8. Mobile with a reply and its actions ---------------------------------------------------
    const mobile = await browser.newContext({
      ...devices["iPhone 13"],
      timezoneId: TZ,
      locale: "vi-VN",
      storageState: await desktop.storageState(),
    });
    const phone = await mobile.newPage();
    watchErrors(phone, "mobile");
    await mockAgentApi(phone, [
      success(turn, "Mình đã tạo bài nháp “Khuyến mãi cuối năm” trong dự án Blog công ty.", [
        { tool: "list_projects", label: "x", kind: "read", status: "success", effect: { kind: "read" }, log: "recorded" },
        { tool: "create_post", label: "x", kind: "create", status: "success", effect: { kind: "create", postId: post2, projectId: project, versionAfter: 1 }, log: "recorded" },
        { tool: "update_post", label: "x", kind: "update", status: "skipped", code: "read_required", effect: { kind: "update", postId: post1 }, log: "failed" },
      ]),
    ]);
    await phone.goto(`${BASE_URL}/w/${ws}/agent`);
    await phone.locator('[data-testid="agent-privacy-notice"]').waitFor();
    check(await noOverflow(phone), "mobile: no horizontal overflow (empty chat)");
    await ask(phone, "Tạo bài nháp khuyến mãi cuối năm cho dự án Blog công ty, kèm lịch đăng 9 giờ sáng thứ Hai");
    const mobileReply = phone.locator('[data-testid="chat-assistant"]').first();
    await mobileReply.waitFor({ timeout: 15000 });
    check((await mobileReply.locator('[data-testid="action-item"]').count()) === 3, "mobile: reply shows its 3 actions");
    check(await shown(mobileReply.locator('[data-testid="action-post-link"]').first()), "mobile: post link visible");
    check((await mobileReply.textContent()).includes("Chưa ghi được nhật ký"), "mobile: a logging failure is flagged on the action");
    check(await noOverflow(phone), "mobile: no horizontal overflow with a reply and its actions");
    const box = await mobileReply.boundingBox();
    const viewport = phone.viewportSize();
    check(box && box.x >= 0 && box.x + box.width <= viewport.width, "mobile: the reply fits inside the screen width");
    await phone.locator('[data-testid="agent-form"]').scrollIntoViewIfNeeded();
    check(await shown(phone.locator('[data-testid="agent-send"]')), "mobile: the send button is reachable");
    if (SHOTS) await phone.screenshot({ path: `${SHOTS}/agent-mobile-chat.png`, fullPage: true });

    // Expected: the 429 from step 6 is logged by the browser as a failed resource load.
    const unexpected = browserErrors.filter((e) => !/status of (429|502|504)/.test(e));
    check(unexpected.length === 0, `no unexpected browser errors${unexpected.length ? `: ${unexpected.join(" | ")}` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL - unexpected error: ${error.message}`);
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? "All agent UI E2E checks passed." : `${failures} agent UI E2E check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})();
