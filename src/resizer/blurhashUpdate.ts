// Kept free of any runtime imports so it can be unit-tested without loading
// the ESM-only @aspan-corporation/ac-shared package under Jest (see
// ac-fn-video-encoder's encodeSkip.ts for the same constraint). The caller
// (recordHandler.ts) already imports ac-shared, so it computes `folder` via
// deriveFolder(sourceKey) and passes it in.

export interface BlurhashUpdateParams {
  sourceKey: string;
  metaTableName: string;
  blurhash: string;
  width: number;
  height: number;
  folder: string;
}

export interface BlurhashUpdateCommandInput {
  TableName: string;
  Key: { id: string };
  UpdateExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, unknown>;
}

/**
 * Builds the UpdateItem params that persist blurhash/dimensions onto a meta
 * item. Uses if_not_exists to seed `tags`/`folder` when the row doesn't exist
 * yet (the resizer can race the meta-extractor, with no ordering enforced
 * between them) instead of refusing to write via attribute_exists: a bare
 * UpdateItem with no row present would otherwise create a tagless,
 * folder-less item, which throws in the meta-table stream consumer and drops
 * the item out of the by-folder GSI until repaired. processMeta only ever
 * sets `tags`/`folder`, this only ever sets `blurhash`/`width`/`height`, so
 * if_not_exists is safe regardless of which Lambda's write lands first.
 */
export const buildBlurhashUpdateCommandInput = ({
  sourceKey,
  metaTableName,
  blurhash,
  width,
  height,
  folder,
}: BlurhashUpdateParams): BlurhashUpdateCommandInput => ({
  TableName: metaTableName,
  Key: { id: sourceKey },
  UpdateExpression:
    "SET #bh = :bh, #w = :w, #h = :h, #tags = if_not_exists(#tags, :emptyTags), #folder = if_not_exists(#folder, :folder)",
  ExpressionAttributeNames: {
    "#bh": "blurhash",
    "#w": "width",
    "#h": "height",
    "#tags": "tags",
    "#folder": "folder",
  },
  ExpressionAttributeValues: {
    ":bh": blurhash,
    ":w": width,
    ":h": height,
    ":emptyTags": [],
    ":folder": folder,
  },
});
