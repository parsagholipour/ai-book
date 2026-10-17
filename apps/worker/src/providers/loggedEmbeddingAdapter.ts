import { randomUUID } from "node:crypto";
import { withRecoverableNetworkRetry, type EmbeddingAdapter } from "@book-maker/core";
import { config } from "../runtime/config.js";
import { assertJobNotStopped } from "../runtime/jobLifecycle.js";
import { serializeError } from "../runtime/serialization.js";
import { providerRetryOptions, type RunLogger } from "./runLogging.js";
import { recordProviderQuotaRefusal } from "./usageAccounting.js";

/**
 * Who an embedding is sent to. Every book's embeddings are Gemini's
 * (`FIXED_PROVIDER_USES` in core, pinned against what `createProviders`
 * builds), and the adapter does not say so itself, so a call an empty account
 * refused is attributed from the same configuration the factory read.
 */
function configuredEmbeddingIdentity(): { provider: string; model: string } | undefined {
  return config.MOCK_AI ? undefined : { provider: "gemini", model: config.GEMINI_EMBEDDING_MODEL };
}

/**
 * Embeddings, logged and stop-checked like every other provider call. A
 * success writes no cost row (an embedding is priced nowhere); a call refused
 * for an empty account writes a failed one, because that row is what the
 * operator's provider-quota alert reads (`recordProviderQuotaRefusal`).
 */
export class LoggingEmbeddingAdapter implements EmbeddingAdapter {
  constructor(
    private readonly delegate: EmbeddingAdapter,
    private readonly logger: RunLogger,
    private readonly generationJobId: string | undefined,
    private readonly projectId: string | undefined = undefined,
    private readonly identity: { provider: string; model: string } | undefined = configuredEmbeddingIdentity()
  ) {}

  async embed(text: string) {
    const callId = randomUUID();
    const startedAt = Date.now();
    await this.logger.append("embedding.embed.request", {
      callId,
      textLength: text.length,
      textPreview: text.slice(0, 500)
    });
    try {
      await assertJobNotStopped(this.generationJobId);
      const vector = await withRecoverableNetworkRetry(
        () => this.delegate.embed(text),
        providerRetryOptions(this.logger, this.generationJobId, "embedding.embed")
      );
      await this.logger.append("embedding.embed.response", { callId, vectorLength: vector.length });
      await assertJobNotStopped(this.generationJobId);
      return vector;
    } catch (error) {
      await this.logger.append("embedding.embed.error", { callId, error: serializeError(error) });
      if (this.identity) {
        await recordProviderQuotaRefusal({
          projectId: this.projectId,
          generationJobId: this.generationJobId,
          ...this.identity,
          operation: "embedding.embed",
          callId,
          durationMs: Date.now() - startedAt,
          error
        });
      }
      await assertJobNotStopped(this.generationJobId);
      throw error;
    }
  }
}
