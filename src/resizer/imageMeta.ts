import { encode } from "blurhash";
import Sharp from "sharp";

export type ImageMeta = { blurhash: string; width: number; height: number };

// BlurHash component counts (detail along each axis). 4x3 is a good
// quality/size tradeoff for landscape-ish photos (~30 char hash).
const COMPONENT_X = 4;
const COMPONENT_Y = 3;

/**
 * Compute a BlurHash placeholder and the oriented (display) dimensions of an
 * image from its source buffer.
 *
 * - Dimensions account for the EXIF orientation (orientations 5–8 rotate the
 *   image 90/270°, so width/height swap) — the grid lays out cells by this
 *   aspect ratio.
 * - BlurHash is encoded from a tiny rotated render with no padding, so the
 *   placeholder matches the displayed (aspect-correct) thumbnail.
 *
 * Resilient by contract: this is auxiliary metadata, never the primary resize
 * output, so it must NEVER throw — a failure here must not block (or crash)
 * thumbnail generation. All Sharp calls use `failOnError: false` (some HEICs
 * trip libheif security limits, e.g. iref-box reference counts) and any error
 * resolves to `null`.
 */
export const computeImageMeta = async (
  buffer: Buffer
): Promise<ImageMeta | null> => {
  try {
    const meta = await Sharp(buffer, { failOnError: false }).metadata();
    const swap = (meta.orientation ?? 0) >= 5;
    const width = (swap ? meta.height : meta.width) ?? 0;
    const height = (swap ? meta.width : meta.height) ?? 0;

    const { data, info } = await Sharp(buffer, { failOnError: false })
      .rotate()
      .resize(64, 64, { fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const blurhash = encode(
      new Uint8ClampedArray(data),
      info.width,
      info.height,
      COMPONENT_X,
      COMPONENT_Y
    );

    return { blurhash, width, height };
  } catch {
    return null;
  }
};
