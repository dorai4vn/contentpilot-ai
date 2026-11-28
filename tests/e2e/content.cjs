/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * End-to-end test of M2 content management in a real browser against a LOCAL app
 * and a LOCAL, disposable Supabase stack (`npx supabase start`). It signs up fresh
 * users, so email confirmation must be disabled (it is in supabase/config.toml).
 *
 * The test needs direct database access to set up workspace memberships (there is
 * no invitation UI yet) and to verify stored values byte for byte. For that reason
 * it REFUSES to run unless both BASE_URL and LOCAL_DB_URL point to localhost.
 * Never run it against production.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 \
 *   LOCAL_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   node tests/e2e/content.cjs
 */
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const { shown, editorReady } = require("./lib/wait.cjs");

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const DB_URL = process.env.LOCAL_DB_URL || "";
const LOCAL = /^(https?:\/\/|postgres(ql)?:\/\/[^@]*@)(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

if (!LOCAL.test(BASE_URL) || !LOCAL.test(DB_URL)) {
  console.error("Refusing to run: BASE_URL and LOCAL_DB_URL must both point to localhost / 127.0.0.1.");
  process.exit(2);
}

const stamp = Date.now();
const PASSWORD = "e2e-password-123";
const TZ = "Asia/Ho_Chi_Minh"; // UTC+7, no DST: makes the UTC conversion visible
let failures = 0;
const browserErrors = [];

function check(condition, message) {
  if (condition) console.log(`  ok - ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL - ${message}`);
  }
}

/** Runs SQL on the local database and returns the first column of the first row. */
function sql(query) {
  return execFileSync("psql", [DB_URL, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", query], {
    encoding: "utf8",
  }).trim();
}
const q = (value) => `'${String(value).replace(/'/g, "''")}'`;

async function newUser(browser, label) {
  const context = await browser.newContext({ timezoneId: TZ, locale: "en-GB" });
  const page = await context.newPage();
  // Any browser error (including React hydration mismatches) fails the run.
  page.on("pageerror", (error) => browserErrors.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`${label}: ${message.text()}`);
  });
  const email = `${label}-${stamp}@example.test`;
  await page.goto(`${BASE_URL}/signup`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });
  const id = sql(`select id from auth.users where email = ${q(email)}`);
  return { context, page, email, id };
}

async function text(page, selector) {
  return (await page.locator(selector).first().textContent())?.trim() ?? "";
}

async function waitForVersion(page, version) {
  await page.waitForFunction(
    (v) => document.querySelector('[data-testid="post-version"]')?.textContent?.trim() === `Phiên bản ${v}`,
    version,
    { timeout: 15000 },
  );
}

function postRow(id) {
  return sql(
    `select json_build_object('title', title, 'body', body, 'status', status, 'version', version,
       'scheduled_for', to_json(scheduled_for), 'archived', archived_at is not null)::text
     from public.content_posts where id = ${q(id)}`,
  );
}

(async () => {
  console.log(`Content E2E against ${BASE_URL}`);
  const browser = await chromium.launch();
  try {
    const owner = await newUser(browser, "owner");
    const admin = await newUser(browser, "admin");
    const member = await newUser(browser, "member");
    const outsider = await newUser(browser, "outsider");
    check(Boolean(owner.id && admin.id && member.id && outsider.id), "four users signed up");

    // Owner creates a workspace on the dashboard and opens it.
    const wsName = `E2E Workspace ${stamp}`;
    await owner.page.fill('input[name="name"]', wsName);
    await owner.page.click('button:has-text("Tạo không gian làm việc")');
    const wsLink = owner.page.locator(`[data-testid="workspace-link"]:has-text("${wsName}")`);
    await wsLink.waitFor({ timeout: 15000 });
    const wsHref = await wsLink.getAttribute("href");
    const workspaceId = wsHref.split("/").pop();
    check(/^\/w\/[0-9a-f-]{36}$/.test(wsHref), "dashboard links each workspace to /w/[workspaceId]");

    // Memberships (no invitation UI yet): set up directly in the LOCAL database.
    sql(`insert into public.workspace_members (workspace_id, user_id, role) values
         (${q(workspaceId)}, ${q(admin.id)}, 'admin'), (${q(workspaceId)}, ${q(member.id)}, 'member')`);

    // 1. Owner: create a project ------------------------------------------------
    await wsLink.click();
    await owner.page.waitForURL(new RegExp(`/w/${workspaceId}$`));
    await owner.page.goto(`${BASE_URL}/w/${workspaceId}/studio`); // legacy Content Studio moved under /studio
    check((await text(owner.page, '[data-testid="workspace-title"]')) === wsName, "workspace page shows its name");
    check(await shown(owner.page.locator('[data-testid="empty-state"]')), "empty state before the first project");
    const projectName = `Blog ${stamp}`;
    await owner.page.fill("#new-project-name", projectName);
    await owner.page.fill("#new-project-description", "Company blog");
    await owner.page.click('[data-testid="create-project-submit"]');
    await owner.page.locator(`[data-testid="project-link"]:has-text("${projectName}")`).waitFor({ timeout: 15000 });
    check(await shown(owner.page.locator('[data-testid="create-project-success"]')), "project created with a success message");

    // 2. Owner: create a post with a schedule in local time ----------------------
    await owner.page.click(`[data-testid="project-link"]:has-text("${projectName}")`);
    await owner.page.waitForURL(/\/p\/[0-9a-f-]{36}$/);
    const projectUrl = owner.page.url();
    const projectId = projectUrl.split("/").pop();
    await owner.page.click('[data-testid="new-post-toggle"]');
    await owner.page.fill("#new-post-title", "Launch announcement");
    await owner.page.fill("#new-post-body", "First draft of the launch post.");
    await owner.page.fill('[data-testid="schedule-input"]', "2026-12-01T09:00");
    check(
      (await owner.page.locator('[data-testid="schedule-iso"]').inputValue()) === "2026-12-01T02:00:00.000Z",
      "local 09:00 (UTC+7) is submitted as 2026-12-01T02:00:00.000Z",
    );
    await owner.page.click('[data-testid="create-post-submit"]');
    await owner.page.waitForURL(/\/posts\/[0-9a-f-]{36}$/, { timeout: 15000 });
    const postUrl = owner.page.url();
    const postId = postUrl.split("/").pop();
    await waitForVersion(owner.page, 1);
    let row = JSON.parse(postRow(postId));
    check(row.status === "draft" && row.version === 1, "post stored as draft, version 1");
    check(new Date(row.scheduled_for).toISOString() === "2026-12-01T02:00:00.000Z", "schedule stored in UTC");
    check(
      (await owner.page.locator('[data-testid="schedule-input"]').inputValue()) === "2026-12-01T09:00",
      "editor shows the schedule back in local time",
    );

    // 3. Edit the body ------------------------------------------------------------
    await editorReady(owner.page);
    await owner.page.fill("#post-body", "Second draft of the launch post.");
    await owner.page.click('[data-testid="save-post"]');
    await waitForVersion(owner.page, 2);
    check(await shown(owner.page.locator('[data-testid="save-post-success"]')), "save shows a success message");
    row = JSON.parse(postRow(postId));
    check(row.body === "Second draft of the launch post." && row.version === 2, "edit stored as version 2");
    check(new Date(row.scheduled_for).toISOString() === "2026-12-01T02:00:00.000Z", "saving the body kept the schedule");

    // 4. Data and history survive a refresh ----------------------------------------
    await owner.page.reload();
    await waitForVersion(owner.page, 2);
    check((await owner.page.locator("#post-body").inputValue()) === "Second draft of the launch post.", "body persisted after refresh");
    check((await owner.page.locator('[data-testid="version-item"]').count()) === 2, "history lists 2 versions after refresh");

    // 5. Status switch changes only the status ---------------------------------------
    const before = JSON.parse(postRow(postId));
    await owner.page.click('[data-testid="mark-ready"]');
    await waitForVersion(owner.page, 3);
    const after = JSON.parse(postRow(postId));
    check(after.status === "ready" && after.version === 3, "draft -> ready stored as version 3");
    check(
      after.title === before.title && after.body === before.body && after.scheduled_for === before.scheduled_for,
      "draft -> ready kept title, body and scheduled_for identical",
    );
    check((await text(owner.page, '[data-testid="status-badge"]')) === "Sẵn sàng", "status badge shows Sẵn sàng");
    check((await owner.page.locator('[data-testid="version-item"]').first().textContent()).includes("trạng thái → Sẵn sàng"), "history shows the status change");
    // M4: publishing only happens through a human-approved request. The post page may
    // offer "Gửi yêu cầu xuất bản" but never a button that publishes directly.
    // Control first: the publish card is rendered, so the absence check below is meaningful.
    check(
      await shown(owner.page.locator('[data-testid="request-publish-submit"]:has-text("Gửi yêu cầu xuất bản")')),
      "the post page offers 'Gửi yêu cầu xuất bản' (request only)",
    );
    check(
      (await owner.page.locator('button:text-is("Publish"), button:text-is("Xuất bản"), [data-testid="approve-start"], [data-testid="approve-confirm-submit"]').count()) === 0,
      "no direct publish or approve button on the post page",
    );
    check((await owner.page.locator('button:has-text("Delete"), button:has-text("Xóa")').count()) === 0, "no delete button");
    check((await owner.page.locator("html").getAttribute("lang")) === "vi", "page language is Vietnamese (lang=vi)");

    // 5b. Regression: values that validation would normalise survive a status switch.
    const spacedId = sql(
      `begin;
       select set_config('request.jwt.claims', ${q(JSON.stringify({ sub: owner.id, role: "authenticated" }))}, true);
       set local role authenticated;
       insert into public.content_posts (workspace_id, project_id, title, body, scheduled_for)
       values (${q(workspaceId)}, ${q(projectId)}, '  Spaced title  ', e'\\n  indented body \\n', '2026-12-05 03:04:05.123456+00')
       returning id;
       commit;`,
    )
      .split("\n")
      .find((line) => /^[0-9a-f-]{36}$/.test(line));
    const spacedBefore = JSON.parse(postRow(spacedId));
    await owner.page.goto(`${BASE_URL}/w/${workspaceId}/posts/${spacedId}`);
    await waitForVersion(owner.page, 1);
    await owner.page.click('[data-testid="mark-ready"]');
    await waitForVersion(owner.page, 2);
    await owner.page.click('[data-testid="back-to-draft"]');
    await waitForVersion(owner.page, 3);
    const spacedAfter = JSON.parse(postRow(spacedId));
    check(
      spacedAfter.title === "  Spaced title  " &&
        spacedAfter.body === spacedBefore.body &&
        spacedAfter.scheduled_for === spacedBefore.scheduled_for &&
        spacedAfter.status === "draft",
      `status round trip kept spaced title, body and microsecond schedule (${spacedAfter.scheduled_for})`,
    );

    // 6. Filters and schedule on the project page ---------------------------------------
    await owner.page.goto(`${projectUrl}?filter=ready`);
    let titles = await owner.page.locator('[data-testid="post-title"]').allTextContents();
    check(titles.includes("Launch announcement") && !titles.some((t) => t.includes("Spaced title")), "Ready filter shows only ready posts");
    await owner.page.goto(`${projectUrl}?filter=draft`);
    titles = await owner.page.locator('[data-testid="post-title"]').allTextContents();
    check(!titles.includes("Launch announcement") && titles.some((t) => t.includes("Spaced title")), "Draft filter shows only drafts");
    await owner.page.goto(projectUrl);
    // Dates render in UTC on the server and switch to local time after hydration.
    await owner.page.waitForFunction(
      () => ![...document.querySelectorAll('[data-testid="post-schedule"] time')].some((t) => t.textContent.includes("UTC")),
      null,
      { timeout: 15000 },
    );
    const schedule = await owner.page
      .locator('[data-testid="post-item"]:has-text("Launch announcement") [data-testid="post-schedule"]')
      .textContent();
    check(schedule.includes("01/12/2026 09:00"), `list shows the planned date in Vietnamese local format (${schedule.trim()})`);

    // 7. Version conflict between two editors --------------------------------------------
    await owner.page.goto(postUrl);
    await admin.page.goto(postUrl);
    await waitForVersion(owner.page, 3);
    await waitForVersion(admin.page, 3);
    await editorReady(owner.page);
    await owner.page.fill("#post-body", "Owner's final text.");
    await owner.page.click('[data-testid="save-post"]');
    await waitForVersion(owner.page, 4);
    await editorReady(admin.page);
    await admin.page.fill("#post-body", "Admin's competing text.");
    await admin.page.click('[data-testid="save-post"]');
    await admin.page.locator('[data-testid="version-conflict"]').waitFor({ timeout: 15000 });
    check(true, "second editor sees the version-conflict banner");
    row = JSON.parse(postRow(postId));
    check(row.body === "Owner's final text." && row.version === 4, "conflicting save did not overwrite the first save");
    check((await admin.page.locator('[data-testid="version-conflict"]').textContent()).includes("Admin's competing text."), "banner keeps the unsaved text");
    await admin.page.click('[data-testid="load-latest"]');
    await waitForVersion(admin.page, 4);
    check((await admin.page.locator("#post-body").inputValue()) === "Owner's final text.", "load latest shows the newest content");

    // 7b. Hydration safety: the editor is read-only until hydrated ------------------------
    // Uses its own post (in a new tab) so the versions of the main post stay as expected.
    {
      const tab = await owner.context.newPage();
      tab.on("pageerror", (error) => browserErrors.push(`owner-tab: ${error.message}`));
      await tab.goto(projectUrl);
      await tab.click('[data-testid="new-post-toggle"]');
      await tab.fill("#new-post-title", "Hydration check");
      await tab.fill("#new-post-body", "Original text.");
      await tab.click('[data-testid="create-post-submit"]');
      await tab.waitForURL(/\/posts\/[0-9a-f-]{36}$/, { timeout: 15000 });
      const hydrationUrl = tab.url();
      const hydrationPostId = hydrationUrl.split("/").pop();

      // Hold the JavaScript (not the CSS, which React needs to reveal streamed content).
      const held = [];
      const jsChunks = (url) => url.pathname.startsWith("/_next/static/chunks/") && url.pathname.endsWith(".js");
      await tab.route(jsChunks, (route) => held.push(route));
      await tab.goto(hydrationUrl, { waitUntil: "commit" });
      await tab.locator("#post-body").waitFor({ state: "attached", timeout: 15000 });
      check(
        (await tab.locator('[data-testid="post-editor-form"]').getAttribute("data-ready")) === "false",
        "before hydration the editor reports data-ready=false",
      );
      check(await tab.locator("#post-body").evaluate((el) => el.readOnly), "before hydration the body is read-only");
      check(await tab.locator("#post-title").evaluate((el) => el.readOnly), "before hydration the title is read-only");
      check(await tab.locator('[data-testid="save-post"]').isDisabled(), "before hydration Save cannot be pressed");
      await tab.locator("#post-body").focus();
      await tab.keyboard.type("typed too early ");
      check((await tab.locator("#post-body").inputValue()) === "Original text.", "typing before hydration changes nothing");

      await tab.unroute(jsChunks);
      for (const route of held) await route.continue().catch(() => {});
      await editorReady(tab);
      check(!(await tab.locator("#post-body").evaluate((el) => el.readOnly)), "after hydration the body is editable");
      await tab.locator("#post-body").focus();
      await tab.keyboard.press("Control+A");
      await tab.keyboard.type("Replaced after hydration.");
      check((await tab.locator("#post-body").inputValue()) === "Replaced after hydration.", "select all + type replaces the text after hydration");
      await tab.click('[data-testid="save-post"]');
      await waitForVersion(tab, 2);
      const saved = JSON.parse(postRow(hydrationPostId));
      check(saved.body === "Replaced after hydration." && saved.version === 2, "after hydration the edit is saved (database)");
      await tab.close();
    }

    // 8. Archive and restore a post ------------------------------------------------------
    await owner.page.reload();
    await waitForVersion(owner.page, 4);
    await owner.page.click('[data-testid="archive-post"]');
    await owner.page.locator('[data-testid="post-archived-notice"]').waitFor({ timeout: 15000 });
    check(await owner.page.locator("#post-title").isDisabled(), "archived post is read-only");
    check(JSON.parse(postRow(postId)).archived === true, "post archived in the database");
    await owner.page.click('[data-testid="restore-post"]');
    await waitForVersion(owner.page, 6);
    check(!(await owner.page.locator("#post-title").isDisabled()), "restored post is editable again");
    check(JSON.parse(postRow(postId)).archived === false, "post restored in the database");

    // 9. Member permissions -----------------------------------------------------------------
    await member.page.goto(`${BASE_URL}/w/${workspaceId}/studio`);
    check(await shown(member.page.locator('[data-testid="member-notice"]')), "member sees the read-only notice");
    check((await member.page.locator('[data-testid="create-project-form"]').count()) === 0, "member has no create-project form");
    check((await member.page.locator('[data-testid="archive-project"], [data-testid="edit-project"]').count()) === 0, "member has no project edit/archive buttons");
    await member.page.click(`[data-testid="project-link"]:has-text("${projectName}")`);
    await member.page.waitForURL(/\/p\//);
    await member.page.click('[data-testid="new-post-toggle"]');
    await member.page.fill("#new-post-title", "Member post");
    await member.page.click('[data-testid="create-post-submit"]');
    await member.page.waitForURL(/\/posts\//, { timeout: 15000 });
    check(true, "member can create a post");

    // 10. Admin archives and restores the project ---------------------------------------------
    await admin.page.goto(`${BASE_URL}/w/${workspaceId}/studio`);
    check(await shown(admin.page.locator('[data-testid="create-project-form"]')), "admin can create projects");
    await admin.page.locator(`[data-testid="project-item"]:has-text("${projectName}") [data-testid="archive-project"]`).click();
    await admin.page
      .locator(`[data-testid="project-list"] [data-testid="project-item"]:has-text("${projectName}")`)
      .waitFor({ state: "detached", timeout: 15000 });
    check(
      sql(`select archived_at is not null from public.content_projects where id = ${q(projectId)}`) === "t",
      "admin archived the project (database)",
    );
    await admin.page.goto(`${BASE_URL}/w/${workspaceId}/studio?view=archived`);
    check(await shown(admin.page.locator(`[data-testid="project-item"]:has-text("${projectName}")`)), "archived project listed under Archived");
    await member.page.goto(projectUrl);
    check(await shown(member.page.locator('[data-testid="project-archived-notice"]')), "archived project is read-only for members");
    check((await member.page.locator('[data-testid="create-post-form"]').count()) === 0, "no new posts in an archived project");
    await admin.page.locator(`[data-testid="project-item"]:has-text("${projectName}") [data-testid="restore-project"]`).click();
    await admin.page.locator(`[data-testid="project-item"]:has-text("${projectName}")`).waitFor({ state: "detached", timeout: 15000 });
    check(sql(`select archived_at is null from public.content_projects where id = ${q(projectId)}`) === "t", "project restored");

    // 11. Outsider cannot open the workspace ------------------------------------------------------
    const response = await outsider.page.goto(`${BASE_URL}/w/${workspaceId}`);
    check(response.status() === 404, `outsider gets 404 for the workspace (status ${response.status()})`);
    check((await outsider.page.locator("body").textContent()).includes("Không tìm thấy"), "404 page is in Vietnamese");
    const postResponse = await outsider.page.goto(postUrl);
    check(postResponse.status() === 404, "outsider gets 404 for the post");
    // Expected 404 responses for the outsider are logged by the browser as failed loads.
    const unexpected = browserErrors.filter((e) => !(e.startsWith("outsider:") && e.includes("404")));
    check(unexpected.length === 0, `no browser errors or hydration warnings${unexpected.length ? `: ${unexpected.join(" | ")}` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL - unexpected error: ${error.message}`);
  } finally {
    await browser.close();
  }

  console.log(failures === 0 ? "All content E2E checks passed." : `${failures} content E2E check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})();
