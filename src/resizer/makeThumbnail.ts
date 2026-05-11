import { AcContext, S3Service } from "@aspan-corporation/ac-shared";
import exifr from "exifr";
import Sharp from "sharp";

type ResizeParams = {
  buffer: Buffer;
  sourceBucket: string;
  sourceKey: string;
  destinationBucket: string;
  destinationKey: string;
  width: number;
  height: number;
};

/**
 * Map EXIF Orientation tag (1–8) → degrees of clockwise rotation needed to
 * display the image correctly. We pass the angle to Sharp explicitly rather
 * than calling `.rotate()` (no-args), because the Sharp layer's custom libvips
 * was built without libexif, so libvips-side auto-orient is a silent no-op.
 *
 * Note: this only handles the four pure-rotation orientations (1,3,6,8) — the
 * mirrored orientations (2,4,5,7) are vanishingly rare for camera output and
 * would require Sharp.flip()/flop() in addition to rotate. If we ever start
 * seeing them in real photos we can extend this.
 *
 * Reference: EXIF Orientation values
 *   1 = Horizontal (normal)        → 0°
 *   3 = Rotate 180                  → 180°
 *   6 = Rotate 90 CW                → 90°
 *   8 = Rotate 270 CW (= 90 CCW)    → 270°
 */
const orientationToRotation = (orientation: number | undefined): number => {
  switch (orientation) {
    case 3: return 180;
    case 6: return 90;
    case 8: return 270;
    default: return 0;
  }
};

/**
 * Resizes an image and uploads it to S3. Output is always WebP.
 */
export const makeThumbnail = async (
  {
    buffer,
    sourceBucket,
    sourceKey,
    destinationBucket,
    destinationKey,
    width,
    height
  }: ResizeParams,
  { logger }: AcContext,
  destinationS3Service: S3Service,
  orientation: number | undefined
) => {
  logger.appendKeys({ function: "makeThumbnail" });

  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`Invalid thumbnail dimensions: ${width}x${height}`);
  }

  try {
    logger.debug(
      `starting resizing ${width}x${height} of ${sourceBucket}/${sourceKey}`
    );

    const angle = orientationToRotation(orientation);

    let pipeline = Sharp(buffer);
    if (angle !== 0) {
      pipeline = pipeline.rotate(angle);
    }
    const resizedBuffer = await pipeline
      .resize(width, height)
      .webp()
      .toBuffer();

    logger.debug(
      `finished resizing ${width}x${height} of ${sourceBucket}/${sourceKey} (rotated ${angle}°)`
    );

    await destinationS3Service.putObject({
      Bucket: destinationBucket,
      Key: destinationKey,
      Body: resizedBuffer
    });

    logger.debug(
      `uploaded resized image to ${destinationBucket}/${destinationKey}`
    );
  } finally {
    logger.resetKeys();
  }
};

/**
 * Reads EXIF Orientation from the source buffer using exifr (pure JS — works
 * for JPEG and HEIC regardless of what libvips/libheif features are present
 * in the Sharp Lambda layer). Returns the numeric value 1–8 (or undefined if
 * the image has no EXIF orientation or parsing fails).
 */
export const readExifOrientation = async (
  buffer: Buffer,
  logger: AcContext["logger"]
): Promise<number | undefined> => {
  try {
    // translateValues: false → keep raw numeric Orientation (1–8) instead of
    // exifr's human-readable string ("Rotate 90 CW" etc.). We want the number
    // because we map it directly to a rotation angle.
    const parsed = await exifr.parse(buffer, { translateValues: false });
    const v = parsed?.Orientation;
    if (typeof v === "number" && v >= 1 && v <= 8) return v;
    return undefined;
  } catch (err) {
    logger.warn("readExifOrientation failed", {
      reason: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
};
