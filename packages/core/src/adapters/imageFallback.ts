import type { ImageAdapter, ImageFallbackAttempt, ImageFallbackMetadata, ImageRequest, ImageResult } from "./types.js";

export type ImageFallbackProvider = {
  provider: string;
  model: string;
};

export type ImageFallbackEvent =
  | {
      event: "fallback.start";
      primary: ImageFallbackAttempt & { error: Record<string, unknown> };
      fallback: ImageFallbackProvider;
    }
  | {
      event: "fallback.success";
      primary: ImageFallbackAttempt & { error: Record<string, unknown> };
      fallback: ImageFallbackProvider;
      result: ImageFallbackProvider;
    }
  | {
      event: "fallback.error";
      primary: ImageFallbackAttempt & { error: Record<string, unknown> };
      fallback: ImageFallbackAttempt & { error: Record<string, unknown> };
    };

export type FallbackImageAdapterOptions = {
  primary: ImageFallbackProvider & { adapter: ImageAdapter };
  fallback: ImageFallbackProvider & { adapter: ImageAdapter | (() => ImageAdapter) };
  onEvent?: (event: ImageFallbackEvent) => void | Promise<void>;
  shouldFallback?: (error: unknown) => boolean;
};

export class ImageGenerationFallbackError extends Error {
  readonly primary: ImageFallbackAttempt & { error: Record<string, unknown> };
  readonly fallback: ImageFallbackAttempt & { error: Record<string, unknown> };

  constructor(options: {
    primary: ImageFallbackAttempt & { error: Record<string, unknown> };
    fallback: ImageFallbackAttempt & { error: Record<string, unknown> };
  }) {
    super(
      `Image generation failed for primary ${options.primary.provider}/${options.primary.model} and fallback ${options.fallback.provider}/${options.fallback.model}. ` +
        `Primary error: ${errorMessage(options.primary.error)} Fallback error: ${errorMessage(options.fallback.error)}`
    );
    this.name = "ImageGenerationFallbackError";
    this.primary = options.primary;
    this.fallback = options.fallback;
  }
}

export class FallbackImageAdapter implements ImageAdapter {
  private fallbackAdapter: ImageAdapter | undefined;

  constructor(private readonly options: FallbackImageAdapterOptions) {}

  capabilities() {
    return this.options.primary.adapter.capabilities?.() ?? { supportsReferenceImages: false, maxReferenceImages: 0 };
  }

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    try {
      return await this.options.primary.adapter.generateImage(request);
    } catch (error) {
      if (this.options.shouldFallback && !this.options.shouldFallback(error)) {
        throw error;
      }
      const primary = {
        provider: this.options.primary.provider,
        model: this.options.primary.model,
        error: serializeFallbackError(error)
      };
      await this.options.onEvent?.({
        event: "fallback.start",
        primary,
        fallback: {
          provider: this.options.fallback.provider,
          model: this.options.fallback.model
        }
      });

      let fallbackAdapter: ImageAdapter;
      try {
        fallbackAdapter = this.resolveFallbackAdapter();
      } catch (fallbackError) {
        return this.failWithFallbackError(primary, {
          provider: this.options.fallback.provider,
          model: this.options.fallback.model,
          error: serializeFallbackError(fallbackError)
        });
      }

      try {
        const result = await fallbackAdapter.generateImage(request);
        const fallback = {
          provider: result.provider,
          model: result.model
        };
        await this.options.onEvent?.({
          event: "fallback.success",
          primary,
          fallback: {
            provider: this.options.fallback.provider,
            model: this.options.fallback.model
          },
          result: fallback
        });
        return {
          ...result,
          fallback: fallbackMetadata(primary, fallback)
        };
      } catch (fallbackError) {
        return this.failWithFallbackError(primary, {
          provider: this.options.fallback.provider,
          model: this.options.fallback.model,
          error: serializeFallbackError(fallbackError)
        });
      }
    }
  }

  private resolveFallbackAdapter(): ImageAdapter {
    if (this.fallbackAdapter) {
      return this.fallbackAdapter;
    }
    const adapter =
      typeof this.options.fallback.adapter === "function" ? this.options.fallback.adapter() : this.options.fallback.adapter;
    this.fallbackAdapter = adapter;
    return adapter;
  }

  private async failWithFallbackError(
    primary: ImageFallbackAttempt & { error: Record<string, unknown> },
    fallback: ImageFallbackAttempt & { error: Record<string, unknown> }
  ): Promise<never> {
    await this.options.onEvent?.({
      event: "fallback.error",
      primary,
      fallback
    });
    throw new ImageGenerationFallbackError({ primary, fallback });
  }
}

export function serializeFallbackError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { value: error };
  }
  const extra = Object.fromEntries(Object.entries(error as Error & Record<string, unknown>));
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...extra
  };
}

function fallbackMetadata(
  primary: ImageFallbackAttempt & { error: Record<string, unknown> },
  fallback: ImageFallbackProvider
): ImageFallbackMetadata {
  return {
    used: true,
    primary,
    fallback
  };
}

function errorMessage(error: Record<string, unknown>): string {
  return typeof error.message === "string" && error.message.trim() ? error.message : "Unknown error.";
}
