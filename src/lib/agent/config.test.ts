import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MissingConfigurationError } from "@/lib/env";

import {
  OPENAI_REQUEST_DEFAULTS,
  createOpenAIClient,
  getOpenAIConfig,
  isAgentConfigured,
  readOpenAIConfig,
} from "./config";

// Test-only dummy values: not real credentials.
const KEY = "sk-test-0000000000000000000000000000";
const MODEL = "test-model-mini";

describe("readOpenAIConfig", () => {
  it("reads and trims key and model", () => {
    expect(readOpenAIConfig({ OPENAI_API_KEY: ` ${KEY} `, OPENAI_MODEL: ` ${MODEL} ` })).toEqual({
      apiKey: KEY,
      model: MODEL,
    });
  });

  it.each([
    ["missing key", { OPENAI_MODEL: MODEL }],
    ["missing model", { OPENAI_API_KEY: KEY }],
    ["empty values", { OPENAI_API_KEY: "", OPENAI_MODEL: "" }],
    ["short key", { OPENAI_API_KEY: "sk-123", OPENAI_MODEL: MODEL }],
    ["placeholder key", { OPENAI_API_KEY: "sk-replace_me-000000000000000000", OPENAI_MODEL: MODEL }],
    ["key with spaces", { OPENAI_API_KEY: "sk-test 0000000000000000000000000", OPENAI_MODEL: MODEL }],
    ["model with spaces", { OPENAI_API_KEY: KEY, OPENAI_MODEL: "my model" }],
    ["model with quotes", { OPENAI_API_KEY: KEY, OPENAI_MODEL: '"model"' }],
  ])("returns null for %s", (_label, source) => {
    expect(readOpenAIConfig(source)).toBeNull();
    expect(isAgentConfigured(source)).toBe(false);
  });

  it("is configured when both values are valid", () => {
    expect(isAgentConfigured({ OPENAI_API_KEY: KEY, OPENAI_MODEL: MODEL })).toBe(true);
  });
});

describe("getOpenAIConfig", () => {
  it("throws MissingConfigurationError naming the variables, never their values", () => {
    const badKey = "sk-short";
    try {
      getOpenAIConfig({ OPENAI_API_KEY: badKey, OPENAI_MODEL: "" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MissingConfigurationError);
      const message = (error as Error).message;
      expect(message).toMatch(/OPENAI_API_KEY/);
      expect(message).toMatch(/OPENAI_MODEL/);
      expect(message).not.toContain(badKey);
    }
  });

  it("returns the config when valid", () => {
    expect(getOpenAIConfig({ OPENAI_API_KEY: KEY, OPENAI_MODEL: MODEL })).toEqual({ apiKey: KEY, model: MODEL });
  });
});

describe("createOpenAIClient", () => {
  it("creates a server client with the configured key and request limits", () => {
    const client = createOpenAIClient({ apiKey: KEY, model: MODEL });
    expect(client.apiKey).toBe(KEY);
    expect(client.timeout).toBe(OPENAI_REQUEST_DEFAULTS.timeoutMs);
    expect(client.maxRetries).toBe(OPENAI_REQUEST_DEFAULTS.maxRetries);
  });

  it("refuses to build a client when not configured", () => {
    const saved = { key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL };
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    try {
      expect(() => createOpenAIClient()).toThrow(MissingConfigurationError);
    } finally {
      if (saved.key !== undefined) process.env.OPENAI_API_KEY = saved.key;
      if (saved.model !== undefined) process.env.OPENAI_MODEL = saved.model;
    }
  });
});

describe("the key stays on the server", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
    }
  };
  walk(join(process.cwd(), "src"));

  it("no source file uses a NEXT_PUBLIC_ variable for OpenAI", () => {
    const offenders = files.filter((f) => /NEXT_PUBLIC_[A-Z_]*OPENAI|NEXT_PUBLIC_[A-Z_]*AI_KEY/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("only server-only modules read OPENAI_API_KEY", () => {
    const readers = files.filter((f) => readFileSync(f, "utf8").includes("OPENAI_API_KEY"));
    expect(readers.length).toBeGreaterThan(0);
    for (const file of readers) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toMatch(/^import "server-only";/m);
      expect(source, file).not.toMatch(/^["']use client["']/m);
    }
  });

  it("no Client Component imports the agent config", () => {
    const clientImporters = files.filter((f) => {
      const source = readFileSync(f, "utf8");
      return /^["']use client["']/m.test(source) && /lib\/agent\/config/.test(source);
    });
    expect(clientImporters).toEqual([]);
  });
});
