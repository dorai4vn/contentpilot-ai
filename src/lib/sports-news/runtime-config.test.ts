import { describe, expect, it } from "vitest";

import nextConfig from "../../../next.config";

describe("FN11-A3 runtime tracing", () => {
  it("includes onnxruntime native linux/x64 libs for the worker route only", () => {
    const includes = nextConfig.outputFileTracingIncludes ?? {};
    expect(Object.keys(includes)).toEqual(["/api/cron/sports-news"]);
    expect(includes["/api/cron/sports-news"]).toContain("./node_modules/onnxruntime-node/bin/napi-v3/linux/x64/**");
  });
});
