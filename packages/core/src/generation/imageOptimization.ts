import sharp from "sharp";

export const DEFAULT_OPTIMIZED_IMAGE_MAX_WIDTH = 1600;
export const DEFAULT_OPTIMIZED_IMAGE_QUALITY = 82;

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/svg+xml": "svg"
};

export type OptimizeImageForStorageOptions = {
  bytes: Buffer;
  mimeType: string;
  maxWidth?: number | undefined;
  quality?: number | undefined;
  /**
   * Keep the re-encoded output even when it is larger than the input.
   *
   * The size comparison below is the right rule for our own renders, which
   * carry no metadata and only ever need shrinking. It is the wrong rule for an
   * upload: an already-compressed photo under `maxWidth` re-encodes *larger* at
   * quality 82, so the original buffer is stored verbatim — EXIF, GPS and all.
   * Any caller storing bytes a user supplied should pass true, because the
   * re-encode is the only thing that strips that metadata.
   */
  alwaysReencode?: boolean | undefined;
};

export type OptimizedImage = {
  bytes: Buffer;
  mimeType: string;
  extension: string;
  optimized: boolean;
  maxWidth: number;
  originalMimeType: string;
  originalBytes: number;
  outputBytes: number;
  originalWidth?: number | undefined;
  originalHeight?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
};

export async function optimizeImageForStorage(options: OptimizeImageForStorageOptions): Promise<OptimizedImage> {
  const maxWidth = options.maxWidth ?? DEFAULT_OPTIMIZED_IMAGE_MAX_WIDTH;
  const quality = options.quality ?? DEFAULT_OPTIMIZED_IMAGE_QUALITY;
  const originalBytes = options.bytes.length;

  if (options.mimeType === "image/svg+xml") {
    return unchangedImage(options.bytes, options.mimeType, maxWidth);
  }

  try {
    const original = await sharp(options.bytes).metadata();
    const shouldResize = typeof original.width === "number" && original.width > maxWidth;
    let pipeline = sharp(options.bytes).rotate();
    if (original.hasAlpha) {
      pipeline = pipeline.flatten({ background: "#ffffff" });
    }
    if (shouldResize) {
      pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
    }

    const optimizedBytes = await pipeline.jpeg({ quality, progressive: true, mozjpeg: true }).toBuffer();
    const output = await sharp(optimizedBytes).metadata();
    const useOptimized = options.alwaysReencode === true || shouldResize || optimizedBytes.length < originalBytes;

    if (!useOptimized) {
      return {
        ...(await unchangedImage(options.bytes, options.mimeType, maxWidth)),
        originalWidth: original.width,
        originalHeight: original.height,
        width: original.width,
        height: original.height
      };
    }

    return {
      bytes: optimizedBytes,
      mimeType: "image/jpeg",
      extension: "jpg",
      optimized: true,
      maxWidth,
      originalMimeType: options.mimeType,
      originalBytes,
      outputBytes: optimizedBytes.length,
      originalWidth: original.width,
      originalHeight: original.height,
      width: output.width,
      height: output.height
    };
  } catch {
    return unchangedImage(options.bytes, options.mimeType, maxWidth);
  }
}

async function unchangedImage(bytes: Buffer, mimeType: string, maxWidth: number): Promise<OptimizedImage> {
  return {
    bytes,
    mimeType,
    extension: extensionForMime(mimeType),
    optimized: false,
    maxWidth,
    originalMimeType: mimeType,
    originalBytes: bytes.length,
    outputBytes: bytes.length
  };
}

function extensionForMime(mimeType: string): string {
  return EXTENSION_BY_MIME[mimeType] ?? "png";
}
