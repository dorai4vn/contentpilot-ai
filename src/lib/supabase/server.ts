import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getSupabaseEnv } from "@/lib/env";
import type { Database } from "@/types/database";

// ---------------------------------------------------------------------------
// Actor context (M4.6c)
// ---------------------------------------------------------------------------

/**
 * Who is acting inside the signed-in user's session: the user themselves, or the
 * AI agent on their behalf. Set ONLY on the server, by the /api/agent route
 * (`runAsAgent`), never from a request header, a form field or model output.
 *
 * AsyncLocalStorage scopes it to one async call chain: concurrent requests (and
 * concurrent agent turns) cannot see each other's actor, and code running outside
 * runAsAgent — Server Actions, pages — always acts as the user.
 */
type ActorScope = Readonly<{ actor: "agent" }>;
const actorScope = new AsyncLocalStorage<ActorScope>();
const AGENT_SCOPE: ActorScope = Object.freeze({ actor: "agent" });

/** Header the database reads (public.publish_caller_is_agent) to refuse approvals by the agent. */
export const AGENT_ACTOR_HEADER = "x-contentpilot-actor";

/**
 * Runs `fn` as the AI agent: every Supabase client created inside it sends the
 * agent marker header. Only the /api/agent route may call this (ESLint rule).
 */
export function runAsAgent<T>(fn: () => Promise<T>): Promise<T> {
  return actorScope.run(AGENT_SCOPE, fn);
}

/** The current actor (server-side). "user" unless inside runAsAgent. */
export function currentActor(): "agent" | "user" {
  return actorScope.getStore()?.actor === "agent" ? "agent" : "user";
}

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 * It acts as the signed-in user (from the auth cookies), so every query is
 * subject to Row Level Security. Create a new client per request: a client is
 * never shared, so the agent header cannot leak into another request. Inside
 * runAsAgent, the client also sends the agent marker header.
 */
export async function createClient() {
  // Read cookies first: this marks the route as request-time rendered.
  const cookieStore = await cookies();
  const { url, key } = getSupabaseEnv();

  const headers: Record<string, string> = currentActor() === "agent" ? { [AGENT_ACTOR_HEADER]: "agent" } : {};

  return createServerClient<Database>(url, key, {
    global: { headers },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // The proxy refreshes the session cookies on every request instead.
        }
      },
    },
  });
}
