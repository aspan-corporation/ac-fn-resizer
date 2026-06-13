import {
  AcContext,
  assertEnvVar,
  getThumbnailKey,
  isAllowedExtension,
  MetricUnit,
  DIM_DETAIL_HEIGHT,
  DIM_DETAIL_WIDTH,
  DIM_THUMBNAIL_HEIGHT,
  DIM_THUMBNAIL_WIDTH
} from "@aspan-corporation/ac-shared";
import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn";
import type { S3ObjectCreatedNotificationEvent, SQSRecord } from "aws-lambda";
import assert from "node:assert/strict";
import { makeThumbnail } from "./makeThumbnail.ts";
import { computeImageMeta } from "./imageMeta.ts";

const sfnClient = new SFNClient({});

const destinationBucket = assertEnvVar("DESTINATION_BUCKET_NAME");
const metaTableName = assertEnvVar("AC_TAU_MEDIA_META_TABLE_NAME");
const TAG_HIDDEN = "ac:ediacara:hidden";

export const recordHandler = async (
  record: SQSRecord,
  context: AcContext
): Promise<void> => {
  const { logger, metrics } = context;
  const { sourceS3Service, destinationS3Service, dynamoDBService } = context.acServices || {};
  assert(sourceS3Service, "s3Service is required in servicesContext");
  assert(destinationS3Service, "destinantionS3Service is required in servicesContext");
  assert(dynamoDBService, "dynamoDBService is required in servicesContext");

  const payload = record.body;
  assert(payload, "SQS record has no body");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload) as Record<string, unknown>;
  } catch (e) {
    logger.error("Failed to parse SQS record payload", { error: e });
    throw new Error(`Failed to parse SQS record payload: ${e instanceof Error ? e.message : String(e)}`);
  }
  const taskToken = typeof parsed.taskToken === "string" ? parsed.taskToken : undefined;
  const item = parsed as unknown as S3ObjectCreatedNotificationEvent;

  const {
    detail: {
      object: { key: sourceKey, size },
      bucket: { name: sourceBucket }
    }
  } = item;

  assert(sourceKey, "detail.object.key is missing from event payload");
  assert(size !== undefined && size !== null, "detail.object.size is missing from event payload");
  assert(sourceBucket, "detail.bucket.name is missing from event payload");

  const { Item: metaItem } = await dynamoDBService.getCommand({
    TableName: metaTableName,
    Key: { id: sourceKey },
  });
  if ((metaItem?.tags as { key: string }[] | undefined)?.some((t) => t.key === TAG_HIDDEN)) {
    logger.info("Skipping hidden file", { sourceKey });
    return;
  }

  logger.debug("PictureResizingsStarted", { sourceKey });
  metrics.addMetric("PictureResizingsStarted", MetricUnit.Count, 1);

  if (!isAllowedExtension(sourceKey)) {
    throw new Error(`extension for ${sourceKey} is not supported`);
  }

  const buffer = await sourceS3Service.getObject({
    Bucket: sourceBucket,
    Key: sourceKey
  });

  logger.debug("downloaded media file", { sourceBucket, sourceKey, size });

  // Orientation is handled inside makeThumbnail() via Sharp's `.rotate()` with
  // no args, which calls libvips_autorot. Our Sharp layer is built with
  // libexif support, so this works for both JPEG (uses EXIF Orientation) and
  // HEIC (libheif applies `irot` during decode and clears the orientation
  // metadata, so .rotate() is a safe no-op). All 8 EXIF orientations are
  // handled correctly, including the mirrored ones (2,4,5,7).

  const detailKey = getThumbnailKey({
    width: DIM_DETAIL_WIDTH,
    height: DIM_DETAIL_HEIGHT,
    key: sourceKey
  });
  const thumbnailKey = getThumbnailKey({
    width: DIM_THUMBNAIL_WIDTH,
    height: DIM_THUMBNAIL_HEIGHT,
    key: sourceKey
  });

  // BlurHash + oriented dimensions, computed once from the source buffer in
  // parallel with the two thumbnail renders. Powers the justified grid layout
  // (aspect ratio) and the blur-up placeholder. computeImageMeta is resilient
  // (resolves null on any failure); the extra `.catch` is belt-and-suspenders
  // so a rejection can never become an unhandled rejection that crashes the
  // invocation before this promise is awaited below.
  const imageMetaPromise = computeImageMeta(buffer).catch(() => null);

  await Promise.all([
    makeThumbnail(
      {
        buffer,
        sourceBucket,
        sourceKey,
        destinationBucket,
        destinationKey: detailKey,
        width: DIM_DETAIL_WIDTH,
        height: DIM_DETAIL_HEIGHT
      },
      context,
      destinationS3Service
    ),
    makeThumbnail(
      {
        buffer,
        sourceBucket,
        sourceKey,
        destinationBucket,
        destinationKey: thumbnailKey,
        width: DIM_THUMBNAIL_WIDTH,
        height: DIM_THUMBNAIL_HEIGHT
      },
      context,
      destinationS3Service
    )
  ]);

  // Persist blurhash + dimensions onto the existing meta item (written earlier
  // in the pipeline by the metadata extractor). attribute_exists guards against
  // creating a tagless partial item if the meta row isn't present yet; a miss
  // is logged and ignored so it never fails the resize/SendTaskSuccess.
  const imageMeta = await imageMetaPromise;
  if (imageMeta) {
    try {
      await dynamoDBService.updateCommand({
        TableName: metaTableName,
        Key: { id: sourceKey },
        UpdateExpression: "SET #bh = :bh, #w = :w, #h = :h",
        ConditionExpression: "attribute_exists(id)",
        ExpressionAttributeNames: { "#bh": "blurhash", "#w": "width", "#h": "height" },
        ExpressionAttributeValues: {
          ":bh": imageMeta.blurhash,
          ":w": imageMeta.width,
          ":h": imageMeta.height
        }
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : String(e);
      if (name === "ConditionalCheckFailedException") {
        logger.warn("meta item absent; skipped blurhash/dimensions write", { sourceKey });
      } else {
        logger.error("failed to write blurhash/dimensions", { sourceKey, error: e });
      }
    }
  } else {
    logger.warn("could not compute image metadata; skipped blurhash/dimensions", { sourceKey });
  }

  logger.debug("PictureResizingsFinished", { sourceKey });
  metrics.addMetric("PictureResizingsFinished", MetricUnit.Count, 1);

  if (taskToken) {
    await sfnClient.send(new SendTaskSuccessCommand({
      taskToken,
      output: JSON.stringify({ resized: true }),
    }));
  }
};
