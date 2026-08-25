import { describe, expect, it } from "vitest";

import { insertionFromClassifier } from "./applyImageInsertion.js";

describe("insertionFromClassifier", () => {
  it("keeps a replacement a replacement", () => {
    // `chat-image-<operationId>` is the marker the earlier insertion wrote and
    // the one the API's own re-resolution rebuilds; reading the stored `replace`
    // any other way would append and leave the reader with two pictures.
    expect(
      insertionFromClassifier({
        imageEdit: { subject: "a dragon", placement: "page", pageIndex: 2, replace: { operationId: "op-old" } }
      })
    ).toEqual({ subject: "a dragon", placement: "page", targetPageIndex: 2, replaceMarker: "chat-image-op-old" });
    expect(
      insertionFromClassifier({ imageEdit: { subject: "a fox", replace: { operationId: "", assetId: "asset-1" } } })
    ).toMatchObject({ replaceAssetId: "asset-1" });
  });
});
