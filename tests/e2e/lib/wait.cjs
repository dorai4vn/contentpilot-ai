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

/**
 * Waits until the post editor has hydrated (EditForm sets data-ready="true" once
 * mounted; before that its fields are read-only). Interact with the editor only
 * after this: hydrating an uncontrolled field resets its selection, so typing
 * during hydration could insert text instead of replacing it.
 */
function editorReady(page, timeout = DEFAULT_TIMEOUT) {
  return page.locator('[data-testid="post-editor-form"][data-ready="true"]').waitFor({ state: "attached", timeout });
}

module.exports = { shown, editorReady, DEFAULT_TIMEOUT };
