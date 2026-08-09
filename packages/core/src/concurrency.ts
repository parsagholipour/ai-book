/**
 * Order-preserving bounded-parallel map for independent async work (chapter
 * briefs, page-map chunks). Workers stop picking up new items after the first
 * failure: a rejected Promise.all cannot cancel siblings, and model calls
 * nobody will keep spend the same provider budget the retry needs — the same
 * principle narration's chunk pool follows.
 */
export async function mapWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  concurrency: number,
  map: (item: TItem, index: number) => Promise<TResult>
): Promise<TResult[]> {
  const results = Array.from({ length: items.length }) as TResult[];
  let cursor = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await map(items[index]!, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return results;
}
