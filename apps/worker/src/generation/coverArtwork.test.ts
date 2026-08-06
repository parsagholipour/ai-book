import { describe, expect, it } from "vitest";
import { coverDesign, type CoverDesign } from "@book-maker/core";
import { coverDesignArtwork, coverDesignArtworkMimeType } from "./coverArtwork.js";

const design = coverDesign("moonlit-sea") as CoverDesign;

describe("coverDesignArtwork", () => {
  it("draws the design when it names no file", async () => {
    const artwork = await coverDesignArtwork(design);

    expect(artwork.source).toBe("generated");
    expect(artwork.mimeType).toBe("image/svg+xml");
    expect(artwork.bytes.toString("utf8").startsWith("<svg")).toBe(true);
  });

  it("falls back to the generated artwork when the named file is missing", async () => {
    // A cover is worth more than being right about which cover: this runs at
    // the end of a book that is already written and paid for.
    const artwork = await coverDesignArtwork({ ...design, artworkFile: "not-shipped.jpg" });

    expect(artwork.source).toBe("generated");
    expect(artwork.bytes.byteLength).toBeGreaterThan(0);
  });

  it("names the content type from the file extension", () => {
    expect(coverDesignArtworkMimeType("moonlit-sea.jpg")).toBe("image/jpeg");
    expect(coverDesignArtworkMimeType("moonlit-sea.PNG")).toBe("image/png");
    expect(coverDesignArtworkMimeType("moonlit-sea.tiff")).toBe("application/octet-stream");
  });
});
