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
import type { S3ObjectCreatedNotificationEvent, SQSRecord } from "aws-lambda";
import assert from "node:assert/strict";
import { makeThumbnail } from "./makeThumbnail.ts";

const destinationBucket = assertEnvVar("DESTINATION_BUCKET_NAME");

export const recordHandler = async (
  record: SQSRecord,
  context: AcContext
): Promise<void> => {
  const { logger, metrics } = context;
  const { sourceS3Service, destinationS3Service } = context.acServices || {};
  assert(sourceS3Service, "s3Service is required in servicesContext");
  assert(
    destinationS3Service,
    "destinantionS3Service is required in servicesContext"
  );

  const payload = record.body;
  assert(payload, "SQS record has no body");

  let item: S3ObjectCreatedNotificationEvent;
  try {
    item = JSON.parse(payload) as S3ObjectCreatedNotificationEvent;
  } catch (e) {
    logger.error("Failed to parse SQS record payload", { error: e });
    throw new Error(`Failed to parse SQS record payload: ${e instanceof Error ? e.message : String(e)}`);
  }

  const {
    detail: {
      object: { key: sourceKey, size },
      bucket: { name: sourceBucket }
    }
  } = item;

  assert(sourceKey, "detail.object.key is missing from event payload");
  assert(size !== undefined && size !== null, "detail.object.size is missing from event payload");
  assert(sourceBucket, "detail.bucket.name is missing from event payload");

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

  logger.debug("PictureResizingsFinished", { sourceKey });
  metrics.addMetric("PictureResizingsFinished", MetricUnit.Count, 1);
};
