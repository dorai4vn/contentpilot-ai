import { describe, expect, it } from "vitest";

import { getSupabaseEnv, MissingConfigurationError, readSupabaseEnv } from "./env";

const KEY = "sb_publishable_0123456789abcdefghij";

describe("readSupabaseEnv", () => {
  it("returns null when nothing is configured", () => {
    expect(readSupabaseEnv({})).toBeNull();
  });

  it("rejects an invalid URL", () => {
    expect(readSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: "not a url", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: KEY })).toBeNull();
  });

  it("reads the publishable key", () => {
    expect(
      readSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: KEY }),
    ).toEqual({ url: "https://abc.supabase.co", key: KEY });
  });

  it("falls back to the legacy anon key", () => {
    expect(
      readSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: KEY })?.key,
    ).toBe(KEY);
  });
});

describe("getSupabaseEnv", () => {
  it("throws a MissingConfigurationError when not configured", () => {
    expect(() => getSupabaseEnv({})).toThrow(MissingConfigurationError);
  });
});
