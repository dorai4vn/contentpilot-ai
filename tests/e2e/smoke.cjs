/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * End-to-end smoke test against a running deployment (local or production).
 * Drives a real browser through health check, sign-up/sign-in, the protected
 * dashboard, workspace creation (real DB write), sign-out and tenant isolation.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 node tests/e2e/smoke.cjs
 *   BASE_URL=https://<app>.vercel.app E2E_EMAIL=a@x.com E2E_PASSWORD=... node tests/e2e/smoke.cjs
 *
 * Without E2E_EMAIL/E2E_PASSWORD it signs up fresh users, which requires email
 * confirmation to be disabled in Supabase (otherwise pass existing confirmed accounts;
 * E2E_EMAIL_2/E2E_PASSWORD_2 enable the isolation check).
 * Requires Playwright (`npx playwright@1.63.0 install chromium` if not present).
 */
const { chromium } = require("playwright");

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const stamp = Date.now();

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`  ok - ${message}`);
  } else {
    failures += 1;
    console.log(`  FAIL - ${message}`);
  }
}

async function signUpOrIn(page, email, password, existing) {
  if (existing) {
    await page.goto(`${BASE_URL}/login`);
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');
  } else {
    await page.goto(`${BASE_URL}/signup`);
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');
  }
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
}

async function signOut(page) {
  await page.click('button:has-text("Sign out")');
  await page.waitForURL(/\/login/, { timeout: 15000 });
}

(async () => {
  console.log(`Smoke testing ${BASE_URL}`);
  const browser = await chromium.launch();
  try {
    // 1. Health endpoint performs a real database query.
    const res = await fetch(`${BASE_URL}/api/health`, { cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    check(res.status === 200 && body?.database?.connected === true, `GET /api/health -> ${res.status}, connected=${body?.database?.connected}`);

    const userA = {
      email: process.env.E2E_EMAIL || `smoke-a-${stamp}@example.com`,
      password: process.env.E2E_PASSWORD || `Smoke-${stamp}-pass`,
      existing: Boolean(process.env.E2E_EMAIL),
    };
    const userB = {
      email: process.env.E2E_EMAIL_2 || `smoke-b-${stamp}@example.com`,
      password: process.env.E2E_PASSWORD_2 || `Smoke-${stamp}-pass`,
      existing: Boolean(process.env.E2E_EMAIL_2),
    };
    const canCheckIsolation = !userA.existing || userB.existing;

    const ctxA = await browser.newContext();
    const page = await ctxA.newPage();

    // 2. Protected page redirects anonymous visitors to login.
    await page.goto(`${BASE_URL}/dashboard`);
    check(/\/login\?next=%2Fdashboard/.test(page.url()), `anonymous /dashboard redirects to login (${page.url()})`);

    // 3. Wrong password is rejected.
    await page.goto(`${BASE_URL}/login`);
    await page.fill('input[name="email"]', `nobody-${stamp}@example.com`);
    await page.fill('input[name="password"]', "definitely-wrong-password");
    await page.click('button[type="submit"]');
    const alert = await page.locator('form [role="alert"]').textContent({ timeout: 10000 }).catch(() => "");
    check(/invalid email or password/i.test(alert || ""), "invalid credentials show an error");
    check(/\/login/.test(page.url()), "invalid credentials stay on /login");

    // 4. Sign up / sign in lands on the dashboard showing the user.
    await signUpOrIn(page, userA.email, userA.password, userA.existing);
    const shownEmail = await page.locator("main").textContent();
    check(shownEmail.includes(userA.email.toLowerCase()), "dashboard shows the signed-in email");

    // 5. Create a workspace (real INSERT through RLS) and read it back.
    const wsName = `Smoke workspace ${stamp}`;
    await page.fill('input[name="name"]', wsName);
    await page.click('button:has-text("Create workspace")');
    const item = page.locator('[data-testid="workspace-list"] li', { hasText: wsName });
    await item.waitFor({ timeout: 15000 });
    check((await item.textContent()).includes("Owner"), "new workspace is listed with the Owner role");

    // 6. Session survives reload; sign-out clears it.
    await page.reload();
    check(/\/dashboard/.test(page.url()), "session persists across reload");
    await signOut(page);
    check(/signed_out=1/.test(page.url()), "sign out returns to /login");
    await page.goto(`${BASE_URL}/dashboard`);
    check(/\/login/.test(page.url()), "dashboard is protected again after sign-out");

    // 7. Sign back in: data persisted in Postgres.
    await signUpOrIn(page, userA.email, userA.password, true);
    check(await page.locator('[data-testid="workspace-list"] li', { hasText: wsName }).count() === 1, "workspace persisted after re-login");
    await ctxA.close();

    // 8. Tenant isolation: another user cannot see user A's workspace.
    if (canCheckIsolation) {
      const ctxB = await browser.newContext();
      const pageB = await ctxB.newPage();
      await signUpOrIn(pageB, userB.email, userB.password, userB.existing);
      const text = await pageB.locator("main").textContent();
      check(!text.includes(wsName), "a second user does not see the first user's workspace");
      await ctxB.close();
    } else {
      console.log("  skip - isolation check (set E2E_EMAIL_2/E2E_PASSWORD_2)");
    }
  } catch (error) {
    failures += 1;
    console.log(`  FAIL - unexpected error: ${error.message}`);
  } finally {
    await browser.close();
  }

  console.log(failures === 0 ? "Smoke test passed." : `Smoke test failed (${failures} failure(s)).`);
  process.exit(failures === 0 ? 0 : 1);
})();
