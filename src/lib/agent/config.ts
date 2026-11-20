import "server-only";

import OpenAI from "openai";
import { z } from "zod";

import { MissingConfigurationError } from "@/lib/env";

/**
 * Server-only OpenAI configuration for the M3 agent.
 *
 * OPENAI_API_KEY and OPENAI_MODEL are read from the server environment only:
 * they never use the NEXT_PUBLIC_ prefix, so Next.js never inlines them into
 * browser bundles, and the "server-only" import makes any accidental import
 * from a Client Component a build error. Error messages never contain the key.
 */

const openAIEnvSchema = z.object({
  apiKey: z
    .string()
    .min(20, { message: "OPENAI_API_KEY is missing or too short" })
    .max(512, { message: "OPENAI_API_KEY is too long" })
    .regex(/^\S+$/, { message: "OPENAI_API_KEY must not contain whitespace" })
    .refine((key) => !/replace_me|your[-_]?key|changeme|example/i.test(key), {
      message: "OPENAI_API_KEY still contains a placeholder value",
    }),
  model: z
    .string()
    .min(1, { message: "OPENAI_MODEL is missing" })
    .max(100, { message: "OPENAI_MODEL is too long" })
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:\-/]*$/, { message: "OPENAI_MODEL contains invalid characters" }),
});

export type OpenAIConfig = z.infer<typeof openAIEnvSchema>;

type EnvSource = Record<string, string | undefined>;

function defaultSource(): EnvSource {
  return { OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_MODEL: process.env.OPENAI_MODEL };
}

/** Parsed config, or null when the agent is not configured (or misconfigured). */
export function readOpenAIConfig(source: EnvSource = defaultSource()): OpenAIConfig | null {
  const parsed = openAIEnvSchema.safeParse({
    apiKey: source.OPENAI_API_KEY?.trim(),
    model: source.OPENAI_MODEL?.trim(),
  });
  return parsed.success ? parsed.data : null;
}

/** True when the AI agent can be offered (used to show or hide the feature). */
export function isAgentConfigured(source: EnvSource = defaultSource()): boolean {
  return readOpenAIConfig(source) !== null;
}

/**
 * Config or a MissingConfigurationError naming the problem variables (never
 * their values).
 */
export function getOpenAIConfig(source: EnvSource = defaultSource()): OpenAIConfig {
  const parsed = openAIEnvSchema.safeParse({
    apiKey: source.OPENAI_API_KEY?.trim(),
    model: source.OPENAI_MODEL?.trim(),
  });
  if (!parsed.success) {
    const problems = [...new Set(parsed.error.issues.map((issue) => issue.message))].join("; ");
    throw new MissingConfigurationError(`AI agent is not configured: ${problems}`);
  }
  return parsed.data;
}

/** Request limits for calls to OpenAI (keeps a slow upstream from hanging a request). */
export const OPENAI_REQUEST_DEFAULTS = { timeoutMs: 30_000, maxRetries: 1 } as const;

/**
 * Creates an OpenAI client for server code. Browser use stays disabled
 * (the SDK default), so the key cannot be used from client-side code.
 */
export function createOpenAIClient(config: OpenAIConfig = getOpenAIConfig()): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    timeout: OPENAI_REQUEST_DEFAULTS.timeoutMs,
    maxRetries: OPENAI_REQUEST_DEFAULTS.maxRetries,
    dangerouslyAllowBrowser: false,
  });
}
