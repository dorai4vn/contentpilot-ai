import "server-only";

import { headers } from "next/headers";

/**
 * Absolute origin of the current deployment, used for auth email redirect links.
 * Prefers NEXT_PUBLIC_SITE_URL; otherwise derives it from the request (works on
 * Vercel preview and production URLs). The value must also be allow-listed in
 * Supabase Auth > URL Configuration, so a spoofed Host header cannot be abused.
 */
export async function getSiteOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // fall through to request-derived origin
    }
  }

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
