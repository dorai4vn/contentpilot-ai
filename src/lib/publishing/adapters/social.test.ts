import { afterEach, describe, expect, it, vi } from "vitest";

import { socialPublisher } from "./social";
import { PublisherSecret } from "../types";

afterEach(() => vi.unstubAllGlobals());

describe("social adapters", () => {
  it.each([
    ["telegram", "-100123456789", "/sendPhoto", "photo", { ok: true, result: { message_id: 123 } }],
    ["discord", "123456789", "/messages", "files[0]", { id: "123" }],
    ["facebook", "123456789", "/photos", "source", { post_id: "123" }],
  ] as const)("sends the exact approved text and image to %s", async (kind, target, endpoint, photoField, response) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = socialPublisher(kind);
    const approved = adapter.render({
      postId: "example",
      postVersion: 1,
      title: "🚨 Bản tin",
      body: "Nguồn: Báo",
      image: new Uint8Array([255, 216, 255]),
    });
    const caller = { credentials: new PublisherSecret("123:token"), targetRef: target, idempotencyKey: "request:xyz" };
    await expect(adapter.publish(approved, caller)).resolves.toEqual({ ok: true, externalId: "123" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toEqual(expect.stringContaining(endpoint));
    const form = init?.body as FormData;
    expect(form.get(photoField)).toBeInstanceOf(Blob);
    if (kind === "telegram") {
      expect(form.get("caption")).toBe("🚨 Bản tin\n\nNguồn: Báo");
      expect(JSON.parse(String(form.get("caption_entities")))).toEqual([
        { type: "bold", offset: 0, length: "🚨 Bản tin".length },
      ]);
    } else if (kind === "discord") {
      expect(JSON.parse(String(form.get("payload_json"))).content).toBe("**🚨 Bản tin**\n\nNguồn: Báo");
    } else {
      expect(form.get("message")).toBe("🚨 Bản tin\n\nNguồn: Báo");
    }
  });

  it("formats the headline in a text-only Telegram post", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, result: { message_id: 5 } }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = socialPublisher("telegram");
    const snapshot = { postId: "post", postVersion: 1, title: "  ⚽ Tin mới  ", body: "Nội dung" };
    await adapter.publish(adapter.render(snapshot), {
      credentials: new PublisherSecret("123:token"), targetRef: "-100123456789", idempotencyKey: "request:test",
    });
    const form = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(form.get("text")).toBe("⚽ Tin mới\n\nNội dung");
    expect(JSON.parse(String(form.get("entities")))).toEqual([{ type: "bold", offset: 0, length: "⚽ Tin mới".length }]);
    expect(form.has("caption_entities")).toBe(false);
  });

  it("retries rate limits but treats ambiguous timeouts as final until reviewed", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockRejectedValueOnce(new Error("timeout"));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = socialPublisher("telegram");
    const context = { credentials: new PublisherSecret("123:token"), targetRef: "-100123456789", idempotencyKey: "request:xyz" };
    await expect(adapter.publish({ text: "Hi", titleLength: 2, image: undefined }, context))
      .resolves.toEqual({ ok: false, code: "rate_limited", retryable: true });
    await expect(adapter.publish({ text: "Hi", titleLength: 2, image: undefined }, context))
      .resolves.toEqual({ ok: false, code: "delivery_unconfirmed", retryable: false });
  });
});
