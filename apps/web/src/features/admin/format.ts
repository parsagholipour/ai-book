export function usd(value: number, options?: { compact?: boolean }): string {
  if (options?.compact && Math.abs(value) >= 10_000) {
    return `$${(value / 1000).toFixed(1)}k`;
  }
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Axis ticks and small money labels, where two decimals is just noise. */
export function usdShort(value: number): string {
  if (value === 0) return "$0";
  if (Math.abs(value) >= 1000) return `$${Math.round(value / 100) / 10}k`;
  if (Math.abs(value) >= 10) return `$${Math.round(value)}`;
  if (Math.abs(value) >= 1) return `$${value.toFixed(1)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * Money small enough that two decimals would print `$0.00`.
 *
 * One page of a book costs a few thousandths of a cent, so a per-model row on
 * the cost breakdown needs the extra digits or it reads as free. Anything a
 * dollar or over goes back through {@link usd} so the page keeps one money
 * format wherever the numbers are big enough for it.
 */
export function usdFine(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude === 0) return "$0";
  if (magnitude < 0.01) return `$${value.toFixed(5)}`;
  if (magnitude < 1) return `$${value.toFixed(3)}`;
  return usd(value);
}

export function count(value: number): string {
  return value.toLocaleString();
}

/** Token counts, where the digits past the first two are noise. */
export function compactCount(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000) return `${(value / 1_000_000).toFixed(magnitude >= 10_000_000 ? 0 : 1)}M`;
  if (magnitude >= 10_000) return `${Math.round(value / 1000)}k`;
  if (magnitude >= 1_000) return `${(value / 1000).toFixed(1)}k`;
  return count(value);
}

export function percent(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

export function shortDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export function dateTime(iso: string | null): string {
  if (!iso) return "—";
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? iso : when.toLocaleString();
}

export function relative(iso: string | null): string {
  if (!iso) return "never";
  const when = new Date(iso).getTime();
  if (Number.isNaN(when)) return iso;
  const days = Math.floor((Date.now() - when) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function duration(ms: number | null): string {
  if (ms === null || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  // Hours matter once this is asked about a book's worth of narration; "482m"
  // is technically the same answer and useless at a glance.
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
}

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}
