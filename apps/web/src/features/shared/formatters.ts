import type { ProjectCost, TokenUsage } from "../../api.js";

const TOKEN_FORMATTER = new Intl.NumberFormat();
const USD_FORMATTER = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
const PRECISE_USD_FORMATTER = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4
});

export function formatProviderModel(value: { provider: string; model: string }): string {
  return `${value.provider}/${value.model}`;
}

export function formatTokenPair(tokens?: TokenUsage | null): string {
  const liveCalls = liveCallCount(tokens);
  return [
    `Input ${formatLiveTokenCount(tokens, "promptTokens")}`,
    `Output ${formatLiveTokenCount(tokens, "outputTokens")}`,
    liveCalls > 0 ? `${TOKEN_FORMATTER.format(liveCalls)} live` : ""
  ]
    .filter(Boolean)
    .join(" · ");
}

export function formatLiveTokenCount(tokens: TokenUsage | null | undefined, key: "promptTokens" | "outputTokens"): string {
  const provisional =
    key === "promptTokens" ? finiteNumber(tokens?.provisionalPromptTokens) : finiteNumber(tokens?.provisionalOutputTokens);
  const prefix = provisional > 0 ? "≈" : "";
  return `${prefix}${formatTokenCount(tokens?.[key])}`;
}

export function hasProviderDuration(value?: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function formatDuration(milliseconds?: number | null): string {
  const totalSeconds = Math.max(0, Math.round((milliseconds ?? 0) / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function formatProjectCost(cost?: ProjectCost | null): string {
  return `Text ${formatUsd(cost?.textUsd)} · Image ${formatUsd(cost?.imageUsd)}`;
}

export function formatUsd(value?: number | null): string {
  const safeValue = typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  if (safeValue > 0 && safeValue < 0.01) {
    return PRECISE_USD_FORMATTER.format(safeValue);
  }
  return USD_FORMATTER.format(safeValue);
}

export function formatTokenCount(value?: number | null): string {
  return TOKEN_FORMATTER.format(finiteNumber(value));
}

function liveCallCount(tokens?: TokenUsage | null): number {
  return finiteNumber(tokens?.inFlightCalls);
}

function finiteNumber(value?: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function formatJobTiming(startedAt?: string | null, finishedAt?: string | null): string {
  if (finishedAt) {
    return `Finished ${formatRelativeTime(finishedAt)}`;
  }
  if (startedAt) {
    return `Started ${formatRelativeTime(startedAt)}`;
  }
  return "";
}

export function formatRelativeTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const seconds = Math.max(0, Math.floor(delta / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function readError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Something went wrong.";
  }
  try {
    const parsed = JSON.parse(error.message) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error;
    }
  } catch {
    /* plain text error */
  }
  return error.message;
}

export function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

export function firstStringArray(...values: unknown[]): string[] {
  for (const value of values) {
    const strings = normalizeStringArray(value);
    if (strings.length > 0) {
      return strings;
    }
  }
  return [];
}

export function normalizeStringArray(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) {
      return [item.trim()];
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      const label = firstString(record.label, record.value, record.text, record.answer);
      return label ? [label] : [];
    }
    return [];
  });
}

export function labelCase(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function initialsForName(name: string): string {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return initials || "?";
}

export function asError(error: unknown, fallbackMessage = "Something went wrong."): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(fallbackMessage);
}
