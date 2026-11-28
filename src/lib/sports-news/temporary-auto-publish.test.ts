import { describe, expect, it } from "vitest";
import { permitsTemporaryAutoPublish, AUTO_PUBLISH_MAX_WINDOW_MS } from "./temporary-auto-publish";

const start = Date.parse("2026-11-26T20:00:00Z");
const window = {
  startsAt: new Date(start).toISOString(),
  endsAt: new Date(start + AUTO_PUBLISH_MAX_WINDOW_MS).toISOString(),
  workspaceId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  destinationId: "33333333-3333-4333-8333-333333333333",
};
const candidate = {
  workspaceId: window.workspaceId, projectId: window.projectId,
  destinationId: window.destinationId, kind: "telegram", source: "rss",
  createdAt: start + 1000, publishedAt: start, testMode: false,
};
describe("temporary RSS auto publish policy", () => {
  it("allows a new scoped RSS draft within the window", () => {
    expect(permitsTemporaryAutoPublish(window, candidate, start + 2000)).toBe(true);
  });
  it("fails closed without a valid window", () => {
    expect(permitsTemporaryAutoPublish(null, candidate, start + 2000)).toBe(false);
    expect(permitsTemporaryAutoPublish({...window, endsAt: new Date(start + AUTO_PUBLISH_MAX_WINDOW_MS + 1).toISOString()}, candidate, start + 2000)).toBe(false);
  });
  it("rejects at expiration", () => {
    expect(permitsTemporaryAutoPublish(window, candidate, start + AUTO_PUBLISH_MAX_WINDOW_MS)).toBe(false);
  });
  it.each([
    {kind: "facebook"}, {source: "user"}, {testMode: true}, {createdAt: start - 1},
    {workspaceId: "other"}, {projectId: "other"}, {destinationId: "other"},
    {publishedAt: start + 3000}, {publishedAt: NaN},
  ])("rejects out-of-scope candidate %o", (patch) => {
    expect(permitsTemporaryAutoPublish(window, {...candidate, ...patch}, start + 2000)).toBe(false);
  });
  it("persistent Auto has no expiry but still needs the persistent flag", () => {
    const persistent = { ...window, endsAt: null, persistent: true };
    expect(permitsTemporaryAutoPublish(persistent, candidate, start + 30 * 60 * 60 * 1000)).toBe(true);
    expect(permitsTemporaryAutoPublish({ ...persistent, persistent: false }, candidate, start + 2000)).toBe(false);
    expect(permitsTemporaryAutoPublish({ ...persistent, endsAt: undefined, persistent: undefined }, candidate, start + 2000)).toBe(false);
    expect(permitsTemporaryAutoPublish(persistent, { ...candidate, createdAt: start - 1 }, start + 2000)).toBe(false);
    expect(permitsTemporaryAutoPublish(persistent, { ...candidate, projectId: "other" }, start + 2000)).toBe(false);
    expect(permitsTemporaryAutoPublish(persistent, { ...candidate, testMode: true }, start + 2000)).toBe(false);
  });
});
