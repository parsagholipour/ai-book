export type RecoverableRetryContext = {
  attempt: number;
  attempts: number;
  delayMs: number;
  error: unknown;
};

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

const RECOVERABLE_HTTP_STATUSES = new Set([408, 502, 503, 504]);

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

      const delayMs = recoverableRetryDelayMs(attempt, options);
      await options.onRetry?.({ attempt, attempts, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw new Error("Recoverable operation exhausted retries.");
}

export function isRecoverableNetworkError(error: unknown): boolean {
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

function recoverableRetryDelayMs(attempt: number, options: RecoverableRetryOptions): number {
  const baseDelay = Math.max(0, options.delayMs ?? DEFAULT_RECOVERABLE_DELAY_MS);
  const maxDelay = Math.max(baseDelay, options.maxDelayMs ?? DEFAULT_RECOVERABLE_MAX_DELAY_MS);
  return Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
}

function collectErrorDescriptors(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0
): Array<{ code?: string | undefined; status?: number | undefined; messages: string[] }> {
  if (value === null || value === undefined || depth > 6) {
    return [];
  }

  if (typeof value !== "object") {
    return [{ messages: [String(value)] }];
  }

  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  const messages = [record.name, record.message, record.type]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());

  const descriptor = {
    code: typeof record.code === "string" ? record.code : undefined,
    status: numericStatus(record.status ?? record.statusCode),
    messages
  };

  const nested = [
    ...collectErrorDescriptors(record.cause, seen, depth + 1),
    ...collectErrorDescriptors(record.error, seen, depth + 1),
    ...collectErrorDescriptors(record.response, seen, depth + 1),
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

function numericStatus(value: unknown): number | undefined {
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
