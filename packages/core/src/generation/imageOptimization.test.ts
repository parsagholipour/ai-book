import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { optimizeImageForStorage } from "./imageOptimization.js";

describe("optimizeImageForStorage", () => {
  it("resizes wide raster images and stores them as compressed jpeg", async () => {
    const input = await sharp({
      create: {
        width: 2400,
        height: 1200,
        channels: 3,
        background: "#d946ef"
      }
    })
      .png()
      .toBuffer();

    const result = await optimizeImageForStorage({
      bytes: input,
      mimeType: "image/png",
      maxWidth: 1200,
      quality: 80
    });
    const metadata = await sharp(result.bytes).metadata();

    expect(result.optimized).toBe(true);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.extension).toBe("jpg");
    expect(result.originalWidth).toBe(2400);
    expect(result.width).toBe(1200);
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(600);
  });

  it("alwaysReencode strips metadata the size rule would have kept", async () => {
    // The default rule keeps the caller's bytes when the re-encode comes out
    // larger, which is the ordinary outcome for an already-compressed photo
    // under maxWidth — so an upload was stored verbatim, EXIF and GPS
    // included. Anything storing bytes a user supplied has to opt out of that.
    // Noise, not a flat colour: a solid block re-encodes smaller at any
    // quality and would never reach the branch this test is about. Seeded by
    // hand so the bytes are the same on every run.
    const pixels = Buffer.alloc(400 * 400 * 3);
    for (let index = 0; index < pixels.length; index++) {
      pixels[index] = (index * 2654435761) % 251;
    }
    const withExif = await sharp(pixels, { raw: { width: 400, height: 400, channels: 3 } })
      .withExif({ IFD0: { Copyright: "tomeza-test", Software: "tomeza" } })
      .jpeg({ quality: 40 })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const kept = await optimizeImageForStorage({
      bytes: withExif,
      mimeType: "image/jpeg",
      maxWidth: 1600,
      quality: 82
    });
    // The default path hands the original straight back, metadata and all.
    expect(kept.optimized).toBe(false);
    expect(kept.bytes).toBe(withExif);
    expect((await sharp(kept.bytes).metadata()).exif).toBeDefined();

    const stripped = await optimizeImageForStorage({
      bytes: withExif,
      mimeType: "image/jpeg",
      maxWidth: 1600,
      quality: 82,
      alwaysReencode: true
    });

    expect(stripped.optimized).toBe(true);
    expect(stripped.mimeType).toBe("image/jpeg");
    expect((await sharp(stripped.bytes).metadata()).exif).toBeUndefined();
  });

  it("keeps svg images unchanged", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1200"></svg>');

    const result = await optimizeImageForStorage({
      bytes: svg,
      mimeType: "image/svg+xml",
      maxWidth: 1200
    });

    expect(result.optimized).toBe(false);
    expect(result.mimeType).toBe("image/svg+xml");
    expect(result.extension).toBe("svg");
    expect(result.bytes).toBe(svg);
  });
});
