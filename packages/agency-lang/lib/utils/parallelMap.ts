/**
 * Runs `fn` over `items` with at most `parallel` calls in flight. Results
 * come back in item order, whatever order the calls finish in. `parallel`
 * is clamped to at least one worker; a non-finite value means one.
 */
export async function mapInParallel<T, R>(
  items: readonly T[],
  parallel: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const workers = Math.min(
    Number.isFinite(parallel) ? Math.max(1, Math.floor(parallel)) : 1,
    items.length,
  );
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
