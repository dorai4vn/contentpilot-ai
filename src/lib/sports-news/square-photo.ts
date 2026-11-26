import "server-only";

import sharp from "sharp";

export const SPORTS_PHOTO_SIZE = 1080;

export async function squareSportsPhoto(image: Buffer): Promise<Uint8Array<ArrayBuffer>> {
  const jpeg = await sharp(image, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize(SPORTS_PHOTO_SIZE, SPORTS_PHOTO_SIZE, { fit: "cover", position: sharp.strategy.attention })
    .jpeg({ quality: 86 })
    .toBuffer();
  return Uint8Array.from(jpeg);
}
