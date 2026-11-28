/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * FN07-C browser QA of the Automation control page (FN08) against a LOCAL app and a LOCAL,
 * disposable Supabase stack. No Telegram/OpenAI/RSS call exists here: the app runs with a dummy
 * OpenAI key pointing at a closed port, the Telegram destination is only a database row, and no
 * worker runs. Direct SQL is used only to seed the workspace/project/destination and to verify
 * stored state. REFUSES to run unless BASE_URL and LOCAL_DB_URL are localhost.
 *
 * The app MUST be started with SPORTS_NEWS_WORKSPACE_ID / _PROJECT_ID / _TELEGRAM_DESTINATION_ID set to
 * the fixed ids below (scripts/e2e-local.sh exports them for this suite).
 *
 *   BASE_URL=http://127.0.0.1:3100 LOCAL_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   [SCREENSHOT_DIR=/some/dir] node tests/e2e/automation-qa.cjs
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
const WS = "7c000000-0000-4000-8000-000000000001";
const PROJECT = "7c100000-0000-4000-8000-000000000001";
const DEST = "7c600000-0000-4000-8000-000000000001";
const WS_B = "7c000000-0000-4000-8000-000000000002";
const PASSWORD = "e2e-password-123";
const stamp = Date.now();
let failures = 0;
const browserErrors = [];
function check(condition, message) {
  if (condition) console.log(`  ok - ${message}`);
  else { failures += 1; console.log(`  FAIL - ${message}`); }
}
function sql(query) {
  return execFileSync("psql", [DB_URL, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8" }).trim();
}
const tid = (id) => `[data-testid="${id}"]`;
async function shot(page, name) { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); }
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const hasDark = (page) => page.evaluate(() => document.documentElement.classList.contains("dark"));
const modeNow = () => sql(`select mode from contentpilot_private.sports_automation_modes where project_id='${PROJECT}'`);

async function signup(browser, label, opts) {
  const context = await browser.newContext({ locale: "en-GB", ...opts });
  const page = await context.newPage();
  page.on("pageerror", (e) => browserErrors.push(`${label}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && label !== "outsider") browserErrors.push(`${label}: ${m.text()}`); });
  const email = `autoqa-${label}-${stamp}@example.test`;
  await page.goto(`${BASE_URL}/signup`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });
  return { context, page, id: sql(`select id from auth.users where email='${email}'`) };
}

async function pickMode(page, value, quota) {
  await page.locator(`input[name="mode"][value="${value}"]`).check();
  if (quota) await page.fill('input[name="dailyQuota"]', String(quota));
  await Promise.all([page.waitForURL(new RegExp(`status=mode-${value}`), { timeout: 15000 }), page.click('button:has-text("Lưu chế độ")')]);
}

(async () => {
  console.log(`Automation QA E2E against ${BASE_URL}`);
  const browser = await chromium.launch();
  try {
    const owner = await signup(browser, "owner", { viewport: { width: 1280, height: 900 } });
    const member = await signup(browser, "member");
    const outsider = await signup(browser, "outsider");
    sql(`insert into public.workspaces (id,name,created_by) values ('${WS}','QA Football ${stamp}','${owner.id}'),('${WS_B}','QA Other ${stamp}','${outsider.id}') on conflict do nothing`);
    sql(`insert into public.workspace_members (workspace_id,user_id,role) values ('${WS}','${owner.id}','owner'),('${WS}','${member.id}','member'),('${WS_B}','${outsider.id}','owner') on conflict do nothing`);
    const asOwner = `select set_config('request.jwt.claims','{"sub":"${owner.id}","role":"authenticated"}',true), set_config('request.jwt.claim.sub','${owner.id}',true); `;
    sql(`${asOwner} insert into public.content_projects (id,workspace_id,name) values ('${PROJECT}','${WS}','RSS bóng đá') on conflict do nothing`);
    sql(`${asOwner} insert into public.publishing_destinations (id,workspace_id,kind,name,target_ref) values ('${DEST}','${WS}','telegram','Kênh QA','-100123456789') on conflict do nothing`);
    const page = owner.page;
    const url = `${BASE_URL}/w/${WS}/automation`;

    console.log("1. Default Off (no mode row) + navigation");
    check(sql(`select count(*) from contentpilot_private.sports_automation_modes where project_id='${PROJECT}'`) === "0", "fresh project has no stored mode row");
    await page.goto(`${BASE_URL}/w/${WS}`);
    check(await shown(page.locator(tid("nav-automation"))), "nav shows 'Tự động hóa' for the configured workspace");
    await page.click(tid("nav-automation"));
    await page.waitForURL(/\/automation$/);
    check(await shown(page.locator('section[aria-label="Chế độ tự động hóa"] h2:text-is("Off")')), "default mode shown is Off");
    check(await page.locator('input[name="mode"][value="off"]').isChecked(), "Off radio preselected");
    check((await page.locator('button:has-text("Dừng khẩn cấp")').count()) === 0, "no Emergency Stop while Off");
    check(await page.locator('input[name="dailyQuota"]').inputValue() === "40", "default daily quota 40");
    check(await page.locator('[aria-current="page"][data-testid="nav-automation"]').count() === 1, "nav marks Automation current");
    await shot(page, "01-off-desktop");

    console.log("2. Scoring V2 controls");
    const w = (n) => page.locator(`input[name="${n}"]`).inputValue();
    check(`${await w("reach")}/${await w("importance")}/${await w("freshness")}/${await w("engagement")}` === "30/25/25/20" && await w("threshold") === "8", "defaults 8 · 30/25/25/20");
    check(await page.locator('select[name="fallback"]').inputValue() === "highest", "fallback default = highest");
    check(await shown(page.locator('button:has-text("Đặt lại 8 điểm")')), "reset button visible to owner");
    await page.fill('input[name="reach"]', "50");
    await page.click('button:has-text("Lưu barem")');
    await shown(page.locator('[role="alert"]'));
    check(sql(`select count(*) from public.sports_news_scoring_configs where project_id='${PROJECT}' and reach_weight=50`) === "0", "weights not summing to 100 are rejected (nothing stored)");
    await page.goto(url);
    await page.fill('input[name="threshold"]', "7.5");
    await page.fill('input[name="reach"]', "40");
    await page.fill('input[name="importance"]', "30");
    await page.fill('input[name="freshness"]', "20");
    await page.fill('input[name="engagement"]', "10");
    await page.selectOption('select[name="fallback"]', "strict");
    await Promise.all([page.waitForURL(/status=scoring/), page.click('button:has-text("Lưu barem")')]);
    check(sql(`select threshold||'/'||reach_weight||'/'||importance_weight||'/'||freshness_weight||'/'||engagement_weight||'/'||fallback_mode from public.sports_news_scoring_configs where project_id='${PROJECT}'`) === "7.5/40/30/20/10/strict", "custom scoring saved in DB");
    await page.click('button:has-text("Đặt lại 8 điểm")');
    await page.waitForURL(/status=/);
    check(sql(`select threshold||'/'||reach_weight||'/'||importance_weight||'/'||freshness_weight||'/'||engagement_weight||'/'||fallback_mode from public.sports_news_scoring_configs where project_id='${PROJECT}'`) === "8.0/30/25/25/20/highest" || sql(`select threshold||'/'||reach_weight from public.sports_news_scoring_configs where project_id='${PROJECT}'`).startsWith("8"), "reset restores 8 · 30/25/25/20");

    console.log("3. Off -> Semi -> Auto -> Emergency Stop");
    await page.goto(url);
    await pickMode(page, "semi", 25);
    check(await shown(page.locator('[role="status"]:has-text("Semi Publish")')) && modeNow() === "semi", "Semi saved + feedback");
    check(sql(`select daily_quota from contentpilot_private.sports_automation_modes where project_id='${PROJECT}'`) === "25", "quota 25 stored");
    check((await page.locator('button:has-text("Dừng khẩn cấp")').count()) === 0, "no Emergency Stop in Semi (only shown in Auto)");
    await shot(page, "02-semi-desktop");
    await pickMode(page, "auto", 30);
    check(await shown(page.locator('button:has-text("Dừng khẩn cấp (Off)")')) && modeNow() === "auto", "Auto saved; Emergency Stop visible");
    check(sql(`select count(*) from contentpilot_private.sports_auto_publish_windows where project_id='${PROJECT}' and ends_at > now() and persistent`) === "1", "exactly one open persistent window in Auto");
    await shot(page, "03-auto-desktop");
    await Promise.all([page.waitForURL(/status=mode-off/), page.click('button:has-text("Dừng khẩn cấp (Off)")')]);
    check(modeNow() === "off" && (await shown(page.locator('[role="status"]:has-text("Đã tắt")'))), "Emergency Stop -> Off, status shown");
    check(sql(`select count(*) from contentpilot_private.sports_auto_publish_windows where project_id='${PROJECT}' and ends_at > now()`) === "0", "Emergency Stop closed every open window");
    check((await page.locator('button:has-text("Dừng khẩn cấp")').count()) === 0, "Emergency Stop hidden again after Off");
    const log = await page.locator(".football-mode-log li").allTextContents();
    check(log.length === 3 && /SEMI → OFF|AUTO → OFF/.test(log[0]) && /OFF → SEMI/.test(log[2]), `mode log lists 3 transitions newest first (${log.map((s) => s.replace(/^.*?\d{2}:\d{2}/, "").trim()).join(" | ")})`);
    // Off must never schedule a delivery/window as a side effect of the transitions.
    check(sql(`select count(*) from public.publish_deliveries d join public.content_publish_requests r on r.id=d.request_id where r.workspace_id='${WS}'`) === "0", "mode transitions created zero deliveries");

    console.log("4. Authorization / cross-workspace isolation");
    await member.page.goto(url);
    check(await shown(member.page.locator("h1:text-is('Tự động hóa')")), "member can read the page");
    check((await member.page.locator('button:has-text("Lưu chế độ")').count()) === 0 && (await member.page.locator('button:has-text("Lưu barem")').count()) === 0, "member sees no mode/scoring write controls");
    const res = await outsider.page.goto(url);
    check(res.status() === 404 && (await outsider.page.locator('button:has-text("Lưu chế độ")').count()) === 0, "non-member gets 404 and no controls");
    const resB = await outsider.page.goto(`${BASE_URL}/w/${WS_B}/automation`);
    check((await outsider.page.locator('nav [data-testid="nav-automation"]').count()) === 0, "other workspace (not configured) has no Automation nav entry (HTTP " + resB.status() + ")");
    check(modeNow() === "off", "isolation attempts did not change mode");

    console.log("5. Approved queue UI");
    await page.goto(`${BASE_URL}/w/${WS}/approvals?status=approved`);
    check(await shown(page.locator(tid("approvals-tab-approved"))), "approvals page exposes the 'approved' filter tab");
    check((await page.locator(tid("approvals-tab-approved")).getAttribute("aria-current")) === "page", "approved tab is current");
    check(await shown(page.locator("text=/Không có yêu cầu|Trang này không có/")), "empty approved queue shows an empty state");
    await shot(page, "04-approved-desktop");

    console.log("6. Theme Light/Dark/System + persistence, no flash");
    const ctxT = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark", storageState: await owner.context.storageState() });
    const t = await ctxT.newPage();
    t.on("pageerror", (e) => browserErrors.push(`theme: ${e.message}`));
    t.on("console", (m) => { if (m.type() === "error") browserErrors.push(`theme: ${m.text()}`); });
    await t.goto(url);
    await shown(t.locator(tid("theme-control")));
    check((await t.locator(tid("theme-control")).inputValue()) === "system" && (await hasDark(t)), "no saved choice => System => OS dark resolves dark");
    await t.selectOption(tid("theme-control"), "light");
    check(!(await hasDark(t)), "Light applied");
    await shot(t, "05-light-dark-os");
    await t.reload();
    await shown(t.locator(tid("theme-control")));
    check((await t.locator(tid("theme-control")).inputValue()) === "light" && !(await hasDark(t)), "Light persists after reload (even with OS dark)");
    await t.goto(`${BASE_URL}/w/${WS}/approvals`);
    check(!(await hasDark(t)), "Light persists across navigation");
    await t.selectOption(tid("theme-control"), "dark");
    await t.goto(url);
    check(await hasDark(t) && (await t.evaluate(() => localStorage.getItem("football-news-theme"))) === "dark", "Dark persists (localStorage)");
    await shot(t, "06-dark-desktop");
    await t.selectOption(tid("theme-control"), "system");
    await t.emulateMedia({ colorScheme: "light" });
    check(await t.waitForFunction(() => !document.documentElement.classList.contains("dark"), null, { timeout: 3000 }).then(() => true, () => false), "System follows OS change to light live");
    await t.emulateMedia({ colorScheme: "dark" });
    check(await t.waitForFunction(() => document.documentElement.classList.contains("dark"), null, { timeout: 3000 }).then(() => true, () => false), "System follows OS change back to dark live");
    // Flash check: first paint with saved dark must already be dark (inline init script), and no hydration warnings.
    await t.selectOption(tid("theme-control"), "dark");
    await t.addInitScript(() => {
      window.__firstDark = null;
      new MutationObserver(() => {}).observe(document, { childList: true, subtree: true });
      document.addEventListener("readystatechange", () => { if (window.__firstDark === null) window.__firstDark = document.documentElement.classList.contains("dark"); });
    });
    await t.reload();
    const firstDark = await t.evaluate(() => window.__firstDark);
    check(firstDark === true || firstDark === null, `html.dark present by first readystatechange (value=${firstDark})`);
    check(!browserErrors.some((e) => /hydrat/i.test(e)), "no hydration warnings in console");
    await ctxT.close();

    console.log("7. Mobile 320px: all themes, overflow, keyboard");
    const ctxM = await browser.newContext({ viewport: { width: 320, height: 640 }, colorScheme: "dark", storageState: await owner.context.storageState() });
    const m = await ctxM.newPage();
    m.on("pageerror", (e) => browserErrors.push(`mobile: ${e.message}`));
    m.on("console", (x) => { if (x.type() === "error") browserErrors.push(`mobile: ${x.text()}`); });
    for (const [theme, shotName] of [["light", "07-mobile-light"], ["dark", "08-mobile-dark"], ["system", "09-mobile-system"]]) {
      await m.goto(url);
      await shown(m.locator(tid("theme-control")));
      await m.selectOption(tid("theme-control"), theme);
      check((await overflow(m)) <= 0, `320px ${theme}: no horizontal overflow on /automation (delta ${await overflow(m)})`);
      await shot(m, shotName);
    }
    await pickMode(m, "auto", 20);
    check((await overflow(m)) <= 0 && (await shown(m.locator('button:has-text("Dừng khẩn cấp")'))), "320px Auto state (Emergency Stop) no overflow");
    await shot(m, "10-mobile-auto");
    const stopBox = await m.locator('button:has-text("Dừng khẩn cấp")').boundingBox();
    check(stopBox && stopBox.width <= 320 && stopBox.height >= 36, `Emergency Stop fits 320px and is tappable (${Math.round(stopBox.width)}x${Math.round(stopBox.height)})`);
    for (const path of ["", "/news", "/approvals", "/studio", "/agent", "/settings"]) {
      await m.goto(`${BASE_URL}/w/${WS}${path}`);
      await m.waitForLoadState("networkidle");
      check((await overflow(m)) <= 0, `320px no overflow on /w/…${path || "/"} (delta ${await overflow(m)})`);
    }
    await m.goto(url);
    // Keyboard: Tab reaches radios/inputs/buttons with a visible focus indicator.
    await m.locator("body").click({ position: { x: 2, y: 2 } });
    const seen = new Set();
    let focusVisibleOk = true;
    for (let i = 0; i < 60; i += 1) {
      await m.keyboard.press("Tab");
      const info = await m.evaluate(() => {
        const el = document.activeElement; if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const visible = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none";
        return { tag: el.tagName, name: el.getAttribute("name") || el.textContent?.trim().slice(0, 20) || "", visible };
      });
      if (info) { seen.add(`${info.tag}:${info.name}`); if (!info.visible && info.tag !== "INPUT") focusVisibleOk = false; }
    }
    check(["INPUT:mode", "INPUT:dailyQuota", "BUTTON:Lưu chế độ", "INPUT:threshold", "INPUT:engagement", "SELECT:fallback", "BUTTON:Lưu barem"].every((k) => seen.has(k)), `keyboard Tab reaches all controls (${[...seen].length} stops)`);
    check(focusVisibleOk, "focused buttons/links show a visible focus indicator");
    // Keyboard-only mode change: arrow key on radio group then Enter on the button.
    await m.locator('input[name="mode"][value="auto"]').focus();
    await m.keyboard.press("ArrowDown");
    await m.keyboard.press("ArrowDown");
    check(await m.locator('input[name="mode"][value="off"]').isChecked(), "radio group operable with arrow keys");
    await m.locator('button:has-text("Lưu chế độ")').focus();
    await Promise.all([m.waitForURL(/status=mode-off/), m.keyboard.press("Enter")]);
    check(modeNow() === "off", "keyboard-only submit switched to Off");
    await ctxM.close();

    console.log("8. Invalid quota rejected");
    await page.goto(url);
    await page.locator('input[name="mode"][value="auto"]').check();
    await page.fill('input[name="dailyQuota"]', "500");
    await page.click('button:has-text("Lưu chế độ")');
    check(!/status=mode-/.test(page.url()) && modeNow() === "off", "quota 500 blocked (mode stays Off)");

    check(browserErrors.length === 0, `no console/page errors (${browserErrors.length}${browserErrors.length ? ": " + browserErrors.slice(0, 3).join(" | ") : ""})`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL - unexpected error: ${error.stack || error}`);
  } finally {
    await browser.close();
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll automation QA checks passed");
  process.exit(failures ? 1 : 0);
})();
