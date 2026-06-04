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
