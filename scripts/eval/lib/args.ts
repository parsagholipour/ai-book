/** `--key value`, `--key=value` and bare `--flag` parsing, shared by every eval command. */
export type Args = { _: string[]; get(key: string): string | undefined; num(key: string, fallback: number): number; list(key: string): string[]; flag(key: string): boolean };

export function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0) {
      values.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(arg.slice(2), next);
      i += 1;
    } else {
      values.set(arg.slice(2), "true");
    }
  }
  return {
    _: positional,
    get: (key) => values.get(key),
    num: (key, fallback) => {
      const value = values.get(key);
      const parsed = value === undefined ? Number.NaN : Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    },
    list: (key) => (values.get(key) ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    flag: (key) => values.get(key) === "true"
  };
}

/** Run `items` through `worker` with at most `limit` in flight; results keep input order. */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(lanes);
  return out;
}
