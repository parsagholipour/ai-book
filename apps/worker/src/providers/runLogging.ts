import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  isRecoverableNetworkError,
  providerRetryAfterMs,
  safePathPart,
  type GenerateTextOptions,
  type ImageAdapter
} from "@book-maker/core";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import { safeJsonStringify, serializeError } from "../runtime/serialization.js";
import { config } from "../runtime/config.js";
import {
  workerJobStringField,
  type RawWorkerJob
} from "../runtime/jobPayloads.js";

/**
 * Per-job run logs and the retry/reporting policy around provider calls.
 *
 * Every AI call a job makes is appended as a JSON line under
 * `<BOOK_STORAGE_DIR>/<projectId>/runs/`, which is the primary artifact for
 * debugging a generation after the fact.
 */

/** Network retry budget applied to every provider call. */
const PROVIDER_NETWORK_RETRY_ATTEMPTS = 3;
const PROVIDER_NETWORK_RETRY_DELAY_MS = 2_000;

export type RunLogger = {
  filePath: string;
  append(event: string, data: Record<string, unknown>): Promise<string>;
};

export type LoggedImageAttempt = {
  role: "primary" | "fallback";
  provider: string;
  model: string;
};

export function createRunLogger(job: RawWorkerJob): RunLogger {
  const projectId = workerJobStringField(job, "projectId") ?? "_unknown-project";
  const generationJobId = workerJobStringField(job, "generationJobId");
  const runId = generationJobId ?? `bull-${job.id ?? "unknown"}`;
  const logDir = join(config.BOOK_STORAGE_DIR, projectId, "runs");
  const filePath = join(logDir, `${safePathPart(runId)}-${safePathPart(job.name)}.jsonl`);

  return {
    filePath,
    async append(event, data) {
      const timestamp = new Date().toISOString();
      const entry = {
        timestamp,
        event,
        job: {
          id: job.id,
          name: job.name,
          generationJobId,
          projectId,
          logFile: filePath
        },
        ...data
      };
      try {
        await mkdir(logDir, { recursive: true });
        await appendFile(filePath, `${safeJsonStringify(entry)}\n`, "utf8");
      } catch (error) {
        console.error(`Failed to write run log ${filePath}`, error);
      }
      return timestamp;
    }
  };
}

export function providerConfigSnapshot() {
  return {
    gemini: {
      apiKeySet: Boolean(config.GEMINI_API_KEY),
      textModel: config.GEMINI_TEXT_MODEL,
      imageModel: config.GEMINI_IMAGE_MODEL,
      embeddingModel: config.GEMINI_EMBEDDING_MODEL,
      ttsModel: config.GEMINI_TTS_MODEL
    },
    openai: {
      apiKeySet: Boolean(config.OPENAI_API_KEY),
      ttsModel: config.OPENAI_TTS_MODEL
    },
    alibaba: {
      apiKeySet: Boolean(config.ALIBABA_API_KEY),
      apiHost: config.ALIBABA_API_HOST,
      textModel: config.ALIBABA_TEXT_MODEL,
      imageModel: config.ALIBABA_IMAGE_MODEL
    },
    deepinfra: {
      apiKeySet: Boolean(config.DEEPINFRA_API_KEY),
      baseURL: config.DEEPINFRA_BASE_URL,
      textModel: config.DEEPINFRA_MODEL,
      fastTextModel: config.DEEPINFRA_FAST_MODEL
    },
    openrouter: {
      apiKeySet: Boolean(config.OPENROUTER_API_KEY),
      baseURL: config.OPENROUTER_BASE_URL
    }
  };
}

export function providerRetryOptions(
  logger: RunLogger,
  generationJobId: string | undefined,
  operation: string,
  purpose?: string | undefined,
  signal?: AbortSignal | undefined
) {
  return {
    attempts: PROVIDER_NETWORK_RETRY_ATTEMPTS,
    delayMs: PROVIDER_NETWORK_RETRY_DELAY_MS,
    // A user stop aborts the in-flight call, and an abort matches the
    // recoverable network patterns (ABORT_ERR, /aborted/) — so the retry loop
    // used to sit out its whole backoff re-invoking the provider against an
    // already-aborted signal, adding ~6s of dead latency per in-flight call
    // to every stop. Once the signal is aborted, nothing is recoverable.
    shouldRetry: (error: unknown) => !signal?.aborted && isRecoverableNetworkError(error),
    onRetry: async ({
      attempt,
      attempts,
      delayMs,
      error
    }: {
      attempt: number;
      attempts: number;
      delayMs: number;
      error: unknown;
    }) => {
      const throttled = providerRetryAfterMs(error) !== undefined;
      await logger.append(`${operation}.retry`, {
        attempt,
        attempts,
        nextAttempt: attempt + 1,
        delayMs,
        recoverable: true,
        ...(throttled ? { throttled: true } : {}),
        error: serializeError(error)
      });
      await updateJobProgress(generationJobId, {
        // A quota wait is not a network fault, and it is long enough that saying
        // so is the difference between "stuck" and "waiting its turn".
        message: throttled
          ? `${providerOperationLabel(operation, purpose)} is waiting on the provider's rate limit; resuming in ${Math.round(delayMs / 1000)}s (${attempt + 1}/${attempts}).`
          : `${providerOperationLabel(operation, purpose)} hit a network interruption; retrying (${attempt + 1}/${attempts}).`
      });
    }
  };
}

export function providerOperationLabel(operation: string, purpose?: string | undefined): string {
  if (purpose) {
    return purpose;
  }
  switch (operation) {
    case "research.search":
      return "Research";
    case "image.generate":
      return "Image generation";
    case "embedding.embed":
      return "Embedding";
    default:
      return "Provider call";
  }
}

export function logTextRequest(options: GenerateTextOptions, providerCallMetadata: Record<string, unknown> = {}) {
  return {
    purpose: options.purpose,
    projectId: options.projectId,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    messages: options.messages,
    ...(Object.keys(providerCallMetadata).length > 0 ? { providerCallMetadata } : {})
  };
}

export function logImageResult(result: Awaited<ReturnType<ImageAdapter["generateImage"]>>) {
  return {
    provider: result.provider,
    model: result.model,
    mimeType: result.mimeType,
    url: result.url,
    revisedPrompt: result.revisedPrompt,
    fallback: result.fallback,
    dataBytes: result.data?.byteLength
  };
}

export function attachProviderLogContext(
  error: unknown,
  context: { callId: string; attempt?: LoggedImageAttempt | undefined }
): void {
  if (!error || typeof error !== "object") {
    return;
  }
  try {
    (error as Record<string, unknown>).providerLog = {
      callId: context.callId,
      ...(context.attempt ? { attempt: context.attempt } : {})
    };
  } catch {
    // Non-extensible provider errors are still logged through serializeError.
  }
}
