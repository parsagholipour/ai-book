import { describe, expect, it } from "vitest";
import {
  imageRenderProvenance,
  storedImageRenderProvenance,
  withImageRenderProvenance
} from "./imageProvenance.js";

const rewrite = {
  refusalReason: "PROHIBITED_CONTENT",
  replaced: ["Spider-Man"],
  prompt: "A young masked hero in a red-and-blue suit."
};
const fallback = { primaryProvider: "gemini", fallbackProvider: "alibaba", reason: "refused" };

/**
 * The rule both writers of an existing `ImageAsset` row share: a redraw and an
 * undo each install one render's provenance and take the previous one away,
 * over a document whose other keys decide which slot the picture owns.
 */
describe("image render provenance", () => {
  it("omits what a clean render has nothing to say about", () => {
    expect(imageRenderProvenance({})).toEqual({});
    expect(imageRenderProvenance({ copyrightRewrite: rewrite })).toEqual({ copyrightRewrite: rewrite });
  });

  it("reads only the render half back off a stored document", () => {
    expect(storedImageRenderProvenance({ keeperToken: "v2-1", copyrightRewrite: rewrite })).toEqual({
      copyrightRewrite: rewrite
    });
    expect(storedImageRenderProvenance(null)).toEqual({});
  });

  it("clears the previous claim rather than letting it survive the pixels", () => {
    expect(withImageRenderProvenance({ keeperToken: "v2-1", copyrightRewrite: rewrite }, {})).toEqual({
      keeperToken: "v2-1"
    });
  });

  it("keeps every slot key while swapping the whole render half", () => {
    const previous = { keeperToken: "v2-1", model: "old-model", fallback, copyrightRewrite: rewrite };

    expect(withImageRenderProvenance(previous, { copyrightRewrite: { ...rewrite, replaced: ["Batman"] } })).toEqual({
      keeperToken: "v2-1",
      model: "old-model",
      copyrightRewrite: { ...rewrite, replaced: ["Batman"] }
    });
  });

  it("treats an unreadable document as one that claimed nothing", () => {
    expect(withImageRenderProvenance(undefined, { copyrightRewrite: rewrite })).toEqual({
      copyrightRewrite: rewrite
    });
    expect(withImageRenderProvenance(["not a record"], {})).toEqual({});
  });
});
