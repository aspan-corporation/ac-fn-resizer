import { AcContext, S3Service } from "@aspan-corporation/ac-shared";
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
 * Resizes an image and uploads it to S3. Output is always WebP.
 *
 * Orientation: `Sharp(buffer).rotate()` (no args) calls libvips_autorot, which
 * honours the EXIF Orientation tag (1–8, including mirrored 2/4/5/7) for JPEG
 * and PNG. For HEIC, libheif applies the HEIF `irot` transform during decode
 * and then clears the orientation metadata, so .rotate() is a safe no-op.
 * This requires the Sharp layer to be built with libexif support — see
 * ac-sharp/layers/sharp/Makefile.
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
  destinationS3Service: S3Service
) => {
  logger.appendKeys({ function: "makeThumbnail" });

  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`Invalid thumbnail dimensions: ${width}x${height}`);
  }

  try {
    logger.debug(
      `starting resizing ${width}x${height} of ${sourceBucket}/${sourceKey}`
    );

    // `fit: 'inside'` scales the image so its full content fits inside the
    // target box while preserving the original aspect ratio — but, unlike
    // `'contain'`, it does NOT pad the leftover space. The output therefore has
    // the image's true aspect ratio (e.g. 320x213 for a 3:2 photo) with no
    // transparent letterbox bars. This is what the justified/aspect-ratio grid
    // needs: each cell takes the image's aspect and the thumbnail fills it
    // cleanly. `withoutEnlargement` keeps small originals from being upscaled.
    // `failOnError: false` tells libvips to recover from minor JPEG/PNG
    // encoding errors (e.g. invalid SOS parameters) rather than throw.
    const { data: resizedBuffer, info } = await Sharp(buffer, { failOnError: false })
      .rotate() // libvips_autorot — handles all 8 EXIF orientations
      .resize(width, height, {
        fit: "inside",
        withoutEnlargement: true
      })
      .webp()
      .toBuffer({ resolveWithObject: true });

    logger.debug(
      `finished resizing ${width}x${height} of ${sourceBucket}/${sourceKey}`
    );

    await destinationS3Service.putObject({
      Bucket: destinationBucket,
      Key: destinationKey,
      Body: resizedBuffer,
      // Correct content type so CloudFront/browsers treat it as an image
      // (previously omitted → served as application/octet-stream).
      ContentType: "image/webp"
    });

    logger.debug(
      `uploaded resized image to ${destinationBucket}/${destinationKey}`
    );

    return { width: info.width, height: info.height };
  } finally {
    logger.resetKeys();
  }
};
