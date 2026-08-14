/** Bounded parallel map — the batch engine behind describe_image image_paths
 *  and paste auto mode. Port of pi-vision's mapWithConcurrency with abort support. */

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const cap = Math.max(1, Math.min(concurrency, items.length))
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) return
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index]!, index)
    }
  }
  const workers: Promise<void>[] = []
  for (let i = 0; i < cap; i++) workers.push(worker())
  await Promise.all(workers)
  return results
}
