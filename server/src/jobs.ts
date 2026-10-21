/** Small helpers for work that outlives a tool call. Alexa+ gives a tool 500 ms; the airline needs seconds. */

/** Resolves with the value when `p` settles within `ms`, or `{ done: false }` and leaves `p` running. */
export async function within<T>(p: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ done: false }>((ok) => {
    timer = setTimeout(() => ok({ done: false }), ms);
  });
  try {
    return await Promise.race([p.then((value) => ({ done: true as const, value })), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `fn` over `items` with at most `cap` in flight, in input order of start. Rejections propagate after in-flight work settles. */
export async function mapLimit<T, R>(items: readonly T[], cap: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (!failure) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (error) {
        failure = { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(cap, items.length)) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  return out;
}
