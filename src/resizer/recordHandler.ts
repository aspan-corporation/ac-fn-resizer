import {
  AcContext,
  assertEnvVar,
  deriveFolder,
  getThumbnailKey,
  isAllowedExtension,
  MetricUnit,
  DIM_DETAIL_HEIGHT,
  DIM_DETAIL_WIDTH,
  DIM_THUMBNAIL_HEIGHT,
  DIM_THUMBNAIL_WIDTH,
} from "@aspan-corporation/ac-shared";
import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn";
import type { S3ObjectCreatedNotificationEvent, SQSRecord } from "aws-lambda";
import assert from "node:assert/strict";
import { makeThumbnail } from "./makeThumbnail.ts";
import { computeImageMeta } from "./imageMeta.ts";
import { buildBlurhashUpdateCommandInput } from "./blurhashUpdate.ts";

const sfnClient = new SFNClient({});

const destinationBucket = assertEnvVar("DESTINATION_BUCKET_NAME");
const metaTableName = assertEnvVar("AC_TAU_MEDIA_META_TABLE_NAME");
const TAG_HIDDEN = "ac:ediacara:hidden";

// Sharp/libvips/libheif messages for permanent (non-retryable) decode
// failures — the source can't be decoded by this layer, so retrying is futile.
const UNDECODABLE_RE =
  /heif|corrupt header|security limit|unsupported image format|unsupported (?:colour|color)|bad seek|VipsForeignLoad|Input buffer has corrupt header/i;

export const recordHandler = async (
  record: SQSRecord,
  context: AcContext,
): Promise<void> => {
  const { logger, metrics } = context;
  const { sourceS3Service, destinationS3Service, dynamoDBService } =
    context.acServices || {};
  assert(sourceS3Service, "s3Service is required in servicesContext");
  assert(
    destinationS3Service,
    "destinantionS3Service is required in servicesContext",
  );
  assert(dynamoDBService, "dynamoDBService is required in servicesContext");

  const payload = record.body;
  assert(payload, "SQS record has no body");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload) as Record<string, unknown>;
  } catch (e) {
    logger.error("Failed to parse SQS record payload", { error: e });
    throw new Error(
      `Failed to parse SQS record payload: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const taskToken =
    typeof parsed.taskToken === "string" ? parsed.taskToken : undefined;
  const item = parsed as unknown as S3ObjectCreatedNotificationEvent;

  const {
    detail: {
      object: { key: sourceKey, size },
      bucket: { name: sourceBucket },
    },
  } = item;

  assert(sourceKey, "detail.object.key is missing from event payload");
  assert(
    size !== undefined && size !== null,
    "detail.object.size is missing from event payload",
  );
  assert(sourceBucket, "detail.bucket.name is missing from event payload");

  const { Item: metaItem } = await dynamoDBService.getCommand({
    TableName: metaTableName,
    Key: { id: sourceKey },
  });
  if (
    (metaItem?.tags as { key: string }[] | undefined)?.some(
      (t) => t.key === TAG_HIDDEN,
    )
  ) {
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
    Key: sourceKey,
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
    key: sourceKey,
  });
  const thumbnailKey = getThumbnailKey({
    width: DIM_THUMBNAIL_WIDTH,
    height: DIM_THUMBNAIL_HEIGHT,
    key: sourceKey,
  });

  // BlurHash + oriented dimensions, computed once from the source buffer in
  // parallel with the two thumbnail renders. Powers the justified grid layout
  // (aspect ratio) and the blur-up placeholder. computeImageMeta is resilient
  // (resolves null on any failure); the extra `.catch` is belt-and-suspenders
  // so a rejection can never become an unhandled rejection that crashes the
  // invocation before this promise is awaited below.
  const imageMetaPromise = computeImageMeta(buffer).catch(() => null);

  try {
    await Promise.all([
      makeThumbnail(
        {
          buffer,
          sourceBucket,
          sourceKey,
          destinationBucket,
          destinationKey: detailKey,
          width: DIM_DETAIL_WIDTH,
          height: DIM_DETAIL_HEIGHT,
        },
        context,
        destinationS3Service,
      ),
      makeThumbnail(
        {
          buffer,
          sourceBucket,
          sourceKey,
          destinationBucket,
          destinationKey: thumbnailKey,
          width: DIM_THUMBNAIL_WIDTH,
          height: DIM_THUMBNAIL_HEIGHT,
        },
        context,
        destinationS3Service,
      ),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Permanent decode failures (e.g. libheif security limits like iref-box
    // reference counts on some iPhone HEICs, or a corrupt/unsupported source)
    // can never succeed on retry — skip the item rather than DLQ-storm. Any
    // existing thumbnail is left in place. Transient errors (S3 blips, etc.)
    // are rethrown so SQS retries them normally.
    if (UNDECODABLE_RE.test(msg)) {
      logger.warn("undecodable source; skipping thumbnail generation", {
        sourceKey,
        error: msg,
      });
      metrics.addMetric("PictureResizingSkipped", MetricUnit.Count, 1);
      if (taskToken) {
        await sfnClient.send(
          new SendTaskSuccessCommand({
            taskToken,
            output: JSON.stringify({ resized: false, skipped: true }),
          }),
        );
      }
      return;
    }
    throw e;
  }

  // Persist blurhash + dimensions onto the meta item. The resizer can race the
  // meta-extractor (no ordering is enforced between the two), so this upsert
  // seeds `tags`/`folder` via if_not_exists when the row doesn't exist yet
  // instead of refusing to write: a plain UpdateItem with no meta row present
  // would otherwise create a tagless, folder-less item, which breaks the
  // meta-table stream consumer (throws on undefined tags) and drops the item
  // out of the by-folder GSI until a future write repairs it. Whichever
  // Lambda writes second can never clobber the other's fields — processMeta
  // only ever sets `tags`/`folder`, this only ever sets `blurhash`/`width`/
  // `height` — so if_not_exists is safe in either arrival order.
  const imageMeta = await imageMetaPromise;
  if (imageMeta) {
    try {
      await dynamoDBService.updateCommand(
        buildBlurhashUpdateCommandInput({
          sourceKey,
          metaTableName,
          blurhash: imageMeta.blurhash,
          width: imageMeta.width,
          height: imageMeta.height,
          folder: deriveFolder(sourceKey),
        }),
      );
    } catch (e) {
      logger.error("failed to write blurhash/dimensions", {
        sourceKey,
        error: e,
      });
    }
  } else {
    logger.warn(
      "could not compute image metadata; skipped blurhash/dimensions",
      { sourceKey },
    );
  }

  logger.debug("PictureResizingsFinished", { sourceKey });
  metrics.addMetric("PictureResizingsFinished", MetricUnit.Count, 1);

  if (taskToken) {
    await sfnClient.send(
      new SendTaskSuccessCommand({
        taskToken,
        output: JSON.stringify({ resized: true }),
      }),
    );
  }
};
