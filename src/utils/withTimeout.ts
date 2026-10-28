// Bound SDK calls that do not support abort; always clear the deadline timer.
// The error is built when the deadline fires (pass a factory), so it reflects
// the state at timeout time, e.g. the network then current.
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  error: Error | (() => Error)
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(typeof error === 'function' ? error() : error),
          ms
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
