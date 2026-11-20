/** Route rules shared by the proxy, pages and server actions. Pure functions: unit tested. */

export const DEFAULT_AFTER_LOGIN = "/dashboard";

const PROTECTED_PREFIXES = ["/dashboard", "/w"];
const AUTH_PAGES = ["/login", "/signup"];

function matchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

export function isAuthPage(pathname: string): boolean {
  return AUTH_PAGES.some((page) => matchesPrefix(pathname, page));
}

/**
 * Accepts a user-supplied "next" value only if it is a same-origin relative path.
 * Prevents open redirects such as `//evil.com`, `/\evil.com` or `https://evil.com`.
 */
export function safeRedirectPath(next: unknown, fallback: string = DEFAULT_AFTER_LOGIN): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 512) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback;

  try {
    const base = "http://localhost";
    const url = new URL(next, base);
    if (url.origin !== base) return fallback;
    if (isAuthPage(url.pathname)) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
