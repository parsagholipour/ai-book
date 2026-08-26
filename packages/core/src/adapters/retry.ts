export type RecoverableRetryContext = {
  attempt: number;
  attempts: number;
  delayMs: number;
  error: unknown;
};

/**
 * An HTTP failure from a provider, carrying the status as a field rather than
 * only inside the message. A plain `Error` whose text happens to contain "429"
 * is invisible to {@link isRecoverableNetworkError}, so a throttled call would
 * be treated as a deterministic failure and never retried.
 *
 * `retryAfterMs` is the cooldown the provider itself asked for, when it named
 * one — see {@link recoverableRetryDelayMs}.
 */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: { status: number; retryAfterMs?: number | undefined }) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export type RecoverableRetryOptions = {
  attempts?: number | undefined;
  delayMs?: number | undefined;
  maxDelayMs?: number | undefined;
  shouldRetry?: ((error: unknown) => boolean) | undefined;
  onRetry?: ((context: RecoverableRetryContext) => void | Promise<void>) | undefined;
};

const DEFAULT_RECOVERABLE_ATTEMPTS = 3;
const DEFAULT_RECOVERABLE_DELAY_MS = 2_000;
const DEFAULT_RECOVERABLE_MAX_DELAY_MS = 12_000;
/**
 * Longest cooldown worth sitting out. A per-minute quota asks for seconds; a
 * spent daily quota asks for hours, and that is not a blip to wait through.
 */
export const PROVIDER_RETRY_AFTER_CEILING_MS = 90_000;

const RECOVERABLE_NETWORK_CODES = new Set([
  "ABORT_ERR",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);

// 429 belongs here: a quota window is the most transient failure a provider has,
// and the wait it asks for is honoured below rather than guessed at.
const RECOVERABLE_HTTP_STATUSES = new Set([408, 429, 502, 503, 504]);

const RECOVERABLE_NETWORK_MESSAGE_PATTERNS = [
  /\bterminated\b/i,
  /\bfetch failed\b/i,
  /\bnetwork\b/i,
  /\bsocket hang up\b/i,
  /\bconnection (?:closed|reset|terminated|timed out|timeout)\b/i,
  /\bother side closed\b/i,
  /\brequest timed out\b/i,
  /\btimeout\b/i,
  /\babort(?:ed)?\b/i
];

export async function withRecoverableNetworkRetry<T>(
  operation: () => Promise<T>,
  options: RecoverableRetryOptions = {}
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_RECOVERABLE_ATTEMPTS));
  const shouldRetry = options.shouldRetry ?? isRecoverableNetworkError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !shouldRetry(error)) {
        throw error;
      }

      const delayMs = recoverableRetryDelayMs(attempt, options, error);
      await options.onRetry?.({ attempt, attempts, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw new Error("Recoverable operation exhausted retries.");
}

export function isRecoverableNetworkError(error: unknown): boolean {
  const requested = providerRetryAfterMs(error);
  if (requested !== undefined && requested > PROVIDER_RETRY_AFTER_CEILING_MS) {
    // "Please retry in 5h44m" is an exhausted daily quota. Every attempt inside
    // that window fails identically, so calling it recoverable only burns the
    // retry budget — at every layer, including the job's — and delays the refund
    // and the honest error by however long the budget takes to spend.
    return false;
  }
  return collectErrorDescriptors(error).some((descriptor) => {
    if (descriptor.code && RECOVERABLE_NETWORK_CODES.has(descriptor.code.toUpperCase())) {
      return true;
    }
    if (descriptor.status !== undefined && RECOVERABLE_HTTP_STATUSES.has(descriptor.status)) {
      return true;
    }
    return descriptor.messages.some((message) =>
      RECOVERABLE_NETWORK_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
    );
  });
}

/** Errors that can justify restarting an audiobook with its backup provider. */
export function isSpeechProviderFallbackError(error: unknown): boolean {
  if (isStopOrAbortError(error)) {
    return false;
  }
  return collectErrorDescriptors(error).some((descriptor) => {
    if (descriptor.status !== undefined) {
      return descriptor.status === 408 || descriptor.status === 429 || descriptor.status >= 500;
    }
    if (descriptor.code && RECOVERABLE_NETWORK_CODES.has(descriptor.code.toUpperCase())) {
      return true;
    }
    return descriptor.messages.some((message) =>
      /(?:fetch failed|network|connection (?:closed|reset|terminated|timed out)|socket hang up|timeout|timed out)/i.test(
        message
      )
    );
  });
}

/** Availability failures that may be retried once through an operator-selected text fallback. */
export function isTextProviderFallbackError(error: unknown): boolean {
  if (isStopOrAbortError(error)) {
    return false;
  }
  return collectErrorDescriptors(error).some((descriptor) => {
    if (descriptor.status !== undefined) {
      return descriptor.status === 408 || descriptor.status === 409 || descriptor.status === 429 || descriptor.status >= 500;
    }
    if (descriptor.code && RECOVERABLE_NETWORK_CODES.has(descriptor.code.toUpperCase())) {
      return true;
    }
    return descriptor.messages.some((message) =>
      /(?:rate.?limit|quota|capacity|overload|temporar(?:y|ily)|unavailable|fetch failed|network|connection (?:closed|reset|terminated|timed out)|socket hang up|timeout|timed out)/i.test(
        message
      )
    );
  });
}

/**
 * A cancellation rather than a failure: the run was stopped, or the call was
 * aborted, so nothing downstream may retry it, fall back from it, or fold it
 * into a value the caller keeps working with.
 *
 * The class itself — the worker's `StopRequestedError`, which
 * `LoggingEmbeddingAdapter.embed` and its siblings raise off `assertJobNotStopped`
 * — is not reachable from here: `packages/core` is the leaf of
 * `apps/* -> packages/db -> packages/core`. So this matches the shape instead,
 * over `name`, `message` and every nested `cause`, which is what lets a policy
 * inside core hold the line the worker's own `isStopRequestedError` holds on
 * its side of the boundary.
 */
export function isStopOrAbortError(error: unknown): boolean {
  return collectErrorDescriptors(error).some((descriptor) =>
    descriptor.messages.some((message) =>
      /(?:AbortError|StopRequestedError|stop requested|stopped by user|request aborted)/i.test(message)
    )
  );
}

const CANCELLATION_ERROR_NAMES = new Set(["ABORTERROR", "STOPREQUESTEDERROR"]);

/**
 * The same question read off the error's *identity* rather than its prose: the
 * `name` an `AbortController`'s `DOMException` carries, the `name` the worker's
 * `StopRequestedError` sets on itself, or the `ABORT_ERR` code beside them —
 * over the error and every nested `cause`, as above.
 *
 * {@link isStopOrAbortError} reads message text too, and that width is right
 * where a false positive only ever *suppresses* something: a retry not taken, a
 * fallback provider not tried, an error that still surfaces as the failure it
 * is. It is wrong where a false positive turns a recoverable failure into a
 * fatal one — `runToolLoop`'s escape hatch, where a provider whose message
 * merely says "request aborted" would end a chat turn the model could otherwise
 * have worked around. That call site reads this predicate instead.
 *
 * Narrowing costs the worker nothing: `LoggingEmbeddingAdapter.embed` runs
 * `assertJobNotStopped` on its way out, so a cancellation reaching a tool is
 * already a `StopRequestedError` by the time it is thrown, and every consumer
 * of the escape gates on `instanceof StopRequestedError` — narrower still.
 */
export function isCancellationError(error: unknown): boolean {
  return collectErrorDescriptors(error).some(
    (descriptor) =>
      descriptor.code?.toUpperCase() === "ABORT_ERR" ||
      descriptor.names.some((name) => CANCELLATION_ERROR_NAMES.has(name.toUpperCase()))
  );
}

/**
 * Exponential backoff, unless the provider named its own cooldown — then wait at
 * least that long. Retrying inside a quota window the provider already told us
 * about just spends another attempt on the same refusal.
 */
function recoverableRetryDelayMs(attempt: number, options: RecoverableRetryOptions, error: unknown): number {
  const baseDelay = Math.max(0, options.delayMs ?? DEFAULT_RECOVERABLE_DELAY_MS);
  const maxDelay = Math.max(baseDelay, options.maxDelayMs ?? DEFAULT_RECOVERABLE_MAX_DELAY_MS);
  const backoff = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));

  const requested = providerRetryAfterMs(error);
  if (requested === undefined) {
    return backoff;
  }
  // A little jitter, because parallel callers are throttled together and would
  // otherwise all come back at the same instant and throttle each other again.
  // Anything past the ceiling never reaches here — `isRecoverableNetworkError`
  // has already refused it.
  const jitter = Math.round(Math.random() * 1_000);
  return Math.max(backoff, requested + jitter);
}

/** The cooldown a provider asked for, in milliseconds, if any layer of the error carries one. */
export function providerRetryAfterMs(error: unknown): number | undefined {
  for (const descriptor of collectErrorDescriptors(error)) {
    if (descriptor.retryAfterMs !== undefined && descriptor.retryAfterMs > 0) {
      return descriptor.retryAfterMs;
    }
  }
  return undefined;
}

function collectErrorDescriptors(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0
): Array<{
  code?: string | undefined;
  status?: number | undefined;
  retryAfterMs?: number | undefined;
  /** `name` alone — the identity half of {@link messages}, for predicates that must not read prose. */
  names: string[];
  messages: string[];
}> {
  if (value === null || value === undefined || depth > 6) {
    return [];
  }

  if (typeof value !== "object") {
    return [{ names: [], messages: [String(value)] }];
  }

  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  const names = trimmedStrings([record.name]);
  const messages = [...names, ...trimmedStrings([record.message, record.type])];

  const descriptor = {
    code: typeof record.code === "string" ? record.code : undefined,
    status: numericField(record.status ?? record.statusCode),
    retryAfterMs: numericField(record.retryAfterMs),
    names,
    messages
  };

  const nested = [
    ...collectErrorDescriptors(record.cause, seen, depth + 1),
    ...collectErrorDescriptors(record.error, seen, depth + 1),
    ...collectErrorDescriptors(record.response, seen, depth + 1),
    ...collectErrorDescriptors(record.primary, seen, depth + 1),
    ...collectErrorDescriptors(record.fallback, seen, depth + 1),
    ...collectErrorArray(record.errors, seen, depth + 1)
  ];

  return [descriptor, ...nested];
}

function collectErrorArray(value: unknown, seen: WeakSet<object>, depth: number) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => collectErrorDescriptors(item, seen, depth));
}

function trimmedStrings(values: unknown[]): string[] {
  return values
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function numericField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
