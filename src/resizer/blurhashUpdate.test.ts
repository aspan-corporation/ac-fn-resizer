import { buildBlurhashUpdateCommandInput } from "./blurhashUpdate.ts";

describe("buildBlurhashUpdateCommandInput", () => {
  it("upserts blurhash/dimensions and seeds tags/folder via if_not_exists", () => {
    const input = buildBlurhashUpdateCommandInput({
      sourceKey: "media/2024/08/15/photo.jpg",
      metaTableName: "meta-table",
      blurhash: "L6PZfSi_.AyE",
      width: 1180,
      height: 820,
      folder: "media/2024/08/15/",
    });

    expect(input.TableName).toBe("meta-table");
    expect(input.Key).toEqual({ id: "media/2024/08/15/photo.jpg" });

    // No attribute_exists / ConditionExpression: the write must never be
    // rejected just because the meta-extractor hasn't run yet.
    expect("ConditionExpression" in input).toBe(false);
    expect(input.UpdateExpression).toContain(
      "if_not_exists(#tags, :emptyTags)",
    );
    expect(input.UpdateExpression).toContain("if_not_exists(#folder, :folder)");
    expect(input.UpdateExpression).not.toContain("attribute_exists");

    expect(input.ExpressionAttributeValues).toEqual({
      ":bh": "L6PZfSi_.AyE",
      ":w": 1180,
      ":h": 820,
      ":emptyTags": [],
      ":folder": "media/2024/08/15/",
    });
  });

  it("passes the given folder through unchanged", () => {
    const input = buildBlurhashUpdateCommandInput({
      sourceKey: "photo.jpg",
      metaTableName: "meta-table",
      blurhash: "abc",
      width: 10,
      height: 10,
      folder: "/",
    });

    expect(input.ExpressionAttributeValues[":folder"]).toBe("/");
  });
});
