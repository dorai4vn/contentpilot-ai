/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * FN07 regression / UI QA of the FN08 Off/Semi/Auto automation page (evidence script, offline).
 *
 * Runs ONLY against the local disposable Supabase (via `npm run test:e2e:local -- fn07-qa`). It starts its
 * own `next start` on QA_PORT (default 3102) with SPORTS_NEWS_* pointing at fixtures it creates in the LOCAL
 * database. No RSS is fetched, no Telegram/OpenAI call is made (the app has no worker in this process).
 *
 * Covers: auth isolation, default Semi, Off/Semi/Auto transitions + audit log, quota bounds, Emergency Stop,
 * Light/Dark/System persistence, theme flash / hydration, desktop/tablet/mobile overflow, keyboard access,
 * WCAG contrast of the approved design tokens. SHOTS=<dir> stores screenshots.
 */
const { execFileSync, spawn } = require("node:child_process");
const { chromium } = require("playwright");
const { shown } = require("./lib/wait.cjs");

const BASE_URL = process.env.BASE_URL;
const DB_URL = process.env.LOCAL_DB_URL;
const SHOTS = process.env.SHOTS;
const QA_PORT = process.env.QA_PORT || "3102";
const QA_URL = `http://127.0.0.1:${QA_PORT}`;
const PASSWORD = "Qa-Passw0rd-FN07!";
const stamp = Date.now();
if (!BASE_URL || !DB_URL || !/^(https?:\/\/|postgres(ql)?:\/\/[^@]*@)(localhost|127\.0\.0\.1)/.test(BASE_URL + DB_URL)) {
  console.error("Set BASE_URL and LOCAL_DB_URL to LOCAL targets only.");
  process.exit(2);
}

let failures = 0;
function check(ok, message) {
  console.log(`  ${ok ? "ok" : "FAIL"} - ${message}`);
  if (!ok) failures += 1;
}
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
function sql(query) {
  return execFileSync("psql", [DB_URL, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8" }).trim();
}
const browserErrors = [];

async function newUser(browser, label, options = {}) {
  const context = await browser.newContext({ locale: "vi-VN", ...options });
  const page = await context.newPage();
  page.on("pageerror", (e) => browserErrors.push(`${label}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/404|403|Failed to load resource/.test(m.text())) browserErrors.push(`${label}: ${m.text()}`);
  });
  const email = `fn07-${label}-${stamp}@example.test`;
  await page.goto(`${BASE_URL}/signup`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });
  return { context, page, email, id: sql(`select id from auth.users where email = ${q(email)}`) };
}

async function createWorkspace(user, name) {
  await user.page.goto(`${BASE_URL}/dashboard`);
  await user.page.fill('input[name="name"]', name);
  await user.page.click('button:has-text("Tạo không gian làm việc")');
  const link = user.page.locator(`[data-testid="workspace-link"]:has-text("${name}")`);
  await link.waitFor({ timeout: 15000 });
  return (await link.getAttribute("href")).split("/").pop();
}

// WCAG 2.x contrast ratio between two #RRGGBB colours.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

async function run() {
  console.log(`FN07 QA — app ${BASE_URL}, automation app ${QA_URL}`);
  const browser = await chromium.launch();
  let server;
  try {
    const owner = await newUser(browser, "owner", { viewport: { width: 1440, height: 900 } });
    const member = await newUser(browser, "member");
    const outsider = await newUser(browser, "outsider");
    const otherOwner = await newUser(browser, "other");
    const ws = await createWorkspace(owner, `FN07 A ${stamp}`);
    const wsB = await createWorkspace(otherOwner, `FN07 B ${stamp}`);
    sql(`insert into public.workspace_members (workspace_id, user_id, role) values (${q(ws)}, ${q(member.id)}, 'member')`);
    const project = sql(`select set_config('request.jwt.claim.sub', ${q(owner.id)}, true); insert into public.content_projects (workspace_id, name) values (${q(ws)}, 'FN07 RSS') returning id`).split("\n").filter(Boolean).pop();
    const dest = sql(`select set_config('request.jwt.claim.sub', ${q(owner.id)}, true); insert into public.publishing_destinations (workspace_id, kind, name, target_ref) values (${q(ws)}, 'telegram', 'FN07 kênh', '-100123456789') returning id`).split("\n").filter(Boolean).pop();

    server = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", QA_PORT, "-H", "127.0.0.1"], {
      env: { ...process.env, SPORTS_NEWS_WORKSPACE_ID: ws, SPORTS_NEWS_PROJECT_ID: project, SPORTS_NEWS_TELEGRAM_DESTINATION_ID: dest },
      stdio: "ignore", detached: true,
    });
    for (let i = 0; i < 60; i += 1) {
      if (await fetch(`${QA_URL}/api/health`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const url = (path = "") => `${QA_URL}/w/${ws}${path}`;
    const p = owner.page;
    const modeRow = () => sql(`select coalesce((select mode || ':' || daily_quota || ':v' || version from contentpilot_private.sports_automation_modes where workspace_id = ${q(ws)}), 'none')`);
    const events = () => Number(sql(`select count(*) from contentpilot_private.sports_automation_events where workspace_id = ${q(ws)}`));
    const heading = (page) => page.locator('section[aria-label="Chế độ tự động hóa"] h2').textContent();

    // --- 1. Auth / cross-workspace isolation --------------------------------------------------
    console.log("1. Auth isolation");
    const anon = await (await browser.newContext()).newPage();
    await anon.goto(url("/automation"));
    check(/\/login/.test(anon.url()), `unauthenticated visitor is redirected to login (${new URL(anon.url()).pathname})`);
    for (const [label, user, target] of [["outsider", outsider, ws], ["other workspace owner", otherOwner, ws]]) {
      for (const path of ["/automation", "", "/news", "/approvals", "/studio"]) {
        const res = await user.page.goto(`${QA_URL}/w/${target}${path}`);
        check(res.status() === 404, `${label}: 404 for /w/<A>${path} (status ${res.status()})`);
      }
    }
    const resB = await otherOwner.page.goto(`${QA_URL}/w/${wsB}/automation`);
    check(resB.status() === 200 && (await otherOwner.page.locator("body").textContent()).includes("RSS chưa được cấu hình"),
      "workspace B owner: automation shows 'RSS not configured' (control target is bound to workspace A only)");
    await member.page.goto(url("/automation"));
    check(await shown(member.page.locator("h1:has-text('Tự động hóa')")), "member can read the automation page");
    check((await member.page.locator('section[aria-label="Đổi chế độ"]').count()) === 0, "member sees no mode-change form");
    check((await member.page.locator('button:has-text("Dừng Auto Publish")').count()) === 0, "member sees no Emergency Stop");

    // --- 2. Default Semi, transitions, quota, audit ----------------------------------------------
    console.log("2. Default Semi + transitions");
    await p.goto(url("/automation"));
    check((await heading(p)).trim() === "Semi Publish", "no mode row: the page shows Semi Publish (never Auto)");
    check((await p.locator("text=Chờ duyệt trước khi gửi").count()) > 0, "Semi state badge says drafts wait for approval");
    check(modeRow() === "none" && events() === 0, "viewing the page writes nothing (no mode row, no event)");
    check((await p.locator('button:has-text("Dừng Auto Publish")').count()) === 0, "Emergency Stop is offered only in Auto");
    check(await p.locator('input[name="mode"][value="semi"]').isChecked(), "Semi radio is preselected");
    check((await p.locator('input[name="dailyQuota"]').inputValue()) === "40", "default daily quota is 40");

    async function setMode(mode, quota) {
      await p.goto(url("/automation"));
      await p.check(`input[name="mode"][value="${mode}"]`);
      await p.fill('input[name="dailyQuota"]', String(quota));
      await p.click('button:has-text("Lưu chế độ")');
      await p.waitForURL(/status=mode-|error=/, { timeout: 15000 });
    }
    await setMode("auto", 3);
    check(modeRow() === "auto:3:v1", `Semi -> Auto persisted (${modeRow()})`);
    check((await heading(p)).trim() === "Auto Publish" && (await p.locator('[role="status"]').textContent()).includes("Chỉ áp dụng cho bài tạo từ bây giờ"), "Auto banner says it applies only to new drafts");
    check(await shown(p.locator('button:has-text("Dừng Auto Publish")')), "Emergency Stop appears in Auto");
    check(Number(sql(`select count(*) from contentpilot_private.sports_auto_publish_windows where workspace_id = ${q(ws)} and persistent and ends_at = 'infinity'`)) === 1, "exactly one open persistent window");
    await p.click('button:has-text("Dừng Auto Publish")');
    await p.waitForURL(/status=/, { timeout: 15000 });
    await p.locator('section[aria-label="Chế độ tự động hóa"] h2:has-text("Semi Publish")').waitFor({ timeout: 10000 }).catch(() => {});
    check(modeRow() === "semi:3:v2" && (await heading(p)).trim() === "Semi Publish", `Emergency Stop moved Auto -> Semi (${modeRow()})`);
    check(Number(sql(`select count(*) from contentpilot_private.sports_auto_publish_windows where workspace_id = ${q(ws)} and ends_at = 'infinity'`)) === 0, "Emergency Stop closed the persistent window");
    await setMode("off", 3);
    check(modeRow() === "off:3:v3" && (await heading(p)).trim() === "Off", "Semi -> Off");
    check((await p.locator("text=Không quét RSS, không gọi AI và không gửi bài").count()) > 0, "Off banner says: no RSS, no AI, no delivery");
    await setMode("semi", 40);
    check(modeRow() === "semi:40:v4", "Off -> Semi");
    check(events() === 4, `4 transitions audited (${events()})`);
    const log = (await p.locator(".football-mode-log li").allTextContents()).join(" | ");
    check(/AUTO → SEMI/.test(log) && /OFF → SEMI/.test(log), "audit log is visible in the UI");

    for (const bad of [0, 121, -5, 1.5]) {
      await p.goto(url("/automation"));
      await p.evaluate(() => { const i = document.querySelector('input[name="dailyQuota"]'); i.removeAttribute("min"); i.removeAttribute("max"); i.setAttribute("step", "any"); });
      await p.check('input[name="mode"][value="auto"]');
      await p.fill('input[name="dailyQuota"]', String(bad));
      await p.click('button:has-text("Lưu chế độ")');
      await p.waitForURL(/error=/, { timeout: 15000 });
      check(modeRow() === "semi:40:v4" && (await p.locator('.football-feedback.is-error').count()) === 1, `server rejects quota ${bad} (mode unchanged, generic error)`);
    }
    for (const ok of [1, 120]) {
      await setMode("semi", ok);
      check(modeRow() === `semi:${ok}:v${ok === 1 ? 5 : 6}`, `boundary quota ${ok} accepted`);
    }
    await setMode("semi", 40);
    const sqlErrors = (await p.content()).match(/CP\d{3}|violates|pg_|SQLSTATE/g);
    check(!sqlErrors, "no database error text leaks into the page");

    // --- 3. Theme persistence, flash, hydration -------------------------------------------------
    console.log("3. Theme");
    const tokens = { light: { bg: "#F1F5F4", surface: "#FFFFFF", primary: "#087F5B", accent: "#D6F5E5", text: "#152B27" }, dark: { bg: "#101820", surface: "#1B2632", primary: "#34D399", accent: "#193D34", text: "#F1F5F9" } };
    for (const [name, t] of Object.entries(tokens)) {
      check(contrast(t.text, t.bg) >= 4.5 && contrast(t.text, t.surface) >= 4.5, `${name}: text on background/surface >= 4.5 (${contrast(t.text, t.bg).toFixed(1)} / ${contrast(t.text, t.surface).toFixed(1)})`);
      check(contrast(t.text, t.accent) >= 4.5, `${name}: text on accent >= 4.5 (${contrast(t.text, t.accent).toFixed(1)})`);
      const onPrimary = name === "light" ? "#FFFFFF" : "#101820";
      check(contrast(onPrimary, t.primary) >= 4.5, `${name}: button label on primary >= 4.5 (${contrast(onPrimary, t.primary).toFixed(1)})`);
      check(contrast(t.primary, t.surface) >= 3, `${name}: primary on surface >= 3 for UI components (${contrast(t.primary, t.surface).toFixed(1)})`);
    }
    const select = (page) => page.locator('[data-testid="theme-control"]');
    const isDark = (page) => page.evaluate(() => document.documentElement.classList.contains("dark"));
    await p.goto(url());
    for (const [choice, expectDark] of [["dark", true], ["light", false]]) {
      await select(p).selectOption(choice);
      check((await isDark(p)) === expectDark, `choose ${choice}: html.dark = ${expectDark}`);
      await p.reload();
      check((await isDark(p)) === expectDark && (await select(p).inputValue()) === choice, `${choice} persists across reload (select shows ${choice})`);
      await p.goto(url("/automation"));
      check((await isDark(p)) === expectDark && (await select(p).inputValue()) === choice, `${choice} persists on another page`);
    }
    const bg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await select(p).selectOption("dark");
    const darkBg = await bg(p);
    await select(p).selectOption("light");
    const lightBg = await bg(p);
    check(darkBg !== lightBg, `body background differs per theme (${lightBg} vs ${darkBg})`);
    // System follows the OS preference live.
    await select(p).selectOption("system");
    await p.emulateMedia({ colorScheme: "dark" });
    await p.waitForFunction(() => document.documentElement.classList.contains("dark"), null, { timeout: 3000 }).catch(() => {});
    check(await isDark(p), "System + OS dark => dark");
    await p.emulateMedia({ colorScheme: "light" });
    await p.waitForFunction(() => !document.documentElement.classList.contains("dark"), null, { timeout: 3000 }).catch(() => {});
    check(!(await isDark(p)), "System + OS light => light (live)");
    await p.reload();
    check((await select(p).inputValue()) === "system", "System choice persists");

    // Flash of wrong theme: the class must be right at DOMContentLoaded and never change afterwards.
    for (const [saved, os] of [["dark", "light"], ["light", "dark"], [null, "dark"]]) {
      const ctx = await browser.newContext({ colorScheme: os, locale: "vi-VN" });
      await owner.context.cookies().then((c) => ctx.addCookies(c));
      await ctx.addInitScript((value) => {
        if (value) localStorage.setItem("football-news-theme", value);
        window.__themeLog = [];
        const log = (tag) => window.__themeLog.push(`${tag}:${document.documentElement.classList.contains("dark")}`);
        new MutationObserver(() => log("mutation")).observe(document, { subtree: true, attributes: true, attributeFilter: ["class"] });
        document.addEventListener("DOMContentLoaded", () => log("dcl"));
        window.addEventListener("load", () => log("load"));
      }, saved);
      const pg = await ctx.newPage();
      pg.on("console", (m) => { if (/hydrat/i.test(m.text())) browserErrors.push(`hydration: ${m.text()}`); });
      await pg.goto(url("/automation"), { waitUntil: "load" });
      await pg.waitForTimeout(500);
      const expected = saved ? saved === "dark" : os === "dark";
      const logEntries = await pg.evaluate(() => window.__themeLog);
      const dcl = logEntries.find((e) => e.startsWith("dcl"));
      const flips = logEntries.filter((e) => e.startsWith("mutation") && e !== `mutation:${expected}`).length;
      check(dcl === `dcl:${expected}` && flips === 0, `no theme flash (saved=${saved}, OS=${os}): ${logEntries.join(",")}`);
      await ctx.close();
    }

    // --- 4. Responsive layout + screenshots ----------------------------------------------------------
    console.log("4. Responsive");
    const pages = ["", "/news", "/automation", "/approvals", "/settings", "/studio"];
    for (const [label, vp] of [["desktop", { width: 1440, height: 900 }], ["tablet", { width: 820, height: 1180 }], ["mobile", { width: 390, height: 844 }]]) {
      const ctx = await browser.newContext({ viewport: vp, locale: "vi-VN" });
      await owner.context.cookies().then((c) => ctx.addCookies(c));
      const pg = await ctx.newPage();
      for (const theme of ["light", "dark"]) {
        await pg.addInitScript((v) => localStorage.setItem("football-news-theme", v), theme);
        for (const path of pages) {
          const res = await pg.goto(url(path), { waitUntil: "load" });
          const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          const unreadable = await pg.evaluate(() => [...document.querySelectorAll("h1,h2,p,a,button,label,span,li")]
            .filter((e) => {
              const r = e.getBoundingClientRect();
              if (r.width === 0 || r.right <= window.innerWidth + 1 || getComputedStyle(e).position === "fixed") return false;
              for (let a = e.parentElement; a; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === "auto" || o === "scroll") return false; }
              return true; // outside any scroll container: genuinely clipped
            }).length);
          const navHidden = await pg.evaluate(() => [...document.querySelectorAll(".football-nav-link")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).map((e) => e.textContent.trim()));
          if (navHidden.length && path === "") console.log(`  info - ${label}/${theme}: nav links only reachable by horizontal scroll: ${navHidden.join(", ")}`);
          check(res.status() === 200 && overflow <= 0 && unreadable === 0, `${label}/${theme} ${path || "/"}: status ${res.status()}, horizontal overflow ${overflow}px, clipped elements ${unreadable}`);
          if (SHOTS && (path === "" || path === "/automation") ) await pg.screenshot({ path: `${SHOTS}/${label}-${theme}-${path ? path.slice(1) : "overview"}.png`, fullPage: true });
        }
      }
      await ctx.close();
    }

    // --- 5. Keyboard accessibility (automation page) -------------------------------------------
    console.log("5. Keyboard");
    const ctxK = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "vi-VN" });
    await owner.context.cookies().then((c) => ctxK.addCookies(c));
    const kp = await ctxK.newPage();
    await kp.goto(url("/automation"));
    const stops = [];
    for (let i = 0; i < 60; i += 1) {
      await kp.keyboard.press("Tab");
      const info = await kp.evaluate(() => {
        const e = document.activeElement; if (!e || e === document.body) return null;
        const s = getComputedStyle(e);
        return { id: `${e.tagName.toLowerCase()}${e.getAttribute("name") ? `[${e.getAttribute("name")}${e.getAttribute("value") ? "=" + e.getAttribute("value") : ""}]` : ""}${e.getAttribute("aria-label") ? `{${e.getAttribute("aria-label")}}` : ""}${e.textContent && e.tagName !== "INPUT" && e.tagName !== "SELECT" ? ":" + e.textContent.trim().slice(0, 24) : ""}`,
          visibleFocus: (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== "none" };
      });
      if (info) stops.push(info);
    }
    const ids = stops.map((s) => s.id);
    check(ids.some((i) => i.includes("Giao diện")), "theme control is reachable by Tab");
    check(["auto", "semi", "off"].every((m) => ids.some((i) => i.includes(`mode=${m}`)) || ids.some((i) => i.startsWith("input[mode="))), "mode radio group is reachable by Tab");
    check(ids.some((i) => i.includes("dailyQuota")) && ids.some((i) => i.includes("Lưu chế độ")), "quota field and 'Lưu chế độ' are reachable by Tab");
    check(ids.some((i) => i.includes("Lưu barem")), "scoring form is reachable by Tab");
    const noRing = stops.filter((s) => !s.visibleFocus).map((s) => s.id);
    check(noRing.length === 0, `every focused control has a visible focus indicator${noRing.length ? " — missing: " + [...new Set(noRing)].join(", ") : ""}`);
    await kp.goto(url("/automation"));
    await kp.focus('input[name="mode"][value="semi"]');
    await kp.keyboard.press("ArrowUp");
    check(await kp.locator('input[name="mode"][value="auto"]').isChecked(), "arrow keys move the radio selection");
    await kp.keyboard.press("ArrowDown");
    await kp.keyboard.press("ArrowDown");
    check(await kp.locator('input[name="mode"][value="off"]').isChecked(), "arrow keys reach Off");
    await kp.focus('input[name="dailyQuota"]');
    await kp.fill('input[name="dailyQuota"]', "40");
    await kp.keyboard.press("Enter");
    await kp.waitForURL(/status=mode-off/, { timeout: 15000 });
    check(modeRow().startsWith("off:40"), `Enter in the quota field submits the form (${modeRow()})`);
    await setMode("semi", 40);
    await ctxK.close();

    check(browserErrors.length === 0, `no browser console/page errors or hydration warnings (${browserErrors.length})${browserErrors.length ? ": " + browserErrors.slice(0, 5).join(" ; ") : ""}`);
  } catch (error) {
    console.log(`  FAIL - unexpected error: ${error.message.split("\n")[0]}`);
    failures += 1;
  } finally {
    await browser.close();
    if (server) { try { process.kill(-server.pid); } catch { /* already stopped */ } }
  }
  if (failures) { console.log(`\n${failures} FN07 QA check(s) failed.`); process.exit(1); }
  console.log("\nAll FN07 QA checks passed.");
}
run();
