import { defineConfig } from "vitest/config";

/**
 * Integration tests against a LOCAL Supabase stack (see scripts/test-integration.sh).
 * Not part of `npm test`: they need Docker + `npx supabase start`.
 */
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
