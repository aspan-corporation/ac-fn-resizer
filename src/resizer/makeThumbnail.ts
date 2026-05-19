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

    // `fit: 'contain'` scales the image so its full content fits inside the
    // target box while preserving the original aspect ratio. Sharp's default
    // (`fit: 'cover'`) would crop edges to fill the box — we don't want that
    // for thumbnails because it hides parts of the picture.
    //
    // The leftover space is filled with a fully transparent pixel; WebP
    // supports alpha, so the thumbnail will be letterboxed/pillarboxed
    // transparently and blend cleanly against any background colour in the UI.
    // `failOnError: false` tells libvips to recover from minor JPEG/PNG
    // encoding errors (e.g. invalid SOS parameters) rather than throw.
    // Without it, slightly-corrupt-but-displayable files fail entirely.
    const resizedBuffer = await Sharp(buffer, { failOnError: false })
      .rotate() // libvips_autorot — handles all 8 EXIF orientations
      .resize(width, height, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .webp()
      .toBuffer();

    logger.debug(
      `finished resizing ${width}x${height} of ${sourceBucket}/${sourceKey}`
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
