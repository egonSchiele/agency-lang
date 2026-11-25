/** Runs `run` over the items, `parallel` at a time, starting them in order.
 *  Once `shouldStop()` is true no further item starts; the ones already
 *  running finish. Results come back in the items' order. */
export async function runPool<T, R>(
  items: T[],
  parallel: number,
  run: (item: T) => Promise<R>,
  shouldStop: () => boolean,
): Promise<{ item: T; result: R | "not started" }[]> {
  const results: (R | "not started")[] = items.map(() => "not started");
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && !shouldStop()) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, worker));
  return items.map((item, index) => ({ item, result: results[index] }));
}
