import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { internalPublisher } from "./adapters/internal";
import { getPublisher, isSupportedKind, supportedKinds, UnsupportedDestinationKindError } from "./registry";
import { PublisherSecret } from "./types";

describe("registry", () => {
  it("supports the platform adapters and rejects unknown kinds", () => {
    expect(supportedKinds()).toEqual(["internal", "telegram", "discord", "facebook"]);
    expect(isSupportedKind("internal")).toBe(true);
    for (const kind of ["", "__proto__", "constructor", "toString"]) {
      expect(isSupportedKind(kind), kind).toBe(false);
    }
  });

  it("returns the adapter for a supported kind and never falls back for others", () => {
    expect(getPublisher("internal")).toBe(internalPublisher);
    expect(getPublisher("telegram").execution).toBe("async");
    expect(() => getPublisher("__proto__")).toThrow(UnsupportedDestinationKindError);
  });
});

describe("InternalPublisher", () => {
  it("is executed inside the approval transaction (no worker, no network)", () => {
    expect(internalPublisher.kind).toBe("internal");
    expect(internalPublisher.execution).toBe("in_approval");
  });

  it("accepts no external target", () => {
    expect(internalPublisher.validateTarget(null)).toEqual({ ok: true });
    expect(internalPublisher.validateTarget("@channel")).toEqual({ ok: false, code: "invalid_target" });
  });

  it("renders exactly the approved snapshot", () => {
    const snapshot = { postId: "p", postVersion: 3, title: "Tiêu đề", body: "Nội dung" };
    expect(internalPublisher.render(snapshot)).toEqual(snapshot);
  });

  it("publish() never publishes (already done by the approval) and reports a safe code", async () => {
    const outcome = await internalPublisher.publish(
      { postId: "p", postVersion: 3, title: "t", body: "b" },
      { idempotencyKey: "request:x", targetRef: null, credentials: null },
    );
    expect(outcome).toEqual({ ok: false, code: "not_applicable", retryable: false });
  });
});

describe("PublisherSecret", () => {
  it("never reveals its value through serialisation, strings or inspection", () => {
    const secret = new PublisherSecret("tg-bot-123:SECRET");
    const carriers = [
      JSON.stringify({ secret }),
      String(secret),
      `${secret}`,
      inspect(secret),
      inspect({ nested: { secret } }),
      JSON.stringify(Object.assign({}, secret)),
    ];
    for (const text of carriers) expect(text).not.toContain("SECRET");
    expect(JSON.stringify({ secret })).toBe('{"secret":"[redacted]"}');
    expect(secret.reveal()).toBe("tg-bot-123:SECRET");
  });
});
