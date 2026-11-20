import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // M4: the AI agent must never reach the human approval path. Agent code may
  // not import Server Actions, nor the approve/reject/cancel data-layer functions
  // (it may only file publish requests, in M4.6).
  {
    files: ["src/lib/agent/**", "src/app/api/agent/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/content/publish-requests",
              importNames: ["approvePublishRequest", "rejectPublishRequest", "cancelPublishRequest"],
              message: "The AI agent must not approve, reject or cancel publish requests (M4 human approval).",
            },
          ],
          patterns: [
            {
              group: ["@/app/_actions/*", "@/app/_actions/**", "**/_actions/**"],
              message: "Server Actions are the human path; agent code must not import them.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
