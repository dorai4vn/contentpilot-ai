/**
 * Waiting helpers for the E2E scripts. Pages stream in after navigation
 * (loading.tsx), so an immediate `locator.isVisible()` can run before the content
 * exists and fail at random. These wait for the condition with a timeout instead
 * (never a fixed sleep) and return a boolean for `check()`.
 */

const DEFAULT_TIMEOUT = 10000;

/** True as soon as the (first) element is visible; false after `timeout` ms. */
function shown(locator, timeout = DEFAULT_TIMEOUT) {
  return locator
    .first()
    .waitFor({ state: "visible", timeout })
    .then(
      () => true,
      () => false,
    );
}

module.exports = { shown, DEFAULT_TIMEOUT };
