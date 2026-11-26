import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { squareSportsPhoto, SPORTS_PHOTO_SIZE } from "./square-photo";

vi.mock("server-only", () => ({}));

it.each([[1500, 800], [650, 1200]])("crops a %d × %d source to a square JPEG", async (width, height) => {
  const input = await sharp({ create: { width, height, channels: 3, background: "#283b25" } }).jpeg().toBuffer();
  const square = await squareSportsPhoto(input);
  expect(await sharp(square).metadata()).toMatchObject({
    width: SPORTS_PHOTO_SIZE,
    height: SPORTS_PHOTO_SIZE,
    format: "jpeg",
  });
});
