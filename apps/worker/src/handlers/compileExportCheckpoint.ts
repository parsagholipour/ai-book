/** Checkpoints are part of the leased finalization operation, never a global cache. */
export type ExportChecks = Partial<Record<"inventory" | "coverage", { fingerprint: string; result?: unknown }>>;

export async function runExportCheckpoint<T>(options: {
  slot: keyof ExportChecks; fingerprint: string;
  read: () => ExportChecks | undefined;
  mutate: (change: (checks: ExportChecks) => void) => Promise<void>;
  parse: (value: unknown) => T | undefined;
  compute: () => Promise<T>; interrupted: () => T;
  assertActive: () => Promise<void>;
}): Promise<T> {
  await options.assertActive();
  const saved = options.read()?.[options.slot];
  if (saved?.fingerprint === options.fingerprint) {
    // A claimed but interrupted call cannot silently replenish provider spend.
    return options.parse(saved.result) ?? options.interrupted();
  }
  let claimed = false;
  await options.mutate((checks) => {
    if (checks[options.slot]?.fingerprint === options.fingerprint) return;
    checks[options.slot] = { fingerprint: options.fingerprint }; claimed = true;
  });
  if (!claimed) return options.parse(options.read()?.[options.slot]?.result) ?? options.interrupted();
  const result = await options.compute();
  await options.assertActive();
  await options.mutate((checks) => {
    if (checks[options.slot]?.fingerprint !== options.fingerprint) throw new Error("Export check was superseded.");
    checks[options.slot] = { fingerprint: options.fingerprint, result };
  });
  return result;
}
