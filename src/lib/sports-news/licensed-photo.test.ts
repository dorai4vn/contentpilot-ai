import { afterEach, expect, it, vi } from "vitest";
import { findLicensedSportsPhoto } from "./licensed-photo";

vi.mock("server-only", () => ({}));
afterEach(() => vi.unstubAllGlobals());

function page(license: string, licenseUrl: string, thumburl = "https://thumb.wikimedia.org/wikipedia/commons/thumb/example.jpg") {
  return {
    query: { pages: { "123": { pageid: 123, title: "File:Bayern München in training.jpg", imageinfo: [{
      url: "https://upload.wikimedia.org/wikipedia/commons/example.jpg",
      thumburl, mime: "image/jpeg",
      extmetadata: {
        LicenseShortName: { value: license }, LicenseUrl: { value: licenseUrl }, Artist: { value: "<b>Example</b>" },
      },
    }] } } },
  };
}

it("uses a Commons JPEG with a supported license and keeps the author and links in the caption", async () => {
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(page("CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/")))
    .mockResolvedValueOnce(new Response(Uint8Array.of(255, 216, 255), { headers: { "content-type": "image/jpeg" } }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(findLicensedSportsPhoto("Bayern München")).resolves.toMatchObject({
    image: "/9j/",
    attribution: "📷 Ảnh tư liệu: Example · CC BY-SA 4.0\nhttps://commons.wikimedia.org/?curid=123\nhttps://creativecommons.org/licenses/by-sa/4.0/",
  });
});

it.each([
  ["CC BY-NC 4.0", "https://creativecommons.org/licenses/by-nc/4.0/"],
  ["CC BY 4.0", "https://example.org/license"],
])("rejects unavailable reuse rights (%s)", async (license, url) => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(page(license, url)));
  vi.stubGlobal("fetch", fetchMock);
  await expect(findLicensedSportsPhoto("Bayern München")).resolves.toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("rejects untrusted image hosts", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(
    page("CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/", "https://example.org/image.jpg"),
  ));
  vi.stubGlobal("fetch", fetchMock);
  await expect(findLicensedSportsPhoto("Bayern München")).resolves.toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("rejects a stadium photo for a fixture even when the file has a reusable license", async () => {
  const result = page("CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/");
  result.query.pages["123"].title = "File:Bayern München Allianz Arena.jpg";
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(result));
  vi.stubGlobal("fetch", fetchMock);
  await expect(findLicensedSportsPhoto("Bayern München", { opponent: "Lille", playedOn: "2026-11-25" })).resolves.toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("uses a licensed fixture photo only when both teams and the requested date match", async () => {
  const result = page("CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/");
  result.query.pages["123"].title = "File:Bayern München vs Lille 2026-11-25.jpg";
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(result))
    .mockResolvedValueOnce(Response.json(result))
    .mockResolvedValueOnce(new Response(Uint8Array.of(255, 216, 255), { headers: { "content-type": "image/jpeg" } }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(findLicensedSportsPhoto("Bayern München", { opponent: "Lille", playedOn: "2026-11-26" })).resolves.toBeNull();
  await expect(findLicensedSportsPhoto("Bayern München", { opponent: "Lille", playedOn: "2026-11-25" })).resolves.toMatchObject({
    attribution: expect.stringContaining("📷 Ảnh trận đấu"),
  });
});
