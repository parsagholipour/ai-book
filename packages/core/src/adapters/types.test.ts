import { describe, expect, it } from "vitest";
import { imageAdapterCapabilities } from "./types.js";
import type { ImageAdapter } from "./types.js";

const adapter = (capabilities?: ImageAdapter["capabilities"]): ImageAdapter => ({
  generateImage: async () => {
    throw new Error("not called");
  },
  ...(capabilities ? { capabilities } : {})
});

describe("imageAdapterCapabilities", () => {
  it("returns what the adapter declares", () => {
    expect(imageAdapterCapabilities(adapter(() => ({ supportsReferenceImages: true, maxReferenceImages: 3 })))).toEqual({
      supportsReferenceImages: true,
      maxReferenceImages: 3
    });
  });

  // Every wrapper that forwards `capabilities()` shares this answer, and the
  // number is how many character reference sheets a render attaches — so an
  // adapter that declares nothing must attach none rather than an unbounded set.
  it("assumes an adapter that declares nothing supports no reference images", () => {
    expect(imageAdapterCapabilities(adapter())).toEqual({ supportsReferenceImages: false, maxReferenceImages: 0 });
  });
});
