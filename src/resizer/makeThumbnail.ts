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
 * Resizes an image and uploads it to S3. Output is always in JPEG format.
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

  try {
    logger.debug(
      `starting resizing ${width}x${height} of ${sourceBucket}/${sourceKey}`
    );

    const resizedBuffer = await Sharp(buffer).resize(width, height).jpeg().toBuffer();

    logger.debug(
      `finished resizing ${width}x${height} of ${sourceBucket}/${sourceKey}`
    );

    await destinationS3Service.putObject({
      Bucket: destinationBucket,
      Key: destinationKey,
      Body: resizedBuffer
    });

    logger.debug(`uploaded resized image to ${destinationBucket}/${destinationKey}`);
  } finally {
    logger.resetKeys();
  }
};
