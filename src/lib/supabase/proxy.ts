import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { readSupabaseEnv } from "@/lib/env";
import { isAuthPage, isProtectedPath } from "@/lib/auth/routes";
import type { Database } from "@/types/database";

/**
 * Refreshes the Supabase session cookies on every request and performs an
 * optimistic redirect for protected pages. This is a convenience only: every
 * protected page and action re-verifies the user on the server (see lib/auth/dal.ts).
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const env = readSupabaseEnv();
  if (!env) {
    // Not configured yet: let pages render their own configuration error.
    return response;
  }

  const supabase = createServerClient<Database>(env.url, env.key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        for (const [key, value] of Object.entries(headers ?? {})) {
          response.headers.set(key, value);
        }
      },
    },
  });

  // Do not put code between client creation and this call: it refreshes the token.
  // getClaims() validates the JWT signature (it is never trusted unverified).
  const { data } = await supabase.auth.getClaims();
  const isSignedIn = Boolean(data?.claims?.sub);
  const { pathname, search } = request.nextUrl;

  if (!isSignedIn && isProtectedPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return redirectWithCookies(url, response);
  }

  if (isSignedIn && isAuthPage(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return redirectWithCookies(url, response);
  }

  return response;
}

// Keep any refreshed session cookies when redirecting.
function redirectWithCookies(url: URL, from: NextResponse) {
  const redirect = NextResponse.redirect(url);
  for (const cookie of from.cookies.getAll()) {
    redirect.cookies.set(cookie);
  }
  return redirect;
}
